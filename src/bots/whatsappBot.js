// src/bots/whatsappBot.js
// ✅ ESM imports for Baileys
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  delay
} from '@whiskeysockets/baileys';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import qrcode from 'qrcode';
import EventEmitter from 'events';
import axios from 'axios';
import crypto from 'crypto';

import Ride from '../models/Ride.js';
import Rider from '../models/Rider.js';
import Driver from '../models/Driver.js';
import { riderEvents } from './riderBot.js';
import { driverEvents } from './driverBot.js';
import { getAvailableVehicleQuotes } from '../services/pricing.js';

/* --------------- paths / env --------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(process.cwd());
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const AUTH_DIR = process.env.WA_AUTH_DIR
  ? path.resolve(process.env.WA_AUTH_DIR)
  : path.resolve(ROOT_DIR, 'baileys_auth_info');

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const PUBLIC_URL = process.env.PUBLIC_URL || '';

/* ---------- ZA-only parameters ---------- */
const GMAPS_COMPONENTS = process.env.GOOGLE_MAPS_COMPONENTS || 'country:za';
const GMAPS_LANGUAGE = process.env.GOOGLE_MAPS_LANGUAGE || 'en-ZA';
const GMAPS_REGION = process.env.GOOGLE_MAPS_REGION || 'za';
const ZA_CENTER = { lat: -28.4793, lng: 24.6727 };
const ZA_RADIUS_M = 1_500_000;

/* --------------- state --------------- */
let sock = null;
let initializing = false;
let currentQR = null;
let connState = 'disconnected';

const waNames = new Map(); // jid -> name
const waRideById = new Map();

// per-JID booking/registration wizard state
// booking: { stage, pickup, destination, quotes, chosenVehicle, price, rideId, suggestions, addrSession }
// registration: { stage: 'reg_name' | 'reg_email', temp: {name, email} }
const convo = new Map();

// rating-await map (jid -> rideId)
const ratingAwait = new Map();

/* --------------- helpers --------------- */
const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });

function purgeAuthFolder() {
  try {
    if (!fs.existsSync(AUTH_DIR)) return;
    for (const f of fs.readdirSync(AUTH_DIR)) {
      fs.rmSync(path.join(AUTH_DIR, f), { recursive: true, force: true });
    }
    logger.warn('WA: purged auth folder');
  } catch (e) {
    logger.error('WA: purge error %s', e?.message || e);
  }
}

async function saveQrPng(dataUrl) {
  try {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const file = path.join(PUBLIC_DIR, 'wa-qr.png');
    fs.writeFileSync(file, base64, 'base64');
  } catch (e) {
    logger.warn('WA: failed to save wa-qr.png: %s', e?.message || e);
  }
}

/* ---------- DEDUPE LAYER ---------- */
const DEDUPE_TTL_MS = Number(process.env.WA_DEDUPE_TTL_MS || 12000);
const _recentSends = new Map();
function _normalizeText(t = '') { return String(t).trim().replace(/\s+/g, ' '); }
function _shouldSendOnce(jid, text) {
  const key = `${jid}|${_normalizeText(text)}`;
  const now = Date.now();
  const last = _recentSends.get(key) || 0;
  if (now - last < DEDUPE_TTL_MS) return false;
  _recentSends.set(key, now);
  if (_recentSends.size > 2000) {
    const cutoff = now - 2 * DEDUPE_TTL_MS;
    for (const [k, ts] of _recentSends) if (ts < cutoff) _recentSends.delete(k);
  }
  return true;
}

async function sendText(jid, text) {
  if (!sock) throw new Error('WA client not ready');
  if (!_shouldSendOnce(jid, text)) return;
  await sock.sendMessage(jid, { text });
}

function generatePIN() { return Math.floor(1000 + Math.random() * 9000).toString(); }
function generateToken() { return crypto.randomBytes(24).toString('hex'); }
const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

/* ---------- Shortcut expansions ---------- */
const ZA_SHORTCUTS = {
  uct: 'University of Cape Town',
  uwc: 'University of the Western Cape',
  cput: 'Cape Peninsula University of Technology',
  wits: 'University of the Witwatersrand',
  uj: 'University of Johannesburg',
  up: 'University of Pretoria',
  ukzn: 'University of KwaZulu-Natal',
  nwu: 'North-West University',
  unisa: 'University of South Africa',
  stellenbosch: 'Stellenbosch University',
  ru: 'Rhodes University'
};
function expandShortcut(raw = '') {
  const key = String(raw).trim().toLowerCase();
  return ZA_SHORTCUTS[key] || raw;
}
function boostToZA(raw = '') {
  const q = String(raw).trim();
  if (q.length <= 5) return `${q} South Africa`;
  return q;
}

/* ---------- flow helpers ---------- */
function resetFlow(jid) { convo.set(jid, { stage: 'idle' }); }
function startBooking(jid) { convo.set(jid, { stage: 'await_pickup' }); }
function startRegistration(jid) { convo.set(jid, { stage: 'reg_name', temp: {} }); }

function sendMainMenu(jid) {
  return sendText(
    jid,
    `👋 *Welcome to VayaRide!*\n` +
    `Please reply with a number:\n\n` +
    `1) 🚕 Book Trip\n` +
    `2) ❓ Help\n` +
    `3) 🧑‍💬 Support\n` +
    `4) 👤 Profile`
  );
}

/* ---------- persist WA rider profile & location ---------- */
async function upsertWaRider(jid, { name = null, lastLocation = null } = {}) {
  const set = { lastSeenAt: new Date(), platform: 'whatsapp' };
  if (name) set.name = name;
  if (lastLocation) set.lastLocation = { ...lastLocation, ts: new Date() };
  await Rider.findOneAndUpdate(
    { waJid: jid },
    { $set: set, $setOnInsert: { waJid: jid, platform: 'whatsapp' } },
    { upsert: true }
  );
}

/* ---------- Dashboard link for WA ---------- */
async function sendDashboardLinkWA(jid) {
  const dashboardToken = generateToken();
  const dashboardPin = generatePIN();
  const expiry = new Date(Date.now() + 10 * 60 * 1000);

  await Rider.findOneAndUpdate(
    { waJid: jid },
    { $set: { dashboardToken, dashboardPin, dashboardTokenExpiry: expiry, platform: 'whatsapp' } },
    { upsert: true }
  );

  const link = `${PUBLIC_URL}/rider-dashboard.html?token=${dashboardToken}`;
  await sendText(jid, `🔐 *Dashboard link:*\n${link}\n\n🔢 *Your PIN:* ${dashboardPin}\n⏱️ *Expires in 10 mins*`);
}

/* ---------- Google Places helpers (ZA) ---------- */
function ensureSessionToken(state) {
  if (!state.addrSession) state.addrSession = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return state.addrSession;
}

async function placesAutocomplete(input, sessionToken) {
  if (!GOOGLE_MAPS_API_KEY) return [];
  const expanded = expandShortcut(input);
  const maybeBoosted = boostToZA(expanded);

  const url = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';
  const params = {
    input: maybeBoosted,
    key: GOOGLE_MAPS_API_KEY,
    components: GMAPS_COMPONENTS, // country:za
    language: GMAPS_LANGUAGE,
    region: GMAPS_REGION,
    location: `${ZA_CENTER.lat},${ZA_CENTER.lng}`,
    radius: String(ZA_RADIUS_M),
    strictbounds: 'true',
    sessiontoken: sessionToken
  };
  const { data } = await axios.get(url, { params, timeout: 10000 });
  if (data?.status !== 'OK' || !Array.isArray(data?.predictions)) return [];
  return data.predictions.slice(0, 8).map(p => ({ place_id: p.place_id, description: p.description }));
}

async function placeDetails(placeId, sessionToken) {
  if (!GOOGLE_MAPS_API_KEY) return null;
  const url = 'https://maps.googleapis.com/maps/api/place/details/json';
  const params = {
    place_id: placeId,
    fields: 'geometry/location,formatted_address,name',
    key: GOOGLE_MAPS_API_KEY,
    language: GMAPS_LANGUAGE,
    region: GMAPS_REGION,
    sessiontoken: sessionToken
  };
  const { data } = await axios.get(url, { params, timeout: 10000 });
  if (data?.status !== 'OK' || !data?.result?.geometry?.location) return null;
  const loc = data.result.geometry.location;
  return { lat: Number(loc.lat), lng: Number(loc.lng), address: data.result.formatted_address || data.result.name || '' };
}

function formatSuggestionList(sugs) {
  if (!sugs?.length) return '';
  return sugs.map((s, i) => `${i + 1}) ${s.description}`).join('\n');
}

/* ---------- rideId -> jid resolver ---------- */
async function getWaJidForRideId(rideId) {
  const cached = waRideById.get(String(rideId));
  if (cached) return cached;
  try {
    const r = await Ride.findById(rideId).select('riderWaJid').lean();
    return r?.riderWaJid || null;
  } catch { return null; }
}

/* --------------- WA setup --------------- */
async function setupClient() {
  if (initializing) return;
  initializing = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);
    console.log('🔄 Connecting to WhatsApp...');

    connState = 'connecting';

    sock = makeWASocket({
      version,
      logger,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      browser: ['VayaRide Bot', 'Chrome', '120.0'],
      generateHighQualityLinkPreview: false,
      qrTimeout: 60_000,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 10_000,
      markOnlineOnConnect: true,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        if (process.env.WA_SHOW_QR === '1') {
          try { console.log('\n' + await qrcode.toString(qr, { type: 'terminal', small: true })); }
          catch { console.log('Open /qrcode to scan via browser.'); }
        }
        try {
          const dataUrl = await qrcode.toDataURL(qr);
          await saveQrPng(dataUrl);
          waEvents.emit('qr', dataUrl);
        } catch (e) { logger.warn('WA: could not create QR dataURL: %s', e?.message || e); }
      }

      if (connection === 'open') {
        currentQR = null;
        connState = 'connected';
        console.log('✅ WhatsApp connected');
      }

      if (connection === 'close') {
        const code =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.status ?? 0;
        const reason = lastDisconnect?.error?.data?.reason;

        connState = 'disconnected';

        const isLoggedOut =
          code === DisconnectReason.loggedOut || code === 401 || reason === '401' || reason === 'logged_out';
        const badSession =
          code === DisconnectReason.badSession || reason === 'bad_session';

        if (isLoggedOut || badSession) {
          console.log('❌ Logged out / bad session. Clearing creds and restarting…');
          purgeAuthFolder();
          await delay(1500);
          initializing = false;
          return setupClient();
        }

        console.log('↩️ Reconnecting in 5s…');
        await delay(5000);
        initializing = false;
        return setupClient();
      }
    });

    // inbound messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages || []) {
        try {
          const fromMe = m.key?.fromMe;
          const jid = m.key?.remoteJid;
          if (fromMe || jid === 'status@broadcast') continue;

          const msg = m.message || {};
          if (
            msg.protocolMessage ||
            msg.reactionMessage ||
            msg.pollUpdateMessage ||
            msg.pollCreationMessage ||
            msg.ephemeralMessage ||
            msg.viewOnceMessage ||
            msg.viewOnceMessageV2
          ) continue;

          const loc = msg.locationMessage || null;
          let text =
            msg.conversation ||
            msg.extendedTextMessage?.text ||
            msg.imageMessage?.caption ||
            msg.videoMessage?.caption || '';
          text = (text || '').trim();
          if (!loc && !text) continue;

          if (loc) { await handleLocationMessage(jid, loc); continue; }

          await handleTextMessage(jid, text);
        } catch (e) {
          console.error('WA handle error:', e);
          try { await sendText(m.key.remoteJid, 'Sorry, something went wrong. Try again.'); } catch {}
        }
      }
    });

  } catch (err) {
    console.error('❌ Error setting up WA client:', err);
  } finally {
    initializing = false;
  }
}

const waEvents = new EventEmitter();

/* --------------- message handlers --------------- */
async function handleTextMessage(jid, raw) {
  if (!raw) return;
  const txt = (raw || '').toLowerCase();
  const state = convo.get(jid) || { stage: 'idle' };

  await upsertWaRider(jid).catch(() => {});

  const rider = await Rider.findOne({ waJid: jid }).lean().catch(() => null);
  const hasName = !!(rider?.name || waNames.get(jid));
  const hasEmail = !!rider?.email;

  if ((!hasName || !hasEmail) && (txt === '/start' || txt === 'start' || txt === 'hi' || txt === 'hello' || txt === 'menu' || state.stage === 'idle')) {
    startRegistration(jid);
    await sendText(jid, '👋 Welcome! Please enter your *full name* to register:');
    return;
  }

  if (state.stage === 'reg_name') {
    const name = raw.trim();
    if (!/^[a-z][a-z\s.'-]{1,}$/i.test(name)) {
      await sendText(jid, '❌ Please enter a valid full name (letters, spaces, . \' - ).');
      return;
    }
    waNames.set(jid, name);
    convo.set(jid, { stage: 'reg_email', temp: { name } });
    await sendText(jid, '📧 Great! Now enter your *email address*:');
    return;
  }

  if (state.stage === 'reg_email') {
    const email = raw.trim();
    if (!EMAIL_RE.test(email)) {
      await sendText(jid, '❌ Invalid email. Please enter a valid email like name@example.com');
      return;
    }
    const name = state.temp?.name || waNames.get(jid) || 'New Rider';
    await Rider.findOneAndUpdate({ waJid: jid }, { $set: { name, email, platform: 'whatsapp' } }, { upsert: true });
    await sendDashboardLinkWA(jid);
    resetFlow(jid);
    await sendText(jid, `✅ Registration complete, ${name}!`);
    await sendMainMenu(jid);
    return;
  }

  const pend = ratingAwait.get(jid);
  if (pend && /^[1-5]$/.test(txt)) {
    const stars = Number(txt);
    try {
      const ride = await Ride.findById(pend);
      if (ride && !ride.driverRating) {
        ride.driverRating = stars;
        ride.driverRatedAt = new Date();
        await ride.save();
        if (ride.driverId) { try { await Driver.computeAndUpdateStats(ride.driverId); } catch {} }
        await sendText(jid, `✅ Thanks! You rated ${'★'.repeat(stars)} (${stars}/5).`);
      } else {
        await sendText(jid, `This trip is already rated or no longer available.`);
      }
    } catch { await sendText(jid, `⚠️ Couldn't save your rating. Please try again later.`); }
    finally { ratingAwait.delete(jid); }
    return;
  }

  if (txt === '/start' || txt === 'start' || txt === 'hi' || txt === 'hello' || txt === 'menu') {
    resetFlow(jid);
    await sendMainMenu(jid);
    return;
  }

  if ((state.stage || 'idle') === 'idle') {
    if (txt === '1' || txt === 'book' || txt === 'book trip') {
      startBooking(jid);
      await sendText(jid, `📍 Send your *pickup* — share location (📎 → Location) *or type the address* and I’ll suggest matches (South Africa).`);
      return;
    }
    if (txt === '2' || txt === 'help' || txt === '/help') {
      await sendText(
        jid,
        `🤖 *How to book*\n` +
        `• Send pickup: share location (📎) *or type an address*\n` +
        `• Send destination the same way\n` +
        `• Choose vehicle → payment (cash/card)\n\n` +
        `Reply *menu* anytime to see options.`
      );
      return;
    }
    if (txt === '3' || txt === 'support') {
      await sendText(jid, `🧑‍💬 *Support*\nMessage us here or reach our Telegram help desk: https://t.me/yourSupportBot`);
      return;
    }
    if (txt === '4' || txt === 'profile' || txt === 'open profile' || txt === 'dashboard' || txt === 'open dashboard') {
      await sendDashboardLinkWA(jid);
      return;
    }
  }

  // PICKUP selection by number
  if (state.stage === 'await_pickup' && /^\d{1,2}$/.test(txt) && Array.isArray(state.suggestions) && state.suggestions.length) {
    const idx = Number(txt) - 1;
    const choice = state.suggestions[idx];
    if (!choice) { await sendText(jid, '⚠️ Invalid number. Choose one from the list or type the address again.'); return; }
    try {
      const sessionToken = ensureSessionToken(state);
      const det = await placeDetails(choice.place_id, sessionToken);
      if (!det) throw new Error('no details');
      state.pickup = { lat: det.lat, lng: det.lng };
      state.suggestions = [];
      state.stage = 'await_destination';
      convo.set(jid, state);
      await sendText(jid, `✅ Pickup set to: ${det.address}\n\n📍 Now send your *destination* — share location (📎) or type address for suggestions.`);
      return;
    } catch {
      await sendText(jid, '⚠️ Failed to fetch that place. Type the pickup address again.');
      return;
    }
  }

  // PICKUP typed → suggestions (allow acronyms & short tokens)
  if (state.stage === 'await_pickup' && raw.trim().length >= 2) {
    if (!GOOGLE_MAPS_API_KEY) { await sendText(jid, '⚠️ Address search unavailable. Please share your pickup using the 📎 attachment.'); return; }
    try {
      const sessionToken = ensureSessionToken(state);
      const sugs = await placesAutocomplete(raw, sessionToken);
      if (!sugs.length) { await sendText(jid, 'No matches found (ZA). Try another address, or share your location (📎).'); return; }
      state.suggestions = sugs;
      convo.set(jid, state);
      await sendText(jid, '📍 *Pickup suggestions (ZA):*\n' + formatSuggestionList(sugs) + '\n\nReply with the *number* of your choice or type a new address.');
      return;
    } catch {
      await sendText(jid, '⚠️ Address search failed. Please try again or share your location (📎).');
      return;
    }
  }

  // DESTINATION selection by number
  if (state.stage === 'await_destination' && /^\d{1,2}$/.test(txt) && Array.isArray(state.suggestions) && state.suggestions.length) {
    const idx = Number(txt) - 1;
    const choice = state.suggestions[idx];
    if (!choice) { await sendText(jid, '⚠️ Invalid number. Choose one from the list or type the address again.'); return; }
    try {
      const sessionToken = ensureSessionToken(state);
      const det = await placeDetails(choice.place_id, sessionToken);
      if (!det) throw new Error('no details');
      state.destination = { lat: det.lat, lng: det.lng };
      state.suggestions = [];

      let quotes = [];
      try {
        quotes = await getAvailableVehicleQuotes({ pickup: state.pickup, destination: state.destination, radiusKm: 30 });
      } catch (e) { console.error('getAvailableVehicleQuotes failed:', e); }

      if (!quotes.length) {
        state.stage = 'await_pickup';
        convo.set(jid, state);
        await sendText(jid, '😞 No drivers are currently available nearby. Please try again shortly.');
        await sendText(jid, '📍 Send your pickup again — share location (📎) or type address.');
        return;
      }
      state.quotes = quotes;
      state.stage = 'await_vehicle';
      convo.set(jid, state);

      const lines = quotes.map((q, i) => `${i + 1}) ${q.vehicleType === 'comfort' ? 'Comfort' : q.vehicleType === 'luxury' ? 'Luxury' : q.vehicleType === 'xl' ? 'XL' : 'Normal'} — R${q.price}`);
      await sendText(jid, '🚘 Select your ride:\n' + lines.join('\n') + '\n\nReply with the *number* of your choice.');
      return;
    } catch {
      await sendText(jid, '⚠️ Failed to fetch that place. Type the destination address again.');
      return;
    }
  }

  // DEST typed → suggestions
  if (state.stage === 'await_destination' && raw.trim().length >= 2) {
    if (!GOOGLE_MAPS_API_KEY) { await sendText(jid, '⚠️ Address search unavailable. Please share your destination using the 📎 attachment.'); return; }
    try {
      const sessionToken = ensureSessionToken(state);
      const sugs = await placesAutocomplete(raw, sessionToken);
      if (!sugs.length) { await sendText(jid, 'No matches found (ZA). Try another address, or share your location (📎).'); return; }
      state.suggestions = sugs;
      convo.set(jid, state);
      await sendText(jid, '📍 *Destination suggestions (ZA):*\n' + formatSuggestionList(sugs) + '\n\nReply with the *number* of your choice or type a new address.');
      return;
    } catch {
      await sendText(jid, '⚠️ Address search failed. Please try again or share your location (📎).');
      return;
    }
  }

  // VEHICLE selection (1..N)
  if (state.stage === 'await_vehicle' && /^\d{1,2}$/.test(txt)) {
    const idx = Number(txt) - 1;
    const q = state.quotes?.[idx];
    if (!q) { await sendText(jid, '⚠️ Invalid choice. Reply with a valid number from the list.'); return; }
    state.chosenVehicle = q.vehicleType;
    state.price = q.price;

    const ride = await Ride.create({
      pickup: state.pickup,
      destination: state.destination,
      estimate: q.price,
      paymentMethod: 'cash',
      vehicleType: q.vehicleType,
      status: 'payment_pending',
      platform: 'whatsapp',
      riderWaJid: jid
    });

    waRideById.set(String(ride._id), jid);
    state.rideId = String(ride._id);
    state.stage = 'await_payment';
    convo.set(jid, state);

    const label = q.vehicleType === 'comfort' ? 'Comfort' : q.vehicleType === 'luxury' ? 'Luxury' : q.vehicleType === 'xl' ? 'XL' : 'Normal';
    const summary =
      `🧾 *Trip Summary*\n` +
      `• Vehicle: ${label}\n` +
      `• Estimate: R${q.price}\n` +
      `• Pickup: (${state.pickup.lat.toFixed(5)}, ${state.pickup.lng.toFixed(5)})\n` +
      `• Drop:   (${state.destination.lat.toFixed(5)}, ${state.destination.lng.toFixed(5)})\n\n` +
      `Choose payment:\n` +
      `1) 💵 Cash\n` +
      `2) 💳 Card (PayFast)\n` +
      `Reply with *1* or *2*.`;

    await sendText(jid, summary);
    return;
  }

  // PAYMENT selection
  if (state.stage === 'await_payment') {
    if (txt === '1' || txt === 'cash') {
      const ride = await Ride.findById(state.rideId);
      if (!ride) { resetFlow(jid); await sendText(jid, '⚠️ Session expired. Type *menu* → *1* to start again.'); return; }
      ride.paymentMethod = 'cash';
      ride.status = 'pending';
      await ride.save();

      riderEvents.emit('booking:new', { rideId: String(ride._id), vehicleType: state.chosenVehicle });

      await sendText(jid, '✅ Cash selected. Requesting the nearest driver for you…');
      resetFlow(jid);
      return;
    }

    if (txt === '2' || txt === 'card' || txt === 'payfast') {
      const rideId = state.rideId;
      if (!rideId) { resetFlow(jid); await sendText(jid, '⚠️ Session expired. Type *menu* → *1* to start again.'); return; }
      const link = `${PUBLIC_URL}/pay/${encodeURIComponent(rideId)}`;
      await sendText(jid, `💳 Pay with card here:\n${link}\n\nAfter payment, we’ll notify a driver.`);
      resetFlow(jid);
      return;
    }

    await sendText(jid, 'Reply with *1* for Cash or *2* for Card.');
    return;
  }

  if (state.stage === 'await_pickup') { await sendText(jid, `📍 Please send your *pickup* — share location (📎) or type the address for suggestions.`); return; }
  if (state.stage === 'await_destination') { await sendText(jid, `📍 Please send your *destination* — share location (📎) or type the address for suggestions.`); return; }

  if ((convo.get(jid)?.stage || 'idle') === 'idle') {
    await sendMainMenu(jid);
  }
}

async function handleLocationMessage(jid, locationMessage) {
  const lat = locationMessage.degreesLatitude;
  const lng = locationMessage.degreesLongitude;

  await upsertWaRider(jid, { lastLocation: { lat, lng } }).catch(() => {});
  const state = convo.get(jid) || { stage: 'idle' };

  if (state.stage === 'idle') { startBooking(jid); state.stage = 'await_pickup'; }

  if (state.stage === 'await_pickup') {
    state.pickup = { lat, lng };
    state.suggestions = [];
    state.stage = 'await_destination';
    convo.set(jid, state);
    await sendText(jid, '✅ Pickup saved.\n\n📍 Now send your *destination* — share location (📎) or type address for suggestions.');
    return;
  }

  if (state.stage === 'await_destination') {
    state.destination = { lat, lng };
    state.suggestions = [];

    let quotes = [];
    try {
      quotes = await getAvailableVehicleQuotes({ pickup: state.pickup, destination: state.destination, radiusKm: 30 });
    } catch (e) { console.error('getAvailableVehicleQuotes failed:', e); }

    if (!quotes.length) {
      state.stage = 'await_pickup';
      convo.set(jid, state);
      await sendText(jid, '😞 No drivers are currently available nearby. Please try again shortly.');
      await sendText(jid, '📍 Send your pickup again — share location (📎) or type address.');
      return;
    }

    state.quotes = quotes;
    state.stage = 'await_vehicle';
    convo.set(jid, state);

    const lines = quotes.map((q, i) => `${i + 1}) ${q.vehicleType === 'comfort' ? 'Comfort' : q.vehicleType === 'luxury' ? 'Luxury' : q.vehicleType === 'xl' ? 'XL' : 'Normal'} — R${q.price}`);
    await sendText(jid, '🚘 Select your ride:\n' + lines.join('\n') + '\n\nReply with the *number* of your choice.');
    return;
  }
}

/* --------------- Driver → WA rider notifications --------------- */
driverEvents.on('ride:accepted', async ({ rideId }) => {
  const jid = await getWaJidForRideId(rideId);
  if (!jid) return;
  const link = `${PUBLIC_URL}/track.html?rideId=${encodeURIComponent(rideId)}`;
  try { await sendText(jid, `🚗 Your ride is on the way. Track here:\n${link}`); } catch {}
});

driverEvents.on('ride:arrived', async ({ rideId }) => {
  const jid = await getWaJidForRideId(rideId);
  if (!jid) return;
  try { await sendText(jid, '📍 Your driver has arrived at the pickup point.'); } catch {}
});

driverEvents.on('ride:started', async ({ rideId }) => {
  const jid = await getWaJidForRideId(rideId);
  if (!jid) return;
  try { await sendText(jid, '▶️ Your trip has started. Enjoy the ride!'); } catch {}
});

driverEvents.on('ride:cancelled', async ({ ride }) => {
  const jid = ride?.riderWaJid || (ride?._id ? await getWaJidForRideId(ride._id) : null);
  if (!jid) return;
  try { await sendText(jid, '❌ The driver cancelled the trip. Please try booking again.'); } catch {}
});

/* ------------ exported WA rating notifier ------------ */
export async function notifyWhatsAppRiderToRate(ride) {
  try {
    const jid = ride?.riderWaJid || (ride?._id ? (await Ride.findById(ride._id).select('riderWaJid').lean())?.riderWaJid : null);
    if (!jid) return;
    ratingAwait.set(jid, String(ride._id));
    await sendText(
      jid,
      '🧾 Your trip is complete.\nPlease rate your driver: reply with a number from *1* (worst) to *5* (best).'
    );
  } catch (e) {
    console.warn('notifyWhatsAppRiderToRate failed:', e?.message || e);
  }
}

/* ------------ public API ------------ */
export function initWhatsappBot() {
  if (sock || initializing) {
    console.log('WhatsApp Bot already initialized');
    return;
  }
  console.log('🚀 Initializing WhatsApp Bot...');
  setupClient();
}

export function isWhatsAppConnected() { return !!(sock && sock.ws && sock.ws.readyState === 1); }
export function getConnectionStatus() { return connState; }

export async function waitForQrDataUrl(timeoutMs = 25000) {
  if (currentQR) return qrcode.toDataURL(currentQR);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for QR')), timeoutMs);
    waEvents.once('qr', (dataUrl) => { clearTimeout(t); resolve(dataUrl); });
  });
}

export async function sendWhatsAppMessage(jid, text) { return sendText(jid, text); }

export async function resetWhatsAppSession() {
  try {
    if (sock) {
      try { await sock.logout(); } catch {}
      try { sock.end?.(); } catch {}
      sock = null;
    }
    purgeAuthFolder();
    currentQR = null;
    connState = 'disconnected';
  } finally {
    setupClient();
  }
}
