// server.js
import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import mongoose from 'mongoose';
import { Server as SocketIO } from 'socket.io';
import { fileURLToPath } from 'url';
import morgan from 'morgan';
import session from 'express-session';
import bcrypt from 'bcrypt';
import QRCode from 'qrcode';

/* ---- Auth & Routers ---- */
import passport from './src/auth/passport.js';
import driverAuthRouter from './src/routes/driverAuth.js';
import adminRouter from './src/routes/admin.js';
import adminWaRouter from './src/routes/admin-wa.js';

/* ---- Models ---- */
import Ride from './src/models/Ride.js';
import Driver from './src/models/Driver.js';
import Rider from './src/models/Rider.js';
import Admin from './src/models/Admin.js';
import Activity from './src/models/Activity.js';

/* ---- App routes ---- */
import finishRouter from './src/routes/finish.js';
import payfastNotifyRouter from './src/routes/payfastNotify.js';
import partnerRouter from './src/routes/partner.js';
import payfastRouter from './src/routes/payfast.js';
import payfastGatewayRouter from './src/routes/payfastGateway.js';
import inviteRiderRouter from './src/routes/inviteRider.js';
import riderRouter from './src/routes/rider.js'; // 🆕 NEW

/* ---- Bots (Telegram) ---- */
import { initRiderBot, riderEvents, riderBot as RB } from './src/bots/riderBot.js';
import { initDriverBot, driverEvents, driverBot as DB } from './src/bots/driverBot.js';

/* ---- Bots (WhatsApp: Riders) ---- */
import {
  initWhatsappBot,
  waitForQrDataUrl,
  isWhatsAppConnected,
  getConnectionStatus,
  sendWhatsAppMessage,
  resetWhatsAppSession,
} from './src/bots/whatsappBot.js';

/* ---- Bots (WhatsApp: Drivers) ---- */
import {
  initWhatsappDriverBot,
  waitForDriverQrDataUrl,
  isWhatsAppDriverConnected,
  getDriverConnectionStatus,
  resetWhatsAppDriverSession,
  waNotifyDriverNewRequest,
  sendWhatsAppDriverMessage
} from './src/bots/whatsappDriverBot.js';

/* ---- Services ---- */
import { assignNearestDriver, setEstimateOnRide, hasNumericChatId } from './src/services/assignment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, { cors: { origin: '*' } });
app.set('io', io);
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const TRACK_LINK_TTL_HOURS = Number(process.env.TRACK_LINK_TTL_HOURS || 24);

/* ---------------- Mongo ---------------- */
await mongoose.connect(process.env.MONGODB_URI);
console.log('✅ MongoDB connected');

/* ---------------- App setup ---------------- */
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public'))); // serves /wa-qr.png and /track.html
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ---------------- Simple QR helper ---------------- */
// GET /qr.png            -> QR for PUBLIC_URL
// GET /qr.png?u=/promo   -> QR for PUBLIC_URL + "/promo"
// GET /qr.png?u=https://vayaride.com/anything (same-domain only)
app.get('/qr.png', async (req, res) => {
  try {
    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    let target = base;
    const u = req.query.u;

    if (typeof u === 'string' && u.startsWith('/')) target = base + u;
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) {
      try {
        const parsed = new URL(u);
        if (parsed.hostname.endsWith('vayaride.com')) target = parsed.toString();
      } catch {}
    }

    res.type('png');
    await QRCode.toFileStream(res, target, { width: 220, margin: 1 });
  } catch {
    res.status(500).send('QR error');
  }
});

app.use('/', inviteRiderRouter);
app.use('/', adminWaRouter);   // exposes /qrcode, /wa/status, /admin/riders/wa

app.use('/api/rider', riderRouter); // 🆕 NEW: mount rider API (profile + referral + update)

/* ---------------- Routes that need bodies first ---------------- */
app.use('/api/payfast', payfastNotifyRouter);   // /api/payfast/notify (ITN)
app.use('/api/payfast', payfastGatewayRouter);  // /api/payfast/gateway (auto-post to PayFast)
app.use('/api/partner', partnerRouter);         // /api/partner/upgrade/payfast (landing page)
app.use('/pay', payfastRouter);                 // /pay/:rideId → redirect to landing

app.use(finishRouter);

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'devsecret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 12 * 60 * 60 * 1000 },
  })
);
app.use(passport.initialize());
app.use(passport.session());
app.use((req, res, next) => { res.locals.user = req.user || null; next(); });

/* ---------------- Seed Admin (optional) ---------------- */
async function ensureSeedAdmin() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.warn('⚠️ Skipping admin seed: ADMIN_EMAIL/ADMIN_PASSWORD not set');
    return;
  }
  const existing = await Admin.findOne({ email: ADMIN_EMAIL });
  if (existing) return;
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await Admin.create({ name: ADMIN_NAME || 'Super Admin', email: ADMIN_EMAIL, passwordHash });
  console.log('🛡️ Seeded admin:', ADMIN_EMAIL);
}
await ensureSeedAdmin();

/* ---------------- Init Bots (AFTER middleware) ---------------- */
initWhatsappBot();            // WA for Riders (existing)
initWhatsappDriverBot();      // WA for Drivers (new)

const riderBot = initRiderBot({ io });
const driverBot = initDriverBot({ io });
console.log('🤖 Rider bot initialized');
console.log('🚗 Driver bot initialized');

/* ---------------- Helper: log + broadcast to admin ---------------- */
async function logActivity({ rideId, type, message, actorType = 'system', actorId = null, meta = {} }) {
  try {
    const a = await Activity.create({ rideId, type, message, actorType, actorId, meta });
    io.emit('admin:activity', {
      _id: String(a._id),
      rideId: String(rideId),
      type,
      message,
      actorType,
      actorId,
      createdAt: a.createdAt,
      meta
    });
  } catch (e) {
    console.warn('logActivity failed:', e?.message || e);
  }
}

/* ---------------- Contact helpers (Name & Phone) ---------------- */
function jidToPhone(jid) {
  if (!jid) return null;
  const core = String(jid).split('@')[0] || '';
  const digits = core.replace(/[^\d+]/g, '');
  if (!digits) return null;
  return digits.startsWith('+') ? digits : `+${digits}`;
}
function normalizePhone(x) {
  if (!x) return null;
  const digits = String(x).replace(/[^\d+]/g, '');
  if (!digits) return null;
  return digits.startsWith('+') ? digits : `+${digits}`;
}
function pickPhoneLike(obj = {}) {
  return (
    obj.phone ||
    obj.phoneNumber ||
    obj.mobile ||
    obj.msisdn ||
    (obj.waJid ? jidToPhone(obj.waJid) : null) ||
    null
  );
}

/** ✅ Backfill rider.phone/msisdn if we can infer it (one-time fix for older riders) */
async function backfillRiderPhoneIfMissing({ rider, ride }) {
  try {
    if (!rider?._id) return null;
    const existing = pickPhoneLike(rider);
    if (existing) return existing;

    // Try from ride first (explicit fields), then from JIDs
    let candidate =
      normalizePhone(ride?.riderPhone || ride?.riderPhoneNumber || ride?.riderMsisdn || ride?.riderMobile) ||
      (ride?.riderWaJid ? jidToPhone(ride.riderWaJid) : null) ||
      (rider.waJid ? jidToPhone(rider.waJid) : null);

    if (!candidate) return null;

    await Rider.updateOne(
      { _id: rider._id },
      { $set: { phone: candidate, msisdn: candidate } }
    );

    // Log once so you can see it happening in the admin feed
    try {
      await logActivity({
        rideId: ride?._id || null,
        type: 'datafix',
        message: `Backfilled rider phone ${candidate}`,
        actorType: 'system',
        actorId: String(rider._id),
        meta: { riderId: String(rider._id) }
      });
    } catch {}

    return candidate;
  } catch {
    return null;
  }
}

async function resolveRiderContactFromRide(ride) {
  if (!ride) return { name: 'Rider', phone: null, doc: null };

  let rider = null;
  const ors = [];
  if (ride.riderChatId != null) ors.push({ chatId: Number(ride.riderChatId) }, { chatId: String(ride.riderChatId) });
  if (ride.riderWaJid) ors.push({ waJid: ride.riderWaJid });
  if (ors.length) rider = await Rider.findOne({ $or: ors }).lean();

  const name = rider?.name || 'Rider';

  // prefer phone from Rider doc
  let phone = pickPhoneLike(rider);

  // fallbacks from Ride fields if still missing
  if (!phone) phone = normalizePhone(ride.riderPhone || ride.riderPhoneNumber || ride.riderMsisdn || ride.riderMobile);
  if (!phone && ride.riderWaJid) phone = jidToPhone(ride.riderWaJid);

  // ✅ If we found a phone but Rider is missing one, backfill it for next time
  if (rider && !pickPhoneLike(rider) && phone) {
    try { await Rider.updateOne({ _id: rider._id }, { $set: { phone, msisdn: phone } }); } catch {}
  }

  // Also try a best-effort backfill if we couldn't resolve above (logs a datafix entry)
  if (rider && !phone) {
    const fixed = await backfillRiderPhoneIfMissing({ rider, ride });
    if (fixed) phone = fixed;
  }

  return { name, phone, doc: rider };
}

async function resolveDriverContact({ driverId, driverChatId } = {}) {
  let drv = null;
  if (driverId) drv = await Driver.findById(driverId).lean();
  if (!drv && driverChatId != null) drv = await Driver.findOne({ chatId: Number(driverChatId) }).lean();
  const name = drv?.name || drv?.email || 'Driver';
  const phone = (
    drv?.phone || drv?.phoneNumber || drv?.mobile || drv?.msisdn ||
    (drv?.waJid ? jidToPhone(drv.waJid) : null)
  ) || null;
  return { name, phone, doc: drv };
}

/* ---------------- Basic pages / auth ---------------- */
app.get('/', (req, res) => {
  const publicUrl = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  res.render('landing', { title: 'VayaRide', publicUrl });
});

app.use('/driver', driverAuthRouter);
app.use('/admin', adminRouter);

/* ---------------- Rider dashboard API ---------------- */
app.get('/api/rider-by-token/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const pin = req.query.pin;
    const rider = await Rider.findOne({ dashboardToken: token }).lean();
    if (!rider) return res.status(404).json({ error: 'Rider not found' });

    const now = new Date();
    if (!rider.dashboardTokenExpiry || rider.dashboardPin !== pin || now > new Date(rider.dashboardTokenExpiry)) {
      return res.status(401).json({ error: 'Access denied. PIN or token expired' });
    }

    const orFilters = [];
    const chatIdNum = Number(rider.chatId);
    if (Number.isFinite(chatIdNum)) orFilters.push({ riderChatId: { $in: [chatIdNum, String(rider.chatId)] } });
    if (rider.waJid) orFilters.push({ riderWaJid: rider.waJid });
    const rideMatch = orFilters.length ? { $or: orFilters } : { _id: null };

    const [lastPaid, tripsCompleted, starsAgg] = await Promise.all([
      Ride.findOne({ ...rideMatch, $or: [{ paymentStatus: 'paid' }, { status: 'completed' }] })
          .sort({ paidAt: -1, completedAt: -1, updatedAt: -1, createdAt: -1 }).lean(),
      Ride.countDocuments({ ...rideMatch, status: 'completed' }),
      Ride.aggregate([
        { $match: { ...rideMatch, riderRating: { $gte: 1 } } },
        { $group: { _id: null, count: { $sum: 1 }, avg: { $avg: '$riderRating' } } }
      ])
    ]);

    const lastPayment = lastPaid
      ? {
          rideId: String(lastPaid._id),
          amount: Number(lastPaid.finalAmount ?? lastPaid.estimate ?? 0) || 0,
          method: lastPaid.paymentMethod || null,
          at: lastPaid.paidAt || lastPaid.completedAt || lastPaid.updatedAt || lastPaid.createdAt || null
        }
      : null;

    const riderStars = starsAgg && starsAgg.length
      ? { avg: Number(starsAgg[0].avg.toFixed(2)), count: starsAgg[0].count }
      : { avg: null, count: 0 };

    // Try to backfill a missing phone from the rider's JID even here (no ride context)
    let phoneOut = pickPhoneLike(rider) || '';
    if (!phoneOut && rider.waJid) {
      const fromJid = jidToPhone(rider.waJid);
      if (fromJid) {
        try { await Rider.updateOne({ _id: rider._id }, { $set: { phone: fromJid, msisdn: fromJid } }); } catch {}
        phoneOut = fromJid;
      }
    }

    res.set('Cache-Control', 'no-store');
    return res.json({
      platform: rider.platform || null,
      chatId: Number.isFinite(chatIdNum) ? chatIdNum : null,
      waJid: rider.waJid || null,
      name: rider.name || '',
      email: rider.email || '',
      phone: phoneOut,
      credit: rider.credit ?? 0,
      trips: tripsCompleted,
      lastPayment,
      riderStars
    });
  } catch (e) {
    console.error('rider-by-token error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---- WhatsApp (Rider) QR/Status helpers ---- */
app.post('/wa/reset', async (req, res) => {
  await resetWhatsAppSession();
  res.json({ ok: true, message: 'WhatsApp session reset. Open /qrcode to scan again.' });
});

app.get('/qrcode', async (req, res) => {
  if (isWhatsAppConnected()) return res.send('<h2>✅ WhatsApp is connected.</h2>');
  try {
    const dataUrl = await waitForQrDataUrl(25000);
    res.send(`<div style="font-family:system-ui;display:grid;place-items:center;gap:12px">
      <h3>Scan to connect WhatsApp</h3>
      <img src="${dataUrl}" style="width:320px;height:320px;image-rendering:pixelated;border:8px solid #eee;border-radius:12px" />
      <p>If it stalls, refresh or try <code>/wa/reset</code>.</p>
    </div>`);
  } catch {
    const pngPath = path.join(__dirname, 'public/wa-qr.png');
    const fallback = fs.existsSync(pngPath)
      ? `<img src="/wa-qr.png" style="width:320px;height:320px;image-rendering:pixelated;border:8px solid #eee;border-radius:12px" />`
      : '<em>No QR yet. Try again shortly.</em>';
    res.send(`<div style="font-family:system-ui;display:grid;place-items:center;gap:12px">
      <h3>QR not ready</h3>${fallback}
      <p>Or call <a href="/wa/reset">/wa/reset</a> then refresh.</p>
    </div>`);
  }
});

app.get('/api/whatsapp/status', (req, res) => {
  const status = getConnectionStatus();
  res.json({ status, connected: isWhatsAppConnected() });
});

/* ---- WhatsApp (Driver) QR/Status helpers ---- */
async function doResetDriverWA(res) {
  try {
    await resetWhatsAppDriverSession();
    res.json({ ok: true, message: 'Driver WA session reset. Open /driver-qrcode to scan again.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'reset failed' });
  }
}
app.post('/driver-wa/reset', async (req, res) => { await doResetDriverWA(res); });
// allow GET as well (easier while testing)
app.get('/driver-wa/reset', async (req, res) => { await doResetDriverWA(res); });

app.get('/driver-qrcode', async (req, res) => {
  if (isWhatsAppDriverConnected()) return res.send('<h2>✅ Driver WhatsApp is connected.</h2>');
  try {
    const dataUrl = await waitForDriverQrDataUrl(25000);
    res.send(`<div style="font-family:system-ui;display:grid;place-items:center;gap:12px">
      <h3>Scan to connect <em>Driver</em> WhatsApp</h3>
      <img src="${dataUrl}" style="width:320px;height:320px;image-rendering:pixelated;border:8px solid #eee;border-radius:12px" />
      <p>If it stalls, refresh or visit <code>/driver-wa/reset</code>.</p>
    </div>`);
  } catch (e) {
    res.status(500).send('Driver QR not ready: ' + (e?.message || e));
  }
});

// Alias QR page (auto-refresh)
app.get('/driver-wa-qr', async (req, res) => {
  if (isWhatsAppDriverConnected()) return res.send('<h2>✅ Driver WhatsApp is connected.</h2>');
  try {
    const dataUrl = await waitForDriverQrDataUrl(25000);
    res.type('html').send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Driver WhatsApp QR</title>
          <style>
            body{font-family:sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#111;color:#eee}
            .wrap{max-width:520px;text-align:center}
            img{width:100%;height:auto;background:#fff;padding:12px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
            .hint{opacity:.75;margin-top:12px}
          </style>
        </head>
        <body>
          <div class="wrap">
            <h2>Scan to sign in (Driver WA)</h2>
            <img src="${dataUrl}" alt="WhatsApp QR" />
            <div class="hint">Open WhatsApp → Linked devices → Link a device.</div>
            <script>setTimeout(() => location.reload(), 20000);</script>
          </div>
        </body>
      </html>
    `);
  } catch (e) {
    res.type('html').send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Driver WhatsApp QR</title>
          <style>
            body{font-family:sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#111;color:#eee}
            .wrap{max-width:520px;text-align:center}
          </style>
        </head>
        <body>
          <div class="wrap">
            <h2>Preparing QR…</h2>
            <p>Please keep this page open.</p>
            <script>setTimeout(() => location.reload(), 3000);</script>
          </div>
        </body>
      </html>
    `);
  }
});

// Existing status endpoint
app.get('/driver-wa/status', (req, res) => {
  res.json({ connected: isWhatsAppDriverConnected(), state: getDriverConnectionStatus() });
});

// Alias status for API-style path
app.get('/api/wa-driver/status', (req, res) => {
  res.json({ status: getDriverConnectionStatus(), connected: isWhatsAppDriverConnected() });
});

/* ---------------- Telegram webhooks if used ---------------- */
app.post('/rider-bot', (req, res) => { riderBot.processUpdate?.(req.body); res.sendStatus(200); });
app.post('/driver-bot', (req, res) => { driverBot.processUpdate?.(req.body); res.sendStatus(200); });

/* Map/track page (back-compat) */
app.get('/map/:rideId', (req, res) => {
  const url = `/track.html?rideId=${encodeURIComponent(req.params.rideId)}`;
  res.redirect(302, url);
});

/* ---------------- Tracking APIs ---------------- */
function isRideLinkExpired(ride) {
  if (['cancelled', 'completed', 'payment_pending'].includes(ride.status)) return { expired: true, reason: ride.status };
  if (TRACK_LINK_TTL_HOURS > 0) {
    const made = new Date(ride.createdAt || Date.now());
    const expiresAt = new Date(made.getTime() + TRACK_LINK_TTL_HOURS * 3600 * 1000);
    if (Date.now() > +expiresAt) return { expired: true, reason: 'ttl', expiresAt };
  }
  return { expired: false, reason: null };
}

app.get('/api/ride/:rideId', async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.rideId).lean();
    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    const exp = isRideLinkExpired(ride);
    if (exp.expired) {
      return res.status(410).json({
        error: 'expired',
        status: ride.status,
        reason: exp.reason,
        createdAt: ride.createdAt,
        cancelledAt: ride.cancelledAt || null,
        completedAt: ride.completedAt || null,
        expiresAt: exp.expiresAt || null
      });
    }

    let driverChatId = null;
    if (ride.driverId) {
      const drv = await Driver.findById(ride.driverId).lean();
      if (drv && typeof drv.chatId === 'number') driverChatId = drv.chatId;
    }

    const riderContact = await resolveRiderContactFromRide(ride);
    const driverContact = await resolveDriverContact({ driverId: ride.driverId, driverChatId });

    res.json({
      pickup: ride.pickup,
      destination: ride.destination,
      status: ride.status || 'pending',
      driverChatId,
      pickedAt: ride.pickedAt || ride.startedAt || null,
      completedAt: ride.completedAt || null,
      createdAt: ride.createdAt,
      rider: { name: riderContact.name, phone: riderContact.phone || null },
      driver: { name: driverContact.name, phone: driverContact.phone || null }
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/driver-last-loc/:chatId', async (req, res) => {
  try {
    const chatId = Number(req.params.chatId);
    if (Number.isNaN(chatId)) return res.status(400).json({});
    const driver = await Driver.findOne({ chatId }).lean();
    if (!driver || !driver.location) {
      console.log(`ℹ️ No last location for driver chatId=${chatId}`);
      return res.json({});
    }
    console.log(`↩️ API last loc chatId=${chatId} lat=${driver.location.lat} lng=${driver.location.lng}`);
    res.json(driver.location);
  } catch {
    res.json({});
  }
});

/* ---------------- Referral short link: /i/d/:code -> /driver/register?ref=CODE ---------------- */
app.get('/i/d/:code', async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();

  // fire-and-forget: count the click if the code exists
  try {
    await Driver.updateOne(
      { referralCode: code },
      { $inc: { 'referralStats.clicks': 1 } }
    );
  } catch (e) {
    console.warn('ref click bump failed:', e?.message || e);
  }

  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return res.redirect(302, `${base}/driver/register?ref=${encodeURIComponent(code)}`);
});

/* ---------------- Referral short link: /i/r/:code -> /register?ref=CODE ---------------- */
app.get('/i/r/:code', async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();

  // fire-and-forget click count
  try {
    await Rider.updateOne(
      { referralCode: code },
      { $inc: { 'referralStats.clicks': 1 } }
    );
  } catch (e) {
    console.warn('rider ref click bump failed:', e?.message || e);
  }

  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  // send them to your rider registration page with ?ref=CODE
  return res.redirect(302, `${base}/register?ref=${encodeURIComponent(code)}`);
});

/* ---------------- Rider referral admin/API helpers ---------------- */
app.post('/api/rider/referral/ensure', async (req, res) => {
  try {
    const { riderId } = req.body || {};
    if (!riderId) return res.status(400).json({ error: 'riderId required' });
    const code = await Rider.ensureReferralCode(riderId);
    return res.json({ ok: true, code });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'ensure failed' });
  }
});

app.post('/api/rider/referral/mark-shared', async (req, res) => {
  try {
    const { riderId } = req.body || {};
    if (!riderId) return res.status(400).json({ error: 'riderId required' });
    await Rider.updateOne(
      { _id: riderId },
      { $set: { 'referralStats.lastSharedAt': new Date() } }
    );
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'mark failed' });
  }
});

/* -------- live driver tickers (per driver) -------- */
const lastLocByDriver = new Map();     // chatId -> { lat, lng, ts }
const tickerByDriver = new Map();      // chatId -> intervalId
function stopDriverTicker(chatId) {
  const id = tickerByDriver.get(Number(chatId));
  if (id) {
    clearInterval(id);
    tickerByDriver.delete(Number(chatId));
  }
  lastLocByDriver.delete(Number(chatId));
}

/* ---------------- utilities ---------------- */
function toRad(x){ return (x * Math.PI) / 180; }
function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(Math.max(0, s)));
}

/* ⭐⭐ PATH CAPTURE (driver tracking) — minimal, write-capped */
const lastPathByRide = new Map(); // rideId -> { lat, lng, ts }
async function appendPathPoint(rideId, lat, lng, label = '') {
  try {
    const key = String(rideId);
    const now = Date.now();
    const prev = lastPathByRide.get(key);
    const fastEnough = !prev || (now - prev.ts) >= 2500; // 2.5s min
    const farEnough  = !prev || haversineMeters(prev, { lat, lng }) >= 8; // 8m min

    if (!fastEnough && !farEnough) return;

    await Ride.updateOne({ _id: rideId }, { $push: { path: { lat, lng, ts: new Date() } } });
    lastPathByRide.set(key, { lat, lng, ts: now });

    if (label) console.log(`🧭 PATH ${label} ride=${key} lat=${lat.toFixed(6)} lng=${lng.toFixed(6)}`);
  } catch (e) {
    console.warn('appendPathPoint failed:', e?.message || e);
  }
}

/* ---------------- Live driver broadcasts (per-driver + per-ride) ---------------- */
driverEvents.on('driver:location', async ({ chatId, location }) => {
  try {
    const cId = Number(chatId);
    const { lat, lng } = location || {};
    if (typeof lat !== 'number' || typeof lng !== 'number') return;

    lastLocByDriver.set(cId, { lat, lng, ts: Date.now() });
    io.emit(`driver:${cId}:location`, { lat, lng });

    // find active ride for this driver
    const drv = await Driver.findOne({ chatId: cId }).select('_id').lean();
    if (drv?._id) {
      const ride = await Ride.findOne({
        driverId: drv._id,
        status: { $in: ['accepted', 'enroute'] }
      }).sort({ updatedAt: -1 }).lean();

      if (ride?._id) {
        io.emit(`ride:${ride._id}:driverLocation`, { lat, lng });

        appendPathPoint(ride._id, lat, lng);

        // ---------- arrival detection ----------
        if (ride.status === 'accepted' && ride.pickup?.lat && ride.pickup?.lng) {
          const dMeters = haversineMeters({ lat, lng }, ride.pickup);
          if (dMeters <= 35) {
            const now = new Date();
            const lastEmitTs = ride._lastArriveEmitAt ? new Date(ride._lastArriveEmitAt).getTime() : 0;
            const COOLDOWN_MS = 20 * 1000;
            const cooled = now.getTime() - lastEmitTs > COOLDOWN_MS;

            const result = await Ride.updateOne(
              { _id: ride._id, arrivedNotified: { $ne: true } },
              { $set: { arrivedNotified: true, arrivedAt: now, _lastArriveEmitAt: now } }
            );
            const firstTime = result.modifiedCount > 0;

            if (firstTime || (ride.arrivedNotified && cooled)) {
              try {
                driverEvents.emit('ride:arrived', { driverId: chatId, rideId: String(ride._id), firstTime });
                io.emit(`ride:${ride._id}:arrived`);
              } finally {
                if (!firstTime) {
                  await Ride.updateOne({ _id: ride._id }, { $set: { _lastArriveEmitAt: now } });
                }
              }
            }
          }
        }
      }
    }

    // heartbeat rebroadcast loop
    if (!tickerByDriver.has(cId)) {
      const id = setInterval(async () => {
        const last = lastLocByDriver.get(cId);
        if (!last) return;

        const staleMs = Date.now() - last.ts;
        if (staleMs > 2 * 60 * 1000) { stopDriverTicker(cId); return; }

        io.emit(`driver:${cId}:location`, { lat: last.lat, lng: last.lng });

        try {
          const drv2 = await Driver.findOne({ chatId: cId }).select('_id').lean();
          if (!drv2?._id) return;
          const active = await Ride.findOne({
            driverId: drv2._id,
            status: { $in: ['accepted', 'enroute'] }
          }).sort({ updatedAt: -1 }).select('_id').lean();
          if (active?._id) io.emit(`ride:${active._id}:driverLocation`, { lat: last.lat, lng: last.lng });
        } catch {}
      }, 1000);
      tickerByDriver.set(cId, id);
    }
  } catch (e) {
    console.warn('driver:location broadcast failed:', e?.message || e);
  }
});

/* ---------------- BOOKING DISPATCH PIPELINE ---------------- */
async function dispatchToNearestDriver({ rideId, excludeDriverIds = [] }) {
  console.log('[dispatch] called with rideId=', rideId);
  const ride = await Ride.findById(rideId);
  console.log('[dispatch] ride status=', ride?.status, 'pickup=', ride?.pickup, 'vehicleType=', ride?.vehicleType);

  if (!ride || ride.status !== 'pending') return;

  const chosen = await assignNearestDriver(ride.pickup, {
    vehicleType: ride.vehicleType || null,
    exclude: excludeDriverIds
  });
  console.log('[dispatch] chosen driver=', chosen && { _id: chosen._id, chatId: chosen.chatId, isAvailable: chosen.isAvailable, name: chosen.name });

  if (!chosen || !hasNumericChatId(chosen)) {
    try { if (ride.riderChatId) await RB.sendMessage(ride.riderChatId, '😕 No drivers are available right now. We will keep trying shortly.'); } catch {}
    try { if (ride.riderWaJid)  await sendWhatsAppMessage(ride.riderWaJid, '😕 No drivers are available right now. We will keep trying shortly.'); } catch {}
    return;
  }

  try { await setEstimateOnRide(ride._id, chosen.location || null); } catch {}

  await logActivity({
    rideId: ride._id,
    type: 'assigned',
    actorType: 'system',
    message: `Assigned to driver ${chosen.name || chosen.email || chosen.chatId || chosen._id}`,
    meta: { driverId: String(chosen._id), driverChatId: chosen.chatId ?? null }
  });

  // include rider contact info (phone fallback-aware + backfill if missing)
  const riderContact = await resolveRiderContactFromRide(ride);
  const riderLine = `• Rider: ${riderContact.name}${riderContact.phone ? ` (${riderContact.phone})` : ''}`;

  const toMap = ({ lat, lng }) => `https://maps.google.com/?q=${lat},${lng}`;
  const text =
    `🚗 <b>New Ride Request</b>\n\n` +
    `• Vehicle: <b>${(ride.vehicleType || 'normal').toUpperCase()}</b>\n` +
    (ride.estimate ? `• Estimate: <b>R${ride.estimate}</b>\n` : '') +
    `${riderLine}\n` +
    `• Pickup: <a href="${toMap(ride.pickup)}">Open Map</a>\n` +
    `• Drop:   <a href="${toMap(ride.destination || ride.pickup)}">Open Map</a>\n\n` +
    `Accept to proceed.`;

  // Telegram DM
  try {
    await DB.sendMessage(chosen.chatId, text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Accept', callback_data: `accept_${ride._id}` },
          { text: '🙈 Ignore', callback_data: `ignore_${ride._id}` }
        ]]
      }
    });
  } catch (e) {
    console.warn('Failed to DM driver request (Telegram):', e?.message || e);
  }

  // WhatsApp DM to the driver (NEW)
  try {
    await waNotifyDriverNewRequest({ driver: chosen, ride, riderContact });
  } catch (e) {
    console.warn('Failed to DM driver request (WhatsApp):', e?.message || e);
  }
}

riderEvents.on('booking:new', async ({ rideId }) => {
  try {
    if (!rideId) return;
    await logActivity({ rideId, type: 'request', actorType: 'rider', message: 'Rider requested a trip' });
    await dispatchToNearestDriver({ rideId });
  } catch (e) {
    console.error('booking:new handler error:', e?.message || e);
  }
});

driverEvents.on('ride:ignored', async ({ previousDriverId, ride }) => {
  try {
    if (!ride || !ride._id) return;
    await logActivity({
      rideId: ride._id,
      type: 'ignored',
      actorType: 'driver',
      actorId: String(previousDriverId),
      message: `Driver ${previousDriverId} ignored the ride`
    });
    const prevDriver = await Driver.findOne({ chatId: Number(previousDriverId) }).lean();
    const excludeIds = prevDriver ? [prevDriver._id] : [];
    await dispatchToNearestDriver({ rideId: String(ride._id), excludeDriverIds: excludeIds });
  } catch (e) {
    console.error('ride:ignored handler error:', e?.message || e);
  }
});

/* ➕ When the driver accepts, send links (now with counterpart contacts) */
driverEvents.on('ride:accepted', async ({ driverId, rideId }) => {
  try {
    const ride = await Ride.findById(rideId);
    if (!ride) return;

    if (!ride.driverId) {
      const drv = await Driver.findOne({ chatId: Number(driverId) });
      if (drv) { ride.driverId = drv._id; await ride.save(); }
    }

    await logActivity({
      rideId,
      type: 'accepted',
      actorType: 'driver',
      actorId: String(driverId),
      message: `Driver ${driverId} accepted the ride`
    });

    const base = `${process.env.PUBLIC_URL}/track.html?rideId=${encodeURIComponent(rideId)}`;
    const riderLink  = base;
    const driverLink = `${base}&as=driver&driverChatId=${encodeURIComponent(driverId)}`;

    // Resolve both contacts (phone fallback-aware)
    const riderContact = await resolveRiderContactFromRide(ride);
    const driverContact = await resolveDriverContact({ driverId: ride.driverId, driverChatId: driverId });

    const riderInfoLine =
      `👤 <b>Driver:</b> ${driverContact.name}` +
      (driverContact.phone ? ` (${driverContact.phone})` : '');

    const driverInfoLine =
      `👤 <b>Rider:</b> ${riderContact.name}` +
      (riderContact.phone ? ` (${riderContact.phone})` : '');

    try {
      if (ride.riderChatId)
        await RB.sendMessage(
          ride.riderChatId,
          `🚗 Your ride is on the way.\n${riderInfoLine}\n\nTrack here:\n${riderLink}`,
          { parse_mode: 'HTML' }
        );
    } catch {}

    try {
      if (ride.riderWaJid)
        await sendWhatsAppMessage(
          ride.riderWaJid,
          `🚗 Your ride is on the way.\nDriver: ${driverContact.name}${driverContact.phone ? ` (${driverContact.phone})` : ''}\nTrack: ${riderLink}`
        );
    } catch {}

    try {
      await DB.sendMessage(
        driverId,
        `🗺️ Trip accepted.\n${driverInfoLine}\n\nOpen the live trip map (shares your GPS):\n${driverLink}`,
        { parse_mode: 'HTML' }
      );
    } catch {}
  } catch (e) {
    console.warn('ride:accepted handler failed:', e?.message || e);
  }
});

driverEvents.on('ride:arrived', async ({ rideId, firstTime = false }) => {
  try {
    const ride = await Ride.findById(rideId);
    if (!ride) return;

    await logActivity({ rideId, type: 'arrived', actorType: 'driver', message: 'Driver arrived at pickup' });

    if (firstTime) {
      try { if (ride.riderChatId) await RB.sendMessage(ride.riderChatId, '📍 Your driver has arrived at the pickup point.'); } catch {}
      try { if (ride.riderWaJid)  await sendWhatsAppMessage(ride.riderWaJid, '📍 Your driver has arrived at the pickup point.'); } catch {}
    }

    io.emit(`ride:${rideId}:arrived`);
  } catch (e) {
    console.warn('ride:arrived handler failed:', e?.message || e);
  }
});

/* Picked event (admin feed) */
driverEvents.on('ride:picked', async ({ rideId }) => {
  try {
    await logActivity({ rideId, type: 'picked', actorType: 'driver', message: 'Rider picked up', meta: { by: 'unknown' } });
  } catch (e) {
    console.warn('ride:picked handler failed:', e?.message || e);
  }
});

driverEvents.on('ride:started', async ({ rideId, by }) => {
  try {
    const ride = await Ride.findById(rideId);
    if (!ride) return;

    try { await Ride.updateOne({ _id: rideId }, { $unset: { _lastArriveEmitAt: 1 } }); } catch {}

    await logActivity({ rideId, type: 'started', actorType: 'driver', message: 'Trip started', meta: { by: by || 'unknown' } });

    const origin = (by || '').toLowerCase();
    const skipNotify = origin === 'web' || origin === 'driver_bot';
    if (skipNotify) return;

    try { if (ride.riderChatId) await RB.sendMessage(ride.riderChatId, '▶️ Your trip has started. Enjoy the ride!'); } catch {}
    try { if (ride.riderWaJid)  await sendWhatsAppMessage(ride.riderWaJid, '▶️ Your trip has started. Enjoy the ride!'); } catch {}
  } catch (e) {
    console.warn('ride:started handler failed:', e?.message || e);
  }
});

/* ---------------- Start/Picked/Cancel APIs (web UI buttons) ---------------- */
app.post('/api/ride/:rideId/start', async (req, res) => {
  try {
    const { rideId } = req.params;
    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    if (!['enroute','completed','cancelled'].includes(ride.status)) {
      ride.status = 'enroute';
      await ride.save();
    }

    const riderChatId = ride.riderChatId || ride.riderTelegramChatId || ride.rider?.chatId || null;
    if (riderChatId && riderBot) {
      try { await riderBot.sendMessage(Number(riderChatId), '🚗 Your driver has started the trip and is heading to you.'); } catch {}
    }

    try { driverEvents.emit('ride:started', { rideId: ride._id.toString(), by: 'web' }); } catch {}
    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/ride/:rideId/start error', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/api/ride/:rideId/picked', async (req, res) => {
  try {
    const { rideId } = req.params;
    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    if (!['enroute','completed','cancelled'].includes(ride.status)) {
      ride.status = 'enroute';
      await ride.save();
    }

    const riderChatId = ride.riderChatId || ride.riderTelegramChatId || ride.rider?.chatId || null;
    if (riderChatId && riderBot) {
      try { await riderBot.sendMessage(Number(riderChatId), '✅ You have been picked up. Heading to your destination now.'); } catch {}
    }

    try { driverEvents.emit('ride:picked', { rideId: ride._id.toString(), by: 'web' }); } catch {}
    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/ride/:rideId/picked error', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/api/ride/:rideId/cancel', async (req, res) => {
  try {
    const { rideId } = req.params;
    const { reason, note } = req.body || {};
    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    let cancelLat = null, cancelLng = null;
    if (ride.driverId) {
      const drv = await Driver.findById(ride.driverId).lean();
      if (drv?.location && typeof drv.location.lat === 'number' && typeof drv.location.lng === 'number') {
        cancelLat = drv.location.lat;
        cancelLng = drv.location.lng;
        await appendPathPoint(ride._id, cancelLat, cancelLng, 'CANCEL');
      }
    }

    if (ride.status !== 'cancelled') {
      ride.status = 'cancelled';
      try {
        ride.cancellationReason = reason || null;
        ride.cancellationNote = (reason === 'Other' ? (note || '') : note) || null;
      } catch {}
      ride.cancelledAt = new Date();
      ride.cancelledBy = 'driver';

      if (cancelLat != null && cancelLng != null && ride.pickup?.lat && ride.pickup?.lng) {
        const meters = haversineMeters({ lat: ride.pickup.lat, lng: ride.pickup.lng }, { lat: cancelLat, lng: cancelLng });
        ride.cancelDriverLoc = { lat: cancelLat, lng: cancelLng };
        ride.cancelDistanceKm = Number((meters / 1000).toFixed(2));
      }

      await ride.save();
    }

    const riderChatId = ride.riderChatId || ride.riderTelegramChatId || ride.rider?.chatId || null;
    if (riderChatId && riderBot) {
      const cleanReason = String(reason || 'Trip cancelled').trim();
      const cleanNote = (note ? String(note).trim() : '');
      const msg =
        `❌ <b>Your trip was cancelled by the driver.</b>\n` +
        `• Reason: <i>${cleanReason}</i>` +
        (cleanNote ? `\n• Note: ${cleanNote}` : '') +
        (ride.cancelDistanceKm != null ? `\n• Distance from pickup: ~${ride.cancelDistanceKm} km` : '');
      try { await riderBot.sendMessage(Number(riderChatId), msg, { parse_mode: 'HTML' }); } catch {}
    }

    await logActivity({
      rideId: ride._id,
      type: 'cancelled',
      actorType: 'driver',
      message: `Ride cancelled (${reason || 'unspecified'})`,
      meta: { reason: reason || null, note: note || null, lat: cancelLat, lng: cancelLng, cancelDistanceKm: ride.cancelDistanceKm ?? null }
    });

    io.emit(`ride:${rideId}:cancelled`, { reason: reason || null, cancelDistanceKm: ride.cancelDistanceKm ?? null });

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/ride/:rideId/cancel error', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------------- Socket.IO ---------------- */
io.on('connection', (sock) => {
  console.log('🔌 Socket connected:', sock.id);

  /* Driver’s browser can stream HTML5 GPS */
  sock.on('driver:mapLocation', async (payload = {}) => {
    try {
      const { rideId, chatId, lat, lng } = payload || {};
      if (!rideId || !Number.isFinite(Number(chatId))) return;
      if (typeof lat !== 'number' || typeof lng !== 'number') return;

      const ride = await Ride.findById(rideId).lean();
      if (!ride || !ride.driverId) return;

      const drv = await Driver.findById(ride.driverId).lean();
      if (!drv || Number(drv.chatId) !== Number(chatId)) return;

      await Driver.findOneAndUpdate(
        { _id: drv._id },
        { $set: { location: { lat, lng }, lastSeenAt: new Date(), isAvailable: true } },
        { new: true }
      );

      driverEvents.emit('driver:location', { chatId: Number(chatId), location: { lat, lng } });
    } catch (e) {
      console.warn('driver:mapLocation error:', e?.message || e);
    }
  });
});

/* ---------------- DEV/DIAG ENDPOINTS (safe to leave; no state changes) ---------------- */
// Force-dispatch a pending ride (helps verify assignment and DM)
app.post('/dev/dispatch/:rideId', async (req, res) => {
  try {
    await dispatchToNearestDriver({ rideId: req.params.rideId });
    res.json({ ok: true });
  } catch (e) {
    console.error('dev/dispatch error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'err' });
  }
});

// Ping a driver on Telegram by chatId (delivery test)
app.get('/dev/ping-driver/:chatId', async (req, res) => {
  try {
    await DB.sendMessage(Number(req.params.chatId), '🔔 test: driver ping');
    res.json({ ok: true });
  } catch (e) {
    console.error('ping failed:', e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || 'err' });
  }
});

// Ping a driver on WhatsApp by phone (+27...)
app.get('/dev/ping-wa-driver/:phone', async (req, res) => {
  try {
    await sendWhatsAppDriverMessage(req.params.phone, '🔔 test: WA driver ping');
    res.json({ ok: true });
  } catch (e) {
    console.error('wa ping failed:', e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || 'err' });
  }
});

/* ---------------- Start server ---------------- */
server.listen(PORT, () => {
  console.log(`🚀 Server is running at http://localhost:${PORT}`);
});

/* ---------------- Graceful shutdown ---------------- */
async function gracefulExit(signal = 'SIGINT') {
  try {
    console.log(`\n🧹 Shutting down (${signal})...`);
    await new Promise((resolve) => server.close(resolve));
    try { await new Promise((resolve) => io.close(resolve)); } catch {}
    try { await riderBot?.stopPolling?.(); } catch {}
    try { await driverBot?.stopPolling?.(); } catch {}
    try {
      for (const id of tickerByDriver.values()) clearInterval(id);
      tickerByDriver.clear();
      lastLocByDriver.clear();
    } catch {}
    try {
      driverEvents.removeAllListeners();
      riderEvents.removeAllListeners();
    } catch {}
    try { await mongoose.connection.close(); } catch {}
    console.log('✅ Clean shutdown complete. Bye!');
    process.exit(0);
  } catch (err) {
    console.error('⚠️ Error during shutdown:', err?.message || err);
    process.exit(1);
  }
}

process.on('SIGINT',  () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.once('SIGUSR2', async () => { await gracefulExit('SIGUSR2'); process.kill(process.pid, 'SIGUSR2'); });
