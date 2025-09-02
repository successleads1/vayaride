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

/* ---- Auth & Routers ---- */
import passport from './src/auth/passport.js';
import driverAuthRouter from './src/routes/driverAuth.js';
import adminRouter from './src/routes/admin.js';

/* ---- Models ---- */
import Ride from './src/models/Ride.js';
import Driver from './src/models/Driver.js';
import Rider from './src/models/Rider.js';
import Admin from './src/models/Admin.js';
import Activity from './src/models/Activity.js';
import finishRouter from './src/routes/finish.js';
import payfastNotifyRouter from './src/routes/payfastNotify.js';
import partnerRouter from './src/routes/partner.js';

/* ---- Bots ---- */
import { initRiderBot, riderEvents, riderBot as RB } from './src/bots/riderBot.js';
import { initDriverBot, driverEvents, driverBot as DB } from './src/bots/driverBot.js';
import {
  initWhatsappBot,
  waitForQrDataUrl,
  isWhatsAppConnected,
  getConnectionStatus,
  sendWhatsAppMessage,
  resetWhatsAppSession,
  notifyWhatsAppRiderToRate           // (kept import)
} from './src/bots/whatsappBot.js';

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

// Routes that expect parsed bodies must be before bots if you ever switch to webhooks
app.use('/api/payfast', payfastNotifyRouter);
app.use('/api/partner', partnerRouter);
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
  await Admin.create({
    name: ADMIN_NAME || 'Super Admin',
    email: ADMIN_EMAIL,
    passwordHash
  });
  console.log('🛡️ Seeded admin:', ADMIN_EMAIL);
}
await ensureSeedAdmin();

/* ---------------- Init Bots (AFTER middleware) ---------------- */
initWhatsappBot();
const riderBot = initRiderBot(io);
const driverBot = initDriverBot(io);
console.log('🤖 Rider bot initialized');
console.log('🚗 Driver bot initialized');

/* ---------------- Helper: log + broadcast to admin ---------------- */
async function logActivity({
  rideId,
  type,
  message,
  actorType = 'system',
  actorId = null,
  meta = {}
}) {
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

/* ---------------- Routes ---------------- */
app.get('/', (req, res) => res.render('landing', { title: 'VayaRide' }));
app.use('/driver', driverAuthRouter);
app.use('/admin', adminRouter);

app.get('/api/rider-by-token/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const pin = req.query.pin;
    const rider = await Rider.findOne({ dashboardToken: token }).lean();
    if (!rider) return res.status(404).json({ error: 'Rider not found' });

    const now = new Date();
    if (
      !rider.dashboardTokenExpiry ||
      rider.dashboardPin !== pin ||
      now > new Date(rider.dashboardTokenExpiry)
    ) {
      return res.status(401).json({ error: 'Access denied. PIN or token expired' });
    }

    const orFilters = [];
    const chatIdNum = Number(rider.chatId);
    if (Number.isFinite(chatIdNum)) {
      orFilters.push({ riderChatId: { $in: [chatIdNum, String(rider.chatId)] } });
    }
    if (rider.waJid) {
      orFilters.push({ riderWaJid: rider.waJid });
    }
    const rideMatch = orFilters.length ? { $or: orFilters } : { _id: null };

    const [lastPaid, tripsCompleted, starsAgg] = await Promise.all([
      Ride.findOne({
        ...rideMatch,
        $or: [{ paymentStatus: 'paid' }, { status: 'completed' }]
      })
        .sort({
          paidAt: -1,
          completedAt: -1,
          updatedAt: -1,
          createdAt: -1
        })
        .lean(),
      Ride.countDocuments({
        ...rideMatch,
        status: 'completed'
      }),
      Ride.aggregate([
        { $match: { ...rideMatch, riderRating: { $gte: 1 } } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            avg: { $avg: '$riderRating' }
          }
        }
      ])
    ]);

    const lastPayment = lastPaid
      ? {
          rideId: String(lastPaid._id),
          amount: Number(lastPaid.finalAmount ?? lastPaid.estimate ?? 0) || 0,
          method: lastPaid.paymentMethod || null,
          at:
            lastPaid.paidAt ||
            lastPaid.completedAt ||
            lastPaid.updatedAt ||
            lastPaid.createdAt ||
            null
        }
      : null;

    const riderStars = starsAgg && starsAgg.length
      ? { avg: Number(starsAgg[0].avg.toFixed(2)), count: starsAgg[0].count }
      : { avg: null, count: 0 };

    res.set('Cache-Control', 'no-store');

    return res.json({
      platform: rider.platform || null,
      chatId: Number.isFinite(chatIdNum) ? chatIdNum : null,
      waJid: rider.waJid || null,
      name: rider.name || '',
      email: rider.email || '',
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

/* WhatsApp QR Code helpers */
app.post('/wa/reset', async (req, res) => {
  await resetWhatsAppSession();
  res.json({ ok: true, message: 'WhatsApp session reset. Open /qrcode to scan again.' });
});

app.get('/qrcode', async (req, res) => {
  if (isWhatsAppConnected()) {
    return res.send('<h2>✅ WhatsApp is connected.</h2>');
  }
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

/* Profile update (dashboard) */
app.post('/api/update-profile', async (req, res) => {
  const { chatId, name, email, credit } = req.body;
  if (!chatId || isNaN(Number(chatId))) {
    return res.status(400).send('❌ Invalid or missing chatId.');
  }

  const rider = await Rider.findOne({ chatId: Number(chatId) });
  if (!rider) {
    return res.status(403).send('<h2>❌ Unauthorized: Rider not found</h2>');
  }

  if (name != null) rider.name = name;
  if (email != null) rider.email = email;
  if (credit != null && credit !== '') rider.credit = credit;

  await rider.save();
  res.send('<h2>✅ Profile updated securely.</h2>');
});

/* Legacy rider endpoint */
app.get('/api/rider/:chatId', async (req, res) => {
  const rider = await Rider.findOne({ chatId: req.params.chatId });
  if (!rider) return res.status(404).json({ error: 'Rider not found' });

  res.json({
    name: rider.name,
    email: rider.email,
    credit: rider.credit,
    trips: rider.trips || 0
  });
});

/* Webhook endpoints (optional; safe if using polling) */
app.post('/rider-bot', (req, res) => {
  riderBot.processUpdate?.(req.body);
  res.sendStatus(200);
});
app.post('/driver-bot', (req, res) => {
  driverBot.processUpdate?.(req.body);
  res.sendStatus(200);
});

/* Pay route */
app.use('/pay', (await import('./src/routes/payfast.js')).default);

/* Map/track page (back-compat) */
app.get('/map/:rideId', (req, res) => {
  const url = `/track.html?rideId=${encodeURIComponent(req.params.rideId)}`;
  res.redirect(302, url);
});

/* ---------------- Tracking APIs ---------------- */

function isRideLinkExpired(ride) {
  if (['cancelled', 'completed', 'payment_pending'].includes(ride.status)) {
    return { expired: true, reason: ride.status };
  }
  if (TRACK_LINK_TTL_HOURS > 0) {
    const made = new Date(ride.createdAt || Date.now());
    const expiresAt = new Date(made.getTime() + TRACK_LINK_TTL_HOURS * 3600 * 1000);
    if (Date.now() > +expiresAt) {
      return { expired: true, reason: 'ttl', expiresAt };
    }
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

    res.json({
      pickup: ride.pickup,
      destination: ride.destination,
      status: ride.status || 'pending',
      driverChatId,
      pickedAt: ride.pickedAt || ride.startedAt || null,
      completedAt: ride.completedAt || null,
      createdAt: ride.createdAt
    });
  } catch (e) {
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

    await Ride.updateOne(
      { _id: rideId },
      { $push: { path: { lat, lng, ts: new Date() } } }
    );

    lastPathByRide.set(key, { lat, lng, ts: now });

    if (label) {
      console.log(`🧭 PATH ${label} ride=${key} lat=${lat.toFixed(6)} lng=${lng.toFixed(6)}`);
    }
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
        // broadcast to ride viewers
        io.emit(`ride:${ride._id}:driverLocation`, { lat, lng });

        // ⭐ also append to the ride path (capped)
        appendPathPoint(ride._id, lat, lng);

        // ---------- DURABLE ARRIVAL DEDUPE ----------
        if (ride.status === 'accepted' && ride.pickup?.lat && ride.pickup?.lng) {
          const dMeters = haversineMeters({ lat, lng }, ride.pickup);
          if (dMeters <= 35) {
            const now = new Date();
            const lastEmitTs = ride._lastArriveEmitAt ? new Date(ride._lastArriveEmitAt).getTime() : 0;
            const COOLDOWN_MS = 20 * 1000; // 20s anti-burst
            const cooled = now.getTime() - lastEmitTs > COOLDOWN_MS;

            // First time: atomically set arrivedNotified -> true
            const result = await Ride.updateOne(
              { _id: ride._id, arrivedNotified: { $ne: true } },
              { $set: { arrivedNotified: true, arrivedAt: now, _lastArriveEmitAt: now } }
            );

            if (result.modifiedCount > 0 || (ride.arrivedNotified && cooled)) {
              try {
                driverEvents.emit('ride:arrived', { driverId: chatId, rideId: String(ride._id) });
                io.emit(`ride:${ride._id}:arrived`);
              } finally {
                // If already notified previously, at least refresh cooldown
                if (!(result.modifiedCount > 0)) {
                  await Ride.updateOne({ _id: ride._id }, { $set: { _lastArriveEmitAt: now } });
                }
              }
            }
          }
        }
        // -------------------------------------------
      }
    }

    // heartbeat rebroadcast loop
    if (!tickerByDriver.has(cId)) {
      const id = setInterval(async () => {
        const last = lastLocByDriver.get(cId);
        if (!last) return;

        const staleMs = Date.now() - last.ts;
        if (staleMs > 2 * 60 * 1000) {
          stopDriverTicker(cId);
          return;
        }

        io.emit(`driver:${cId}:location`, { lat: last.lat, lng: last.lng });

        try {
          const drv2 = await Driver.findOne({ chatId: cId }).select('_id').lean();
          if (!drv2?._id) return;
          const active = await Ride.findOne({
            driverId: drv2._id,
            status: { $in: ['accepted', 'enroute'] }
          }).sort({ updatedAt: -1 }).select('_id').lean();
          if (active?._id) {
            io.emit(`ride:${active._id}:driverLocation`, { lat: last.lat, lng: last.lng });
          }
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
  const ride = await Ride.findById(rideId);
  if (!ride || ride.status !== 'pending') return;

  const chosen = await assignNearestDriver(ride.pickup, {
    vehicleType: ride.vehicleType || null,
    exclude: excludeDriverIds
  });

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

  const toMap = ({ lat, lng }) => `https://maps.google.com/?q=${lat},${lng}`;
  const text =
    `🚗 <b>New Ride Request</b>\n\n` +
    `• Vehicle: <b>${(ride.vehicleType || 'normal').toUpperCase()}</b>\n` +
    (ride.estimate ? `• Estimate: <b>R${ride.estimate}</b>\n` : '') +
    `• Pickup: <a href="${toMap(ride.pickup)}">Open Map</a>\n` +
    `• Drop:   <a href="${toMap(ride.destination || ride.pickup)}">Open Map</a>\n\n` +
    `Accept to proceed.`;

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
    console.warn('Failed to DM driver request:', e?.message || e);
  }
}

riderEvents.on('booking:new', async ({ rideId }) => {
  try {
    if (!rideId) return;
    await logActivity({ rideId, type: 'request', actorType: 'rider', message: 'Rider requested a trip' });
    await dispatchToNearestDriver({ rideId });
  } catch (e) { console.error('booking:new handler error:', e?.message || e); }
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
  } catch (e) { console.error('ride:ignored handler error:', e?.message || e); }
});

/* ➕ When the driver accepts, send links */
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

    try { if (ride.riderChatId) await RB.sendMessage(ride.riderChatId, `🚗 Your ride is on the way. Track here:\n${riderLink}`); } catch {}
    try { if (ride.riderWaJid)  await sendWhatsAppMessage(ride.riderWaJid, `🚗 Your ride is on the way. Track here:\n${riderLink}`); } catch {}
    try { await DB.sendMessage(driverId, `🗺️ Open the live trip map (shares your GPS):\n${driverLink}`); } catch {}
  } catch (e) {
    console.warn('ride:accepted handler failed:', e?.message || e);
  }
});

/* Arrived → notify + socket */
driverEvents.on('ride:arrived', async ({ rideId }) => {
  try {
    const ride = await Ride.findById(rideId);
    if (!ride) return;

    await logActivity({
      rideId,
      type: 'arrived',
      actorType: 'driver',
      message: 'Driver arrived at pickup'
    });

    try { if (ride.riderChatId) await RB.sendMessage(ride.riderChatId, '📍 Your driver has arrived at the pickup point.'); } catch {}
    try { if (ride.riderWaJid)  await sendWhatsAppMessage(ride.riderWaJid, '📍 Your driver has arrived at the pickup point.'); } catch {}

    io.emit(`ride:${rideId}:arrived`);
  } catch (e) {
    console.warn('ride:arrived handler failed:', e?.message || e);
  }
});

/* Picked event (admin feed) */
driverEvents.on('ride:picked', async ({ rideId }) => {
  try {
    await logActivity({
      rideId,
      type: 'picked',
      actorType: 'driver',
      message: 'Rider picked up',
      meta: { by: 'unknown' }
    });
  } catch (e) {
    console.warn('ride:picked handler failed:', e?.message || e);
  }
});

driverEvents.on('ride:started', async ({ rideId, by }) => {
  try {
    const ride = await Ride.findById(rideId);
    if (!ride) return;

    // we no longer use an in-memory set; just clear cooldown stamp if any
    try { await Ride.updateOne({ _id: rideId }, { $unset: { _lastArriveEmitAt: 1 } }); } catch {}

    await logActivity({
      rideId,
      type: 'started',
      actorType: 'driver',
      message: 'Trip started',
      meta: { by: by || 'unknown' }
    });

    const origin = (by || '').toLowerCase();
    const skipNotify = origin === 'web' || origin === 'driver_bot';
    if (skipNotify) return;

    try { if (ride.riderChatId) await RB.sendMessage(ride.riderChatId, '▶️ Your trip has started. Enjoy the ride!'); } catch {}
    try { if (ride.riderWaJid)  await sendWhatsAppMessage(ride.riderWaJid, '▶️ Your trip has started. Enjoy the ride!'); } catch {}
  } catch (e) {
    console.warn('ride:started handler failed:', e?.message || e);
  }
});

/* ---------------- Start Trip API ---------------- */
app.post('/api/ride/:rideId/start', async (req, res) => {
  try {
    const { rideId } = req.params;
    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    if (!['enroute','completed','cancelled'].includes(ride.status)) {
      ride.status = 'enroute';
      await ride.save();
    }

    const riderChatId =
      ride.riderChatId ||
      ride.riderTelegramChatId ||
      ride.rider?.chatId ||
      null;

    if (riderChatId && riderBot) {
      try {
        await riderBot.sendMessage(
          Number(riderChatId),
          '🚗 Your driver has started the trip and is heading to you.'
        );
      } catch (err) {
        console.error('Failed to message rider on Telegram:', err?.message || err);
      }
    }

    try {
      driverEvents.emit('ride:started', { rideId: ride._id.toString(), by: 'web' });
    } catch {}

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/ride/:rideId/start error', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------------- Picked Up API ---------------- */
app.post('/api/ride/:rideId/picked', async (req, res) => {
  try {
    const { rideId } = req.params;
    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    if (!['enroute','completed','cancelled'].includes(ride.status)) {
      ride.status = 'enroute';
      await ride.save();
    }

    const riderChatId =
      ride.riderChatId ||
      ride.riderTelegramChatId ||
      ride.rider?.chatId ||
      null;

    if (riderChatId && riderBot) {
      try {
        await riderBot.sendMessage(
          Number(riderChatId),
          '✅ You have been picked up. Heading to your destination now.'
        );
      } catch (err) {
        console.error('Failed to message rider on Telegram (picked):', err?.message || err);
      }
    }

    try {
      driverEvents.emit('ride:picked', { rideId: ride._id.toString(), by: 'web' });
    } catch {}

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/ride/:rideId/picked error', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------------- Cancel Trip API ---------------- */
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
        const meters = haversineMeters(
          { lat: ride.pickup.lat, lng: ride.pickup.lng },
          { lat: cancelLat,      lng: cancelLng }
        );
        ride.cancelDriverLoc = { lat: cancelLat, lng: cancelLng };
        ride.cancelDistanceKm = Number((meters / 1000).toFixed(2));
      }

      await ride.save();
    }

    if (cancelLat != null && cancelLng != null) {
      console.log(
        `❌ CANCELLED ride=${rideId} reason="${reason || ''}" lat=${cancelLat.toFixed(6)} lng=${cancelLng.toFixed(6)}` +
        (ride.cancelDistanceKm != null ? ` (~${ride.cancelDistanceKm} km from pickup)` : '')
      );
    } else {
      console.log(`❌ CANCELLED ride=${rideId} reason="${reason || ''}" (no last driver coords)`);
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
      meta: {
        reason: reason || null,
        note: note || null,
        lat: cancelLat,
        lng: cancelLng,
        cancelDistanceKm: ride.cancelDistanceKm ?? null
      }
    });

    io.emit(`ride:${rideId}:cancelled`, {
      reason: reason || null,
      cancelDistanceKm: ride.cancelDistanceKm ?? null
    });

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

      // Validate: this chatId must be the driver assigned to this ride
      const ride = await Ride.findById(rideId).lean();
      if (!ride || !ride.driverId) return;

      const drv = await Driver.findById(ride.driverId).lean();
      if (!drv || Number(drv.chatId) !== Number(chatId)) return;

      // Update DB so /api/driver-last-loc works as well
      await Driver.findOneAndUpdate(
        { _id: drv._id },
        { $set: { location: { lat, lng }, lastSeenAt: new Date(), isAvailable: true } },
        { new: true }
      );

      // Reuse the same broadcast path as Telegram updates
      driverEvents.emit('driver:location', { chatId: Number(chatId), location: { lat, lng } });
    } catch (e) {
      console.warn('driver:mapLocation error:', e?.message || e);
    }
  });
});

/* ---------------- Start server ---------------- */
server.listen(PORT, () => {
  console.log(`🚀 Server is running at http://localhost:${PORT}`);
});

/* ---------------- Graceful shutdown ---------------- */
async function gracefulExit(signal = 'SIGINT') {
  try {
    console.log(`\n🧹 Shutting down (${signal})...`);

    // Stop accepting new connections
    await new Promise((resolve) => server.close(resolve));

    // Stop Socket.IO
    try { await new Promise((resolve) => io.close(resolve)); } catch {}

    // Stop Telegram polling (if running)
    try { await riderBot?.stopPolling?.(); } catch {}
    try { await driverBot?.stopPolling?.(); } catch {}

    // Clear per-driver tickers (avoid orphaned intervals)
    try {
      for (const id of tickerByDriver.values()) clearInterval(id);
      tickerByDriver.clear();
      lastLocByDriver.clear();
    } catch {}

    // Optional: remove event listeners
    try {
      driverEvents.removeAllListeners();
      riderEvents.removeAllListeners();
    } catch {}

    // Close Mongo
    try { await mongoose.connection.close(); } catch {}

    console.log('✅ Clean shutdown complete. Bye!');
    process.exit(0);
  } catch (err) {
    console.error('⚠️ Error during shutdown:', err?.message || err);
    process.exit(1);
  }
}

process.on('SIGINT',  () => gracefulExit('SIGINT'));   // Ctrl+C / Git Bash / Windows console
process.on('SIGTERM', () => gracefulExit('SIGTERM'));  // Cloud providers
process.once('SIGUSR2', async () => {                  // nodemon hot-restart
  await gracefulExit('SIGUSR2');
  process.kill(process.pid, 'SIGUSR2');
});
