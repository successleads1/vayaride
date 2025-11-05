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
import adminPrebook from "./src/routes/admin_prebook.js";

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
  // sendWhatsAppMessage, // no longer used here for ride events
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
// NOTE: assignNearestDriver removed from use to favor broadcast; keep others if needed elsewhere
import { setEstimateOnRide, hasNumericChatId } from './src/services/assignment.js';

/* ---- 🆕 Admin comms routes ---- */
import adminRiderCommsRouter from './src/routes/adminRiderComms.js';

/* ---- 🆕 Scheduler ---- */
import { startPrebookScheduler } from './src/schedulers/prebook.js';

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
app.use('/api/rider', riderRouter); // 🆕 NEW: mount rider API (profile + referral + discount info)

/* ---------------- Routes that need bodies first ---------------- */
app.use('/api/payfast', payfastNotifyRouter);   // /api/payfast/notify (ITN)
app.use('/api/payfast', payfastGatewayRouter);  // /api/payfast/gateway (auto-post to PayFast)
app.use('/api/partner', partnerRouter);         // /api/partner/upgrade/payfast (landing page)
app.use('/pay', payfastRouter);                 // /pay/:rideId → redirect to landing

/* -------- 🆕 Admin comms router (WA blast + single) -------- */
app.use(adminRiderCommsRouter);

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
import bcryptPkg from 'bcrypt';
const bcryptAlias = bcryptPkg?.hash ? bcryptPkg : bcrypt;
async function ensureSeedAdmin() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.warn('⚠️ Skipping admin seed: ADMIN_EMAIL/ADMIN_PASSWORD not set');
    return;
  }
  const existing = await Admin.findOne({ email: ADMIN_EMAIL });
  if (existing) return;
  const passwordHash = await bcryptAlias.hash(ADMIN_PASSWORD, 12);
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

    let candidate =
      normalizePhone(ride?.riderPhone || ride?.riderPhoneNumber || ride?.riderMsisdn || ride?.riderMobile) ||
      (ride?.riderWaJid ? jidToPhone(ride.riderWaJid) : null) ||
      (rider.waJid ? jidToPhone(rider.waJid) : null);

    if (!candidate) return null;

    await Rider.updateOne(
      { _id: rider._id },
      { $set: { phone: candidate, msisdn: candidate } }
    );

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

  let phone = pickPhoneLike(rider);

  if (!phone) phone = normalizePhone(ride.riderPhone || ride.riderPhoneNumber || ride.riderMsisdn || ride.riderMobile);
  if (!phone && ride.riderWaJid) phone = jidToPhone(ride.riderWaJid);

  if (rider && !pickPhoneLike(rider) && phone) {
    try { await Rider.updateOne({ _id: rider._id }, { $set: { phone, msisdn: phone } }); } catch {}
  }
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

app.use('/admin', adminPrebook);

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

app.get('/driver-wa/status', (req, res) => {
  res.json({ connected: isWhatsAppDriverConnected(), state: getDriverConnectionStatus() });
});

app.get('/api/wa-driver/status', (req, res) => {
  res.json({ status: getDriverConnectionStatus(), connected: isWhatsAppDriverConnected() });
});

/* ---------------- Telegram webhooks if used ---------------- */
import { riderBot as RiderBotShim } from './src/bots/riderBot.js';
import { driverBot as DriverBotShim } from './src/bots/driverBot.js';
app.post('/rider-bot', (req, res) => { RiderBotShim.processUpdate?.(req.body); res.sendStatus(200); });
app.post('/driver-bot', (req, res) => { DriverBotShim.processUpdate?.(req.body); res.sendStatus(200); });

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

/* ---------------- Referral short links ---------------- */
app.get('/i/d/:code', async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();

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

app.get('/i/r/:code', async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();

  try {
    await Rider.updateOne(
      { referralCode: code },
      { $inc: { 'referralStats.clicks': 1 } }
    );
  } catch (e) {
    console.warn('rider ref click bump failed:', e?.message || e);
  }

  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return res.redirect(302, `${base}/register?ref=${encodeURIComponent(code)}`);
});

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

/* ---------------- Live driver broadcasts ---------------- */
driverEvents.on('driver:location', async ({ chatId, location }) => {
  try {
    const cId = Number(chatId);
    const { lat, lng } = location || {};
    if (typeof lat !== 'number' || typeof lng !== 'number') return;

    lastLocByDriver.set(cId, { lat, lng, ts: Date.now() });
    io.emit(`driver:${cId}:location`, { lat, lng });

    const drv = await Driver.findOne({ chatId: cId }).select('_id').lean();
    if (drv?._id) {
      const ride = await Ride.findOne({
        driverId: drv._id,
        status: { $in: ['accepted', 'enroute'] }
      }).sort({ updatedAt: -1 }).lean();

      if (ride?._id) {
        io.emit(`ride:${ride._id}:driverLocation`, { lat, lng });

        appendPathPoint(ride._id, lat, lng);

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

/* ---------------- BOOKING DISPATCH PIPELINE (BROADCAST) ---------------- */
/**
 * Broadcast a ride request to ALL approved drivers (Telegram + WhatsApp),
 * regardless of online/offline. First accept wins (atomic in driver bot).
 */
async function dispatchToNearestDriver({ rideId, excludeDriverIds = [] }) {
  // NOTE: function name kept for compatibility, but behavior is BROADCAST.
  console.log('[dispatch:broadcast] rideId=', rideId);

  const ride = await Ride.findById(rideId);
  if (!ride || (ride.status !== 'pending' && ride.status !== 'scheduled')) return;

  // (Optional) attempt to set estimate using a sample driver location if present; ignore failures
  try { await setEstimateOnRide(ride._id, null); } catch {}

  const excludeSet = new Set((excludeDriverIds || []).map(String));

  // ALL approved drivers with a Telegram chatId
  const tgDrivers = await Driver.find({
    status: 'approved',
    chatId: { $exists: true, $ne: null }
  }).select('_id chatId name email isAvailable').limit(5000).lean();

  // Broadcast to Telegram drivers
  for (const d of tgDrivers) {
    if (excludeSet.has(String(d._id))) continue;
    if (!hasNumericChatId(d)) continue;
    try {
      const riderContact = await resolveRiderContactFromRide(ride);
      await DB.sendMessage(d.chatId, [
        '🚗 <b>New Ride Request</b>',
        `• Vehicle: <b>${(ride.vehicleType || 'normal').toUpperCase()}</b>`,
        ride.estimate != null ? `• Estimate: <b>R${ride.estimate}</b>` : null,
        riderContact?.name ? `• Rider: ${riderContact.name}${riderContact.phone ? ` (${riderContact.phone})` : ''}` : null,
        ride.pickup ? `• Pickup: <a href="https://maps.google.com/?q=${ride.pickup.lat},${ride.pickup.lng}">Open Map</a>` : null,
        ride.destination ? `• Drop: <a href="https://maps.google.com/?q=${ride.destination.lat},${ride.destination.lng}">Open Map</a>` : null,
        '',
        'Accept to proceed.'
      ].filter(Boolean).join('\n'), {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Accept', callback_data: `accept_${ride._id}` },
            { text: '🙈 Ignore', callback_data: `ignore_${ride._id}` }
          ]]
        }
      });
    } catch (e) {
      console.warn('Broadcast TG failed for driver', d?.chatId, e?.message || e);
    }
  }

  // Broadcast to WhatsApp drivers (if linked)
  try {
    const waDrivers = await Driver.find({
      status: 'approved',
      waJid: { $exists: true, $ne: null }
    }).select('_id waJid name').limit(5000).lean();

    for (const d of waDrivers) {
      if (excludeSet.has(String(d._id))) continue;
      try {
        await waNotifyDriverNewRequest({ driver: d, ride, riderContact: await resolveRiderContactFromRide(ride) });
      } catch (e) {
        console.warn('Broadcast WA failed for driver', d?.waJid, e?.message || e);
      }
    }
  } catch (e) {
    console.warn('WA broadcast driver query failed:', e?.message || e);
  }

  try {
    await logActivity({
      rideId: ride._id,
      type: 'broadcast',
      actorType: 'system',
      message: `Broadcasted ride to approved drivers (${tgDrivers.length}+ TG, WA included if connected)`,
      meta: { tgDrivers: tgDrivers.length }
    });
  } catch {}
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
    // Re-broadcast (optionally exclude the previous driver)
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

    // WhatsApp rider notification for accepted is handled in whatsappBot.js

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
      // WhatsApp rider "arrived" message is handled in whatsappBot.js
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
    // WhatsApp rider "started" message is handled in whatsappBot.js
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

/* ---------------- DEV/DIAG ENDPOINTS ---------------- */
app.post('/dev/dispatch/:rideId', async (req, res) => {
  try {
    await dispatchToNearestDriver({ rideId: req.params.rideId });
    res.json({ ok: true });
  } catch (e) {
    console.error('dev/dispatch error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'err' });
  }
});

app.get('/dev/ping-driver/:chatId', async (req, res) => {
  try {
    await DB.sendMessage(Number(req.params.chatId), '🔔 test: driver ping');
    res.json({ ok: true });
  } catch (e) {
    console.error('ping failed:', e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || 'err' });
  }
});

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

/* ---------------- 🆕 Start Prebook Scheduler ---------------- */
startPrebookScheduler({
  Ride,
  dispatchToNearestDriver,
  logActivity
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
      // clear any intervals/maps
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
