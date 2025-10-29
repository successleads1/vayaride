// src/bots/whatsappBot.js
// VayaRide – WhatsApp Rider Bot (Baileys / ESM)
// Number-first UX everywhere (menus, confirmations, choices)
// Feature parity with Telegram rider bot:
// - First-time registration (name → email → phone infer/prompt)
// - Main menu (Book / Prebook / Profile / Support / Driver)
// - Address entry via text (Google Places, ZA-scoped) or location share
// - Confirm/correct pickup & destination with numeric options
// - Quotes via pricing.getAvailableVehicleQuotes → vehicle select
// - Payment select (Cash / PayFast) BEFORE driver assignment
// - Secure dashboard link (token + 4-digit PIN, 10-minute expiry)
// - Prebooking flow with scheduled date-time capture
// - Live tracking link after driver accepts; arrived/started/cancelled notices
// - Ratings flow (1–5)
// - Referral code capture on first text (ref/REFCODE)
// - Dedupe layer to prevent double sends
// - Robust reconnect, auth purge on bad session, QR broadcasting + PNG snapshot
// - Public tolerant send API (phone or JID)

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

// Events bus shared with other parts of the system
import { riderEvents } from './riderBot.js';
import { driverEvents } from './driverBot.js';

// Quotes / pricing
import { getAvailableVehicleQuotes } from '../services/pricing.js';

// Optional mail
import {
  sendAdminEmailToDrivers,
  sendRiderWelcomeEmail,
  sendAdminNewRiderAlert
} from '../services/mailer.js';

/* ────────────────────────────────────────────────────────────────────────────
   Paths / ENV
──────────────────────────────────────────────────────────────────────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(process.cwd());
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const AUTH_DIR = process.env.WA_AUTH_DIR
  ? path.resolve(process.env.WA_AUTH_DIR)
  : path.resolve(ROOT_DIR, 'baileys_auth_info');

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const GOOGLE_MAPS_API_KEY = (process.env.GOOGLE_MAPS_API_KEY || '').trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || 'admin@vayaride.co.za').trim();

/* ────────────────────────────────────────────────────────────────────────────
   ZA-only parameters / tuning
──────────────────────────────────────────────────────────────────────────── */
const GMAPS_COMPONENTS = process.env.GOOGLE_MAPS_COMPONENTS || 'country:za';
const GMAPS_LANGUAGE = process.env.GOOGLE_MAPS_LANGUAGE || 'en-ZA';
const GMAPS_REGION = process.env.GOOGLE_MAPS_REGION || 'za';
const ZA_CENTER = { lat: -28.4793, lng: 24.6727 };
const ZA_RADIUS_M = 1_500_000;

/* ────────────────────────────────────────────────────────────────────────────
   Phone normalization
──────────────────────────────────────────────────────────────────────────── */
const DEFAULT_CC = (process.env.DEFAULT_COUNTRY_CODE || '27').replace(/^\+/, '');
function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('0')) s = DEFAULT_CC + s.slice(1);
  if (!/^\d{8,15}$/.test(s)) return null;
  return `+${s}`;
}
function phoneFromJid(jid) {
  const core = String(jid || '').split('@')[0];
  return normalizePhone(core);
}
function isJid(str) {
  return /@(s\.whatsapp\.net|g\.us|broadcast)$/.test(String(str || ''));
}
function jidFromPhone(phoneLike) {
  const norm = normalizePhone(phoneLike);
  if (!norm) return null;
  const digits = norm.replace(/[^\d]/g, '');
  return `${digits}@s.whatsapp.net`;
}

/* ────────────────────────────────────────────────────────────────────────────
   State
──────────────────────────────────────────────────────────────────────────── */
let sock = null;
let initializing = false;
let currentQR = null;
let connState = 'disconnected';

const waNames = new Map();       // jid -> name (pre-save during reg)
const waRideById = new Map();    // rideId -> jid (cache)

const convo = new Map();         // jid -> flow state
const ratingAwait = new Map();   // jid -> rideId
const pendingRefByJid = new Map(); // jid -> referral code

/* ────────────────────────────────────────────────────────────────────────────
   Regex / helpers
──────────────────────────────────────────────────────────────────────────── */
const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
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
function parseReferralFromText(t = '') {
  const s = String(t).trim();
  const m = /\bref(?:erral)?[\s_:=-]*([A-Z0-9]{4,12})\b/i.exec(s);
  return m ? m[1].toUpperCase() : null;
}
const VEHICLE_LABEL = (t) =>
  t === 'comfort' ? 'Comfort' :
  t === 'luxury'  ? 'Luxury'  :
  t === 'xl'      ? 'XL'      : 'Normal';

/* ────────────────────────────────────────────────────────────────────────────
   Logger
──────────────────────────────────────────────────────────────────────────── */
const logger = pino({ level: process.env.WA_LOG_LEVEL || 'info' });

/* ────────────────────────────────────────────────────────────────────────────
   QR helpers
──────────────────────────────────────────────────────────────────────────── */
async function saveQrPng(dataUrl) {
  try {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const file = path.join(PUBLIC_DIR, 'wa-qr.png');
    fs.writeFileSync(file, base64, 'base64');
  } catch (e) {
    logger.warn('WA: failed to save wa-qr.png: %s', e?.message || e);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Auth helpers
──────────────────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────────────────────
   Dedupe layer (avoid double sends)
──────────────────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────────────────────
   Public tolerant sender (Admin)
──────────────────────────────────────────────────────────────────────────── */
export async function sendWhatsAppTo(target, text) {
  if (!sock) throw new Error('WA client not ready');
  const jid = isJid(target) ? String(target) : jidFromPhone(target);
  if (!jid) throw new Error('Invalid JID/phone for WhatsApp');
  return sendText(jid, text);
}

/* ────────────────────────────────────────────────────────────────────────────
   Tokens / PINs
──────────────────────────────────────────────────────────────────────────── */
function generatePIN() { return Math.floor(1000 + Math.random() * 9000).toString(); }
function generateToken() { return crypto.randomBytes(24).toString('hex'); }

/* ────────────────────────────────────────────────────────────────────────────
   Conversation helpers (states)
──────────────────────────────────────────────────────────────────────────── */
/*
State shape (per jid):
{
  stage: 'idle' |
         'reg_name' | 'reg_email' | 'reg_phone' |
         'booking_pickup' | 'booking_pickup_confirm' |
         'booking_destination' | 'booking_destination_confirm' |
         'review_trip' | 'await_vehicle' | 'await_payment' |
         'prebook_pickup' | 'prebook_pickup_confirm' |
         'prebook_destination' | 'prebook_destination_confirm' |
         'prebook_when' | 'prebook_review' | 'prebook_await_vehicle' | 'prebook_await_payment',
  pickup, destination,
  suggestions: [],
  chosenVehicle, price,
  quotes: [],
  rideId,
  prebook: { scheduledAt?: Date }
}
*/
function resetFlow(jid) { convo.set(jid, { stage: 'idle' }); }
function startBooking(jid) { convo.set(jid, { stage: 'booking_pickup' }); }
function startPrebook(jid) { convo.set(jid, { stage: 'prebook_pickup', prebook: {} }); }

/* ────────────────────────────────────────────────────────────────────────────
   Rider upsert / phone ensure
──────────────────────────────────────────────────────────────────────────── */
async function upsertWaRider(jid, { name = null, lastLocation = null } = {}) {
  const set = { lastSeenAt: new Date(), platform: 'whatsapp' };
  if (name) set.name = name;
  if (lastLocation) set.lastLocation = { ...lastLocation, ts: new Date() };

  const auto = phoneFromJid(jid);
  const setOnInsert = { waJid: jid, platform: 'whatsapp' };
  if (auto) { setOnInsert.phone = auto; setOnInsert.msisdn = auto; }

  await Rider.findOneAndUpdate(
    { waJid: jid },
    { $set: set, $setOnInsert: setOnInsert },
    { upsert: true }
  );
}

async function ensurePhonePresence({ jid, rider = null, state = null } = {}) {
  try {
    const r = rider || await Rider.findOne({ waJid: jid }).lean();
    const existing = r?.phone || r?.msisdn;
    if (existing) return 'ok';

    const inferred = phoneFromJid(jid);
    if (inferred) {
      await Rider.findOneAndUpdate(
        { waJid: jid },
        { $set: { phone: inferred, msisdn: inferred, platform: 'whatsapp' } },
        { upsert: true }
      );
      return 'autofilled';
    }

    const prev = state?.stage || 'idle';
    convo.set(jid, { ...(state || {}), stage: 'reg_phone', _returnTo: prev });
    await sendText(
      jid,
      `📱 Please reply with your *mobile number* in international format (e.g. +27XXXXXXXXX).\n` +
      `We’ll save it so your driver can contact you if needed.`
    );
    return 'prompted';
  } catch {
    return 'ok';
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Dashboard link (token + PIN)
──────────────────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────────────────────
   Google Places (ZA-scoped)
──────────────────────────────────────────────────────────────────────────── */
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
    components: GMAPS_COMPONENTS,
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
  if (!data?.result?.geometry?.location) return null;
  const loc = data.result.geometry.location;
  return { lat: Number(loc.lat), lng: Number(loc.lng), address: data.result.formatted_address || data.result.name || '' };
}
function formatSuggestionList(sugs) {
  if (!sugs?.length) return '';
  return sugs.map((s, i) => `${i + 1}) ${s.description}`).join('\n');
}

/* ────────────────────────────────────────────────────────────────────────────
   Support email trigger
──────────────────────────────────────────────────────────────────────────── */
async function triggerSupportEmail({ jid, rider, context = 'WhatsApp support menu' }) {
  try {
    const subject = 'WhatsApp Support Request — VayaRide';
    const html =
      `<p>A user reached the support entry on WhatsApp.</p>
       <ul>
         <li><strong>Platform:</strong> WhatsApp</li>
         <li><strong>JID:</strong> ${jid}</li>
         <li><strong>Name:</strong> ${rider?.name || '—'}</li>
         <li><strong>Email:</strong> ${rider?.email || '—'}</li>
         <li><strong>When:</strong> ${new Date().toLocaleString()}</li>
         <li><strong>Context:</strong> ${context}</li>
       </ul>`;
    await sendAdminEmailToDrivers(SUPPORT_EMAIL, { subject, html });
  } catch (e) {
    logger.warn('Support email trigger failed: %s', e?.message || e);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   WA Client setup
──────────────────────────────────────────────────────────────────────────── */
const waEvents = new EventEmitter();

async function setupClient() {
  if (initializing) return;
  initializing = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

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
          try { console.log('\n' + (await qrcode.toString(qr, { type: 'terminal', small: true }))); }
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

    // Inbound messages
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

          // Capture referral code from early texts
          const maybeCode = parseReferralFromText(text);
          if (maybeCode) pendingRefByJid.set(jid, maybeCode);

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

/* ────────────────────────────────────────────────────────────────────────────
   Helpers
──────────────────────────────────────────────────────────────────────────── */
function vtLabel(t) { return VEHICLE_LABEL(t); }
function carPretty(driver) {
  const chunks = [];
  if (driver?.vehicleName) chunks.push(driver.vehicleName);
  else {
    const mm = [driver?.vehicleMake, driver?.vehicleModel].filter(Boolean).join(' ');
    if (mm) chunks.push(mm);
  }
  if (driver?.vehicleColor) chunks.push(`(${driver.vehicleColor})`);
  return chunks.join(' ').trim();
}
const toMap = ({ lat, lng }) => `https://maps.google.com/?q=${lat},${lng}`;

/* ────────────────────────────────────────────────────────────────────────────
   Message Handlers – TEXT (NUMBER-FIRST UX)
──────────────────────────────────────────────────────────────────────────── */
function isYes(numOrText) {
  const s = String(numOrText).trim().toLowerCase();
  return s === '1' || ['yes','y','ok','okay','confirm'].includes(s);
}
function isNo(numOrText) {
  const s = String(numOrText).trim().toLowerCase();
  return s === '2' || ['no','n','change','edit','correct'].includes(s);
}

async function handleTextMessage(jid, raw) {
  if (!raw) return;
  const txt = (raw || '').trim();
  const lc = txt.toLowerCase();
  let state = convo.get(jid) || { stage: 'idle' };

  // Ensure rider record exists
  await upsertWaRider(jid).catch(() => {});
  const rider = await Rider.findOne({ waJid: jid }).lean().catch(() => null);
  const hasName = !!(rider?.name || waNames.get(jid));
  const hasEmail = !!rider?.email;

  // If not in name/email steps, ensure phone first
  if (state.stage !== 'reg_name' && state.stage !== 'reg_email') {
    const ensured = await ensurePhonePresence({ jid, rider, state });
    if (ensured === 'prompted') return;
  }

  // Accept phone in reg_phone stage
  if (state.stage === 'reg_phone') {
    const phone = normalizePhone(txt);
    if (!phone) {
      await sendText(jid, '❌ Please send a valid phone number like *+27XXXXXXXXX*.');
      return;
    }
    await Rider.findOneAndUpdate(
      { waJid: jid },
      { $set: { phone, msisdn: phone, platform: 'whatsapp' } },
      { upsert: true }
    );
    const prev = state._returnTo || 'idle';
    convo.set(jid, { stage: prev });
    await sendText(jid, `✅ Saved your number: ${phone}`);
    if (prev === 'idle') await sendMainMenu(jid);
    return;
  }

  // Quick driver links
  if (lc === '/driver' || lc === 'driver') {
    await sendText(jid, `🧑‍✈️ *Driver Status*\nCheck your status or log in to your dashboard:\n${PUBLIC_URL}/driver`);
    return;
  }
  if (lc === '/driver/register' || lc === 'driver register') {
    await sendText(jid, `📝 *Driver Registration*\nRegister here:\n${PUBLIC_URL}/driver/register`);
    return;
  }

  // First time / greetings → registration
  if ((!hasName || !hasEmail) &&
      (['/start','start','hi','hello','menu','1','2','3','4','5'].includes(lc) || state.stage === 'idle')) {
    convo.set(jid, { stage: 'reg_name', temp: {} });
    await sendText(jid, '👋 Welcome! Please enter your *full name* to register:');
    return;
  }

  // Registration: name
  if (state.stage === 'reg_name') {
    const name = txt;
    if (!/^[a-z][a-z\s.'-]{1,}$/i.test(name)) {
      await sendText(jid, '❌ Please enter a valid full name (letters, spaces, . \' - ).');
      return;
    }
    waNames.set(jid, name);
    convo.set(jid, { stage: 'reg_email', temp: { name } });
    await sendText(jid, '📧 Great! Now enter your *email address* (e.g. name@example.com):');
    return;
  }

  // Registration: email
  if (state.stage === 'reg_email') {
    if (!EMAIL_RE.test(txt)) {
      await sendText(jid, '❌ Invalid email. Please enter a valid email like name@example.com');
      return;
    }
    const name = state.temp?.name || waNames.get(jid) || 'New Rider';
    await Rider.findOneAndUpdate(
      { waJid: jid },
      { $set: { name, email: txt, platform: 'whatsapp' } },
      { upsert: true }
    );

    // Referral apply if pending
    try {
      const fresh = await Rider.findOne({ waJid: jid }).select('_id').lean();
      const pending = pendingRefByJid.get(jid);
      if (fresh?._id && pending) {
        const referrer = await Rider.findOne({ referralCode: pending }).lean();
        if (referrer?._id) {
          await Rider.updateOne(
            { _id: referrer._id },
            {
              $inc: { 'referralStats.registrations': 1 },
              $set: {
                nextDiscountPct: 0.2,
                nextDiscountExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000)
              }
            }
          );
          await Rider.updateOne({ _id: fresh._id }, { $set: { referredBy: referrer._id } });
        }
      }
    } catch {}
    pendingRefByJid.delete(jid);

    await sendDashboardLinkWA(jid);
    resetFlow(jid);
    await sendText(jid, `✅ Registration complete, ${name}!`);

    // Best-effort emails
    try { await sendRiderWelcomeEmail(txt, { name }); } catch {}
    try {
      await sendAdminNewRiderAlert({
        name,
        email: txt,
        platform: 'WhatsApp',
        createdAt: new Date(),
        dashboardUrl: `${PUBLIC_URL}/admin/riders`
      });
    } catch {}

    const ensured = await ensurePhonePresence({ jid, state: convo.get(jid) });
    if (ensured === 'prompted') return;

    await sendMainMenu(jid);
    return;
  }

  // Ratings quick path (1–5)
  const pendingRate = ratingAwait.get(jid);
  if (pendingRate && /^[1-5]$/.test(lc)) {
    const stars = Number(lc);
    try {
      const ride = await Ride.findById(pendingRate);
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

  // Global menu aliases
  if (['/start','start','hi','hello','menu'].includes(lc)) {
    resetFlow(jid);
    await sendMainMenu(jid);
    return;
  }

  // MAIN MENU (idle)
  if ((state.stage || 'idle') === 'idle') {
    if (['1','book','book trip'].includes(lc)) {
      startBooking(jid);
      await sendText(jid,
        `📍 Send your *pickup*.\n` +
        `• Share location (📎 → Location), or\n` +
        `• Type the pickup address (ZA-only suggestions)`
      );
      return;
    }
    if (['2','prebook','prebook trip','pre-book','pre book'].includes(lc)) {
      startPrebook(jid);
      await sendText(jid,
        `🗓️ *Prebook a trip*\n` +
        `First, send your *pickup* (share location or type address).`
      );
      return;
    }
    if (['3','help','/help'].includes(lc)) {
      await sendText(
        jid,
        `🤖 *How to book*\n` +
        `• Send pickup (share location or type address)\n` +
        `• Send destination the same way\n` +
        `• Choose vehicle → choose payment (cash/card)\n\n` +
        `Reply *menu* anytime to see options.`
      );
      return;
    }
    if (['4','profile','open profile','dashboard','open dashboard'].includes(lc)) {
      await sendDashboardLinkWA(jid);
      return;
    }
    if (['5','driver',"i am a driver","i’m a driver"].includes(lc)) {
      convo.set(jid, { stage: 'driver_menu' });
      await sendText(
        jid,
        `🧑‍✈️ *Driver Portal*\n` +
        `1) Register (new driver)\n` +
        `2) Dashboard / Status (existing)\n` +
        `Reply with *1* or *2*.`
      );
      return;
    }
  }

  // DRIVER SUB-MENU (numbers only, with word fallback)
  if (state.stage === 'driver_menu') {
    if (lc === '1' || lc === 'no' || lc === 'not registered') {
      await sendText(jid, `📝 *Driver Registration*\nRegister here:\n${PUBLIC_URL}/driver/register`);
      resetFlow(jid);
      await sendMainMenu(jid);
      return;
    }
    if (lc === '2' || lc === 'yes' || lc === 'i am registered') {
      await sendText(jid, `🔐 *Driver Dashboard / Status*\nLog in here:\n${PUBLIC_URL}/driver`);
      resetFlow(jid);
      await sendMainMenu(jid);
      return;
    }
    await sendText(jid, `Please reply with *1* (register) or *2* (dashboard).`);
    return;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // BOOKING FLOW – PICKUP
  // ────────────────────────────────────────────────────────────────────────────
  if (state.stage === 'booking_pickup' && txt.length >= 2) {
    if (!GOOGLE_MAPS_API_KEY) {
      await sendText(jid, '⚠️ Address search unavailable. Please share your pickup using the 📎 attachment.');
      return;
    }
    const sessionToken = ensureSessionToken(state);
    const sugs = await placesAutocomplete(txt, sessionToken).catch(() => []);
    if (!sugs.length) {
      await sendText(jid, 'No matches found (ZA). Try another address, or share your location (📎).');
      return;
    }
    state.suggestions = sugs;
    state.stage = 'booking_pickup';
    convo.set(jid, state);
    await sendText(
      jid,
      '📍 *Pickup suggestions (ZA):*\n' +
      formatSuggestionList(sugs) +
      '\n\nReply with the *number* of your choice, or type a new address.'
    );
    return;
  }

  // PICKUP choose by number
  if (state.stage === 'booking_pickup' && /^\d{1,2}$/.test(lc) && Array.isArray(state.suggestions) && state.suggestions.length) {
    const idx = Number(lc) - 1;
    const choice = state.suggestions[idx];
    if (!choice) { await sendText(jid, '⚠️ Invalid number. Choose one from the list or type the address again.'); return; }
    try {
      const sessionToken = ensureSessionToken(state);
      const det = await placeDetails(choice.place_id, sessionToken);
      if (!det) throw new Error('no details');
      state.pickup = { lat: det.lat, lng: det.lng, address: det.address };
      state.suggestions = [];
      state.stage = 'booking_pickup_confirm';
      convo.set(jid, state);
      await sendText(
        jid,
        `📍 Pickup set to:\n${det.address}\n\n` +
        `Confirm pickup:\n` +
        `1) Confirm\n` +
        `2) Change\n` +
        `Reply with *1* or *2*.`
      );
      return;
    } catch {
      await sendText(jid, '⚠️ Failed to fetch that place. Type the pickup address again.');
      return;
    }
  }

  // Confirm/correct pickup (1 confirm, 2 change)
  if (state.stage === 'booking_pickup_confirm') {
    if (isYes(lc)) {
      state.stage = 'booking_destination';
      convo.set(jid, state);
      await sendText(jid, `🎯 Now send your *destination* — share location (📎) or type address for suggestions.`);
      return;
    }
    if (isNo(lc)) {
      state.stage = 'booking_pickup';
      state.pickup = undefined;
      state.suggestions = [];
      convo.set(jid, state);
      await sendText(jid, `✏️ Okay, send your *pickup* again (location or type address).`);
      return;
    }
    await sendText(jid, `Choose:\n1) Confirm\n2) Change`);
    return;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // BOOKING FLOW – DESTINATION
  // ────────────────────────────────────────────────────────────────────────────
  if (state.stage === 'booking_destination' && txt.length >= 2) {
    if (!GOOGLE_MAPS_API_KEY) {
      await sendText(jid, '⚠️ Address search unavailable. Please share your destination using the 📎 attachment.');
      return;
    }
    const sessionToken = ensureSessionToken(state);
    const sugs = await placesAutocomplete(txt, sessionToken).catch(() => []);
    if (!sugs.length) {
      await sendText(jid, 'No matches found (ZA). Try another address, or share your location (📎).');
      return;
    }
    state.suggestions = sugs;
    convo.set(jid, state);
    await sendText(
      jid,
      '🎯 *Destination suggestions (ZA):*\n' +
      formatSuggestionList(sugs) +
      '\n\nReply with the *number* of your choice, or type a new address.'
    );
    return;
  }

  // DEST choose by number
  if (state.stage === 'booking_destination' && /^\d{1,2}$/.test(lc) && Array.isArray(state.suggestions) && state.suggestions.length) {
    const idx = Number(lc) - 1;
    const choice = state.suggestions[idx];
    if (!choice) { await sendText(jid, '⚠️ Invalid number. Choose one from the list or type the address again.'); return; }
    try {
      const sessionToken = ensureSessionToken(state);
      const det = await placeDetails(choice.place_id, sessionToken);
      if (!det) throw new Error('no details');
      state.destination = { lat: det.lat, lng: det.lng, address: det.address };
      state.suggestions = [];
      state.stage = 'booking_destination_confirm';
      convo.set(jid, state);
      await sendText(
        jid,
        `🎯 Destination set to:\n${det.address}\n\n` +
        `Confirm destination:\n` +
        `1) Confirm\n` +
        `2) Change\n` +
        `Reply with *1* or *2*.`
      );
      return;
    } catch {
      await sendText(jid, '⚠️ Failed to fetch that place. Type the destination address again.');
      return;
    }
  }

  // Confirm/correct destination (1 confirm, 2 change)
  if (state.stage === 'booking_destination_confirm') {
    if (isYes(lc)) {
      // Review trip
      state.stage = 'review_trip';
      convo.set(jid, state);
      const p = state.pickup?.address || `${state.pickup?.lat?.toFixed(5)}, ${state.pickup?.lng?.toFixed(5)}`;
      const d = state.destination?.address || `${state.destination?.lat?.toFixed(5)}, ${state.destination?.lng?.toFixed(5)}`;
      await sendText(
        jid,
        `🧭 *Review trip*\n` +
        `• Pickup: ${p}\n` +
        `• Destination: ${d}\n\n` +
        `Choose:\n` +
        `1) Proceed\n` +
        `2) Fix pickup\n` +
        `3) Fix destination\n` +
        `4) Cancel\n` +
        `Reply with *1–4*.`
      );
      return;
    }
    if (isNo(lc)) {
      state.stage = 'booking_destination';
      state.destination = undefined;
      state.suggestions = [];
      convo.set(jid, state);
      await sendText(jid, `✏️ Okay, send your *destination* again (location or type address).`);
      return;
    }
    await sendText(jid, `Choose:\n1) Confirm\n2) Change`);
    return;
  }

  // Review actions (1 proceed, 2 fix pickup, 3 fix drop, 4 cancel)
  if (state.stage === 'review_trip') {
    if (lc === '2' || lc === 'fix pickup') {
      state.stage = 'booking_pickup';
      state.pickup = undefined;
      state.suggestions = [];
      convo.set(jid, state);
      await sendText(jid, `✏️ Okay, send your *pickup* again (location or type address).`);
      return;
    }
    if (lc === '3' || lc === 'fix drop' || lc === 'fix destination') {
      state.stage = 'booking_destination';
      state.destination = undefined;
      state.suggestions = [];
      convo.set(jid, state);
      await sendText(jid, `✏️ Okay, send your *destination* again (location or type address).`);
      return;
    }
    if (lc === '4' || lc === 'cancel') {
      resetFlow(jid);
      await sendText(jid, `❌ Booking cancelled.`);
      await sendMainMenu(jid);
      return;
    }
    if (lc === '1' || lc === 'proceed') {
      try {
        const quotes = await getAvailableVehicleQuotes({
          pickup: state.pickup,
          destination: state.destination,
          radiusKm: 30,
        }).catch(() => []);
        if (!quotes.length) {
          state.stage = 'booking_pickup';
          convo.set(jid, state);
          await sendText(jid, '🚘 No drivers are currently available nearby. Please try again shortly.');
          await sendText(jid, '📍 Send your pickup again — share location (📎) or type address.');
          return;
        }
        state.quotes = quotes;
        state.stage = 'await_vehicle';
        convo.set(jid, state);

        const lines = quotes.map((q, i) =>
          `${i + 1}) ${vtLabel(q.vehicleType)} — R${q.price}${q.driverCount ? ` (drivers: ${q.driverCount})` : ''}`
        );
        await sendText(
          jid,
          '🚘 Select your ride (based on nearby drivers and live pricing):\n' +
          lines.join('\n') +
          '\n\nReply with the *number* of your choice.'
        );
        return;
      } catch {
        await sendText(jid, '⚠️ Could not fetch quotes right now. Please try again.');
        return;
      }
    }
    await sendText(jid, `Reply with *1–4*:\n1) Proceed  2) Fix pickup  3) Fix destination  4) Cancel`);
    return;
  }

  // Vehicle select (numbers)
  if (state.stage === 'await_vehicle' && /^\d{1,2}$/.test(lc)) {
    const idx = Number(lc) - 1;
    const q = state.quotes?.[idx];
    if (!q) { await sendText(jid, '⚠️ Invalid choice. Reply with a valid number from the list.'); return; }
    state.chosenVehicle = q.vehicleType;
    state.price = q.price;

    // Create ride in "payment_pending" – driver assignment after payment choice
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

    const label = vtLabel(q.vehicleType);
    const summary =
      `🧾 *Trip Summary*\n` +
      `• Vehicle: ${label}\n` +
      `• Estimate: R${q.price}\n` +
      `• Pickup: ${state.pickup?.address || `(${state.pickup.lat.toFixed(5)}, ${state.pickup.lng.toFixed(5)})`}\n` +
      `• Drop:   ${state.destination?.address || `(${state.destination.lat.toFixed(5)}, ${state.destination.lng.toFixed(5)})`}\n\n` +
      `Choose payment:\n` +
      `1) 💵 Cash\n` +
      `2) 💳 Card (PayFast)\n` +
      `Reply with *1* or *2*.`;

    await sendText(jid, summary);
    return;
  }

  // Payment choice (1 cash, 2 card)
  if (state.stage === 'await_payment') {
    if (lc === '1' || lc === 'cash') {
      const ride = await Ride.findById(state.rideId);
      if (!ride) { resetFlow(jid); await sendText(jid, '⚠️ Session expired. Type *menu* → *1* to start again.'); return; }
      ride.paymentMethod = 'cash';
      ride.status = 'pending'; // driver can now be assigned
      await ride.save();

      // Emit to assignment flow (driver will see accept/ignore)
      riderEvents.emit('booking:new', { rideId: String(ride._id), vehicleType: state.chosenVehicle });
      await sendText(jid, '✅ Cash selected. Requesting the nearest driver for you…');
      resetFlow(jid);
      return;
    }

    if (lc === '2' || lc === 'card' || lc === 'payfast') {
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

  // ────────────────────────────────────────────────────────────────────────────
  // PREBOOK FLOW (scheduled)
  // ────────────────────────────────────────────────────────────────────────────
  if (state.stage === 'prebook_pickup' && txt.length >= 2) {
    if (!GOOGLE_MAPS_API_KEY) { await sendText(jid, '⚠️ Address search unavailable. Please share your pickup using the 📎 attachment.'); return; }
    const sessionToken = ensureSessionToken(state);
    const sugs = await placesAutocomplete(txt, sessionToken).catch(() => []);
    if (!sugs.length) { await sendText(jid, 'No matches found (ZA). Try another address, or share your location (📎).'); return; }
    state.suggestions = sugs;
    convo.set(jid, state);
    await sendText(
      jid,
      '📍 *Pickup suggestions (ZA):*\n' + formatSuggestionList(sugs) +
      '\n\nReply with the *number* of your choice, or type a new address.'
    );
    return;
  }
  if (state.stage === 'prebook_pickup' && /^\d{1,2}$/.test(lc) && state.suggestions?.length) {
    const idx = Number(lc) - 1;
    const choice = state.suggestions[idx];
    if (!choice) { await sendText(jid, '⚠️ Invalid number.'); return; }
    try {
      const sessionToken = ensureSessionToken(state);
      const det = await placeDetails(choice.place_id, sessionToken);
      if (!det) throw new Error('no details');
      state.pickup = { lat: det.lat, lng: det.lng, address: det.address };
      state.suggestions = [];
      state.stage = 'prebook_pickup_confirm';
      convo.set(jid, state);
      await sendText(
        jid,
        `📍 Pickup set:\n${det.address}\n\n` +
        `Confirm pickup:\n` +
        `1) Confirm\n` +
        `2) Change\n` +
        `Reply with *1* or *2*.`
      );
      return;
    } catch {
      await sendText(jid, '⚠️ Failed to fetch that place. Type the pickup address again.');
      return;
    }
  }
  if (state.stage === 'prebook_pickup_confirm') {
    if (isYes(lc)) {
      state.stage = 'prebook_destination';
      convo.set(jid, state);
      await sendText(jid, `🎯 Now send your *destination* (location or type address).`);
      return;
    }
    if (isNo(lc)) {
      state.stage = 'prebook_pickup';
      state.pickup = undefined;
      state.suggestions = [];
      convo.set(jid, state);
      await sendText(jid, `✏️ Send your pickup again.`);
      return;
    }
    await sendText(jid, `Choose:\n1) Confirm\n2) Change`);
    return;
  }

  if (state.stage === 'prebook_destination' && txt.length >= 2) {
    if (!GOOGLE_MAPS_API_KEY) { await sendText(jid, '⚠️ Address search unavailable. Please share your destination using the 📎 attachment.'); return; }
    const sessionToken = ensureSessionToken(state);
    const sugs = await placesAutocomplete(txt, sessionToken).catch(() => []);
    if (!sugs.length) { await sendText(jid, 'No matches found (ZA). Try another address, or share your location (📎).'); return; }
    state.suggestions = sugs;
    convo.set(jid, state);
    await sendText(
      jid,
      '🎯 *Destination suggestions (ZA):*\n' + formatSuggestionList(sugs) +
      '\n\nReply with the *number* of your choice, or type a new address.'
    );
    return;
  }
  if (state.stage === 'prebook_destination' && /^\d{1,2}$/.test(lc) && state.suggestions?.length) {
    const idx = Number(lc) - 1;
    const choice = state.suggestions[idx];
    if (!choice) { await sendText(jid, '⚠️ Invalid number.'); return; }
    try {
      const sessionToken = ensureSessionToken(state);
      const det = await placeDetails(choice.place_id, sessionToken);
      if (!det) throw new Error('no details');
      state.destination = { lat: det.lat, lng: det.lng, address: det.address };
      state.suggestions = [];
      state.stage = 'prebook_destination_confirm';
      convo.set(jid, state);
      await sendText(
        jid,
        `🎯 Destination set:\n${det.address}\n\n` +
        `Confirm destination:\n` +
        `1) Confirm\n` +
        `2) Change\n` +
        `Reply with *1* or *2*.`
      );
      return;
    } catch {
      await sendText(jid, '⚠️ Failed to fetch that place. Type the destination address again.');
      return;
    }
  }
  if (state.stage === 'prebook_destination_confirm') {
    if (isYes(lc)) {
      state.stage = 'prebook_when';
      convo.set(jid, state);
      await sendText(jid, `🗓️ When? Reply with *YYYY-MM-DD HH:MM* (24h, local time). Example: 2025-10-30 08:30`);
      return;
    }
    if (isNo(lc)) {
      state.stage = 'prebook_destination';
      state.destination = undefined;
      state.suggestions = [];
      convo.set(jid, state);
      await sendText(jid, `✏️ Send your destination again.`);
      return;
    }
    await sendText(jid, `Choose:\n1) Confirm\n2) Change`);
    return;
  }

  if (state.stage === 'prebook_when') {
    // Very simple parser for "YYYY-MM-DD HH:MM"
    const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/.exec(txt);
    if (!m) {
      await sendText(jid, `❌ Please use format *YYYY-MM-DD HH:MM* (24h). Example: 2025-10-30 08:30`);
      return;
    }
    const [_, Y, M, D, h, mnt] = m.map(Number);
    const scheduledAt = new Date(Y, M - 1, D, h, mnt);
    if (isNaN(scheduledAt.getTime()) || scheduledAt < new Date()) {
      await sendText(jid, `❌ Please provide a valid *future* date & time.`);
      return;
    }
    state.prebook = { ...(state.prebook || {}), scheduledAt };
    state.stage = 'prebook_review';
    convo.set(jid, state);

    await sendText(
      jid,
      `🧭 *Review prebook*\n` +
      `• Pickup: ${state.pickup?.address}\n` +
      `• Destination: ${state.destination?.address}\n` +
      `• When: ${scheduledAt.toLocaleString()}\n\n` +
      `Choose:\n` +
      `1) Proceed\n` +
      `2) Fix pickup\n` +
      `3) Fix destination\n` +
      `4) Change time\n` +
      `5) Cancel\n` +
      `Reply with *1–5*.`
    );
    return;
  }

  if (state.stage === 'prebook_review') {
    if (lc === '2' || lc === 'fix pickup') {
      state.stage = 'prebook_pickup';
      state.pickup = undefined;
      state.suggestions = [];
      convo.set(jid, state);
      await sendText(jid, `✏️ Send your *pickup* again.`);
      return;
    }
    if (lc === '3' || lc === 'fix drop' || lc === 'fix destination') {
      state.stage = 'prebook_destination';
      state.destination = undefined;
      state.suggestions = [];
      convo.set(jid, state);
      await sendText(jid, `✏️ Send your *destination* again.`);
      return;
    }
    if (lc === '4' || lc === 'change time') {
      state.stage = 'prebook_when';
      convo.set(jid, state);
      await sendText(jid, `🗓️ Reply with *YYYY-MM-DD HH:MM* (24h).`);
      return;
    }
    if (lc === '5' || lc === 'cancel') {
      resetFlow(jid);
      await sendText(jid, `❌ Prebooking cancelled.`);
      await sendMainMenu(jid);
      return;
    }
    if (lc === '1' || lc === 'proceed') {
      try {
        const quotes = await getAvailableVehicleQuotes({
          pickup: state.pickup,
          destination: state.destination,
          radiusKm: 30,
        }).catch(() => []);
        if (!quotes.length) {
          state.stage = 'prebook_pickup';
          convo.set(jid, state);
          await sendText(jid, '🚘 No drivers are currently available for quoting now. Please try again later.');
          await sendText(jid, '📍 Send your pickup again — share location (📎) or type address.');
          return;
        }
        state.quotes = quotes;
        state.stage = 'prebook_await_vehicle';
        convo.set(jid, state);

        const lines = quotes.map((q, i) =>
          `${i + 1}) ${vtLabel(q.vehicleType)} — R${q.price}${q.driverCount ? ` (drivers: ${q.driverCount})` : ''}`
        );
        await sendText(
          jid,
          '🚘 Select your ride for the *scheduled* trip:\n' +
          lines.join('\n') +
          '\n\nReply with the *number* of your choice.'
        );
        return;
      } catch {
        await sendText(jid, '⚠️ Could not fetch quotes right now. Please try again.');
        return;
      }
    }
    await sendText(jid, `Reply with *1–5*:\n1) Proceed  2) Fix pickup  3) Fix destination  4) Change time  5) Cancel`);
    return;
  }

  if (state.stage === 'prebook_await_vehicle' && /^\d{1,2}$/.test(lc)) {
    const idx = Number(lc) - 1;
    const q = state.quotes?.[idx];
    if (!q) { await sendText(jid, '⚠️ Invalid choice. Reply with a valid number from the list.'); return; }
    state.chosenVehicle = q.vehicleType;
    state.price = q.price;

    // Create scheduled ride (status "scheduled" until the time approaches; you can have a cron to activate)
    const ride = await Ride.create({
      pickup: state.pickup,
      destination: state.destination,
      estimate: q.price,
      paymentMethod: 'cash',
      vehicleType: q.vehicleType,
      status: 'scheduled',
      scheduledAt: state.prebook?.scheduledAt,
      platform: 'whatsapp',
      riderWaJid: jid
    });

    waRideById.set(String(ride._id), jid);
    state.rideId = String(ride._id);
    state.stage = 'prebook_await_payment';
    convo.set(jid, state);

    const label = vtLabel(q.vehicleType);
    const summary =
      `🧾 *Scheduled Trip Summary*\n` +
      `• Vehicle: ${label}\n` +
      `• Estimate: R${q.price}\n` +
      `• When: ${state.prebook?.scheduledAt?.toLocaleString()}\n` +
      `• Pickup: ${state.pickup?.address}\n` +
      `• Drop:   ${state.destination?.address}\n\n` +
      `Choose payment:\n` +
      `1) 💵 Cash (pay to driver)\n` +
      `2) 💳 Card (PayFast)\n` +
      `Reply with *1* or *2*.`;

    await sendText(jid, summary);
    return;
  }

  if (state.stage === 'prebook_await_payment') {
    if (lc === '1' || lc === 'cash') {
      const ride = await Ride.findById(state.rideId);
      if (!ride) { resetFlow(jid); await sendText(jid, '⚠️ Session expired. Type *menu* to start again.'); return; }
      ride.paymentMethod = 'cash';
      await ride.save();
      await sendText(jid, '✅ Cash selected. Your trip is scheduled. We’ll assign a driver near the time.');
      resetFlow(jid);
      return;
    }
    if (lc === '2' || lc === 'card' || lc === 'payfast') {
      const rideId = state.rideId;
      if (!rideId) { resetFlow(jid); await sendText(jid, '⚠️ Session expired. Type *menu* to start again.'); return; }
      const link = `${PUBLIC_URL}/pay/${encodeURIComponent(rideId)}`;
      await sendText(jid, `💳 Pay with card here:\n${link}\n\nWe’ll assign a driver near the scheduled time.`);
      resetFlow(jid);
      return;
    }
    await sendText(jid, 'Reply with *1* for Cash or *2* for Card.');
    return;
  }

  // Hints if user is stuck within stages
  if (state.stage === 'booking_pickup')  { await sendText(jid, `📍 Please send your *pickup* — share location (📎) or type the address for suggestions.`); return; }
  if (state.stage === 'booking_destination') { await sendText(jid, `📍 Please send your *destination* — share location (📎) or type the address for suggestions.`); return; }
  if (state.stage === 'prebook_pickup')  { await sendText(jid, `🗓️ Please send your *pickup* — share location (📎) or type the address for suggestions.`); return; }
  if (state.stage === 'prebook_destination') { await sendText(jid, `🗓️ Please send your *destination* — share location (📎) or type the address for suggestions.`); return; }

  // Fallback to menu
  if ((convo.get(jid)?.stage || 'idle') === 'idle') {
    await sendMainMenu(jid);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Message Handlers – LOCATION
──────────────────────────────────────────────────────────────────────────── */
async function handleLocationMessage(jid, locationMessage) {
  const lat = locationMessage.degreesLatitude;
  const lng = locationMessage.degreesLongitude;

  await upsertWaRider(jid, { lastLocation: { lat, lng } }).catch(() => {});

  let state = convo.get(jid) || { stage: 'idle' };
  const ensured = await ensurePhonePresence({ jid, state });
  if (ensured === 'prompted') return;

  // If idle, assume booking flow pickup
  if (state.stage === 'idle') { startBooking(jid); state = convo.get(jid); }

  // Booking pickup via location
  if (state.stage === 'booking_pickup') {
    state.pickup = { lat, lng, address: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
    state.suggestions = [];
    state.stage = 'booking_pickup_confirm';
    convo.set(jid, state);
    await sendText(
      jid,
      `📍 Pickup received.\n\n` +
      `Confirm pickup:\n` +
      `1) Confirm\n` +
      `2) Change\n` +
      `Reply with *1* or *2*.`
    );
    return;
  }

  // Booking destination via location
  if (state.stage === 'booking_destination') {
    state.destination = { lat, lng, address: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
    state.suggestions = [];
    state.stage = 'booking_destination_confirm';
    convo.set(jid, state);
    await sendText(
      jid,
      `🎯 Destination received.\n\n` +
      `Confirm destination:\n` +
      `1) Confirm\n` +
      `2) Change\n` +
      `Reply with *1* or *2*.`
    );
    return;
  }

  // Prebook pickup via location
  if (state.stage === 'prebook_pickup') {
    state.pickup = { lat, lng, address: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
    state.suggestions = [];
    state.stage = 'prebook_pickup_confirm';
    convo.set(jid, state);
    await sendText(
      jid,
      `📍 Pickup received for prebook.\n\n` +
      `Confirm pickup:\n` +
      `1) Confirm\n` +
      `2) Change\n` +
      `Reply with *1* or *2*.`
    );
    return;
  }

  // Prebook destination via location
  if (state.stage === 'prebook_destination') {
    state.destination = { lat, lng, address: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
    state.suggestions = [];
    state.stage = 'prebook_destination_confirm';
    convo.set(jid, state);
    await sendText(
      jid,
      `🎯 Destination received for prebook.\n\n` +
      `Confirm destination:\n` +
      `1) Confirm\n` +
      `2) Change\n` +
      `Reply with *1* or *2*.`
    );
    return;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Driver → Rider notifications
──────────────────────────────────────────────────────────────────────────── */
driverEvents.on('ride:accepted', async ({ rideId }) => {
  const jid = await getWaJidForRideId(rideId);
  if (!jid) return;

  let ride = null;
  let driver = null;
  try {
    ride = await Ride.findById(rideId).lean();
    if (ride?.driverId) driver = await Driver.findById(ride.driverId).lean();
  } catch {}

  const liveLink = `${PUBLIC_URL}/track.html?rideId=${encodeURIComponent(rideId)}`;
  const pickupLink = ride?.pickup ? toMap(ride.pickup) : null;
  const dropLink   = ride?.destination ? toMap(ride.destination) : null;

  const dName   = driver?.name || 'Your driver';
  const dType   = vtLabel(driver?.vehicleType);
  const dPlate  = driver?.vehiclePlate || '—';
  const dCar    = carPretty(driver) || 'Vehicle';
  const dPhone  = driver?.phone || '—';
  const rating  = (typeof driver?.stats?.avgRating === 'number')
    ? `${Number(driver.stats.avgRating).toFixed(1)}★${typeof driver.stats.ratingsCount === 'number' ? ` (${driver.stats.ratingsCount})` : ''}`
    : null;
  const trips   = (typeof driver?.stats?.totalTrips === 'number') ? `${driver.stats.totalTrips} trips` : null;

  const lines = [
    '🚗 *Driver assigned*',
    `• Name: ${dName}${rating ? ` — ${rating}` : ''}${trips ? ` · ${trips}` : ''}`,
    `• Car: ${dCar} — ${dType}`,
    `• Plate: ${dPlate}`,
    `• Call/Text: ${dPhone}`,
  ];

  if (driver?.location && typeof driver.location.lat === 'number' && typeof driver.location.lng === 'number') {
    lines.push(`• Driver location: ${toMap(driver.location)}`);
  }
  if (pickupLink) lines.push(`• Pickup map: ${pickupLink}`);
  if (dropLink)   lines.push(`• Drop map: ${dropLink}`);

  lines.push('');
  lines.push(`🗺️ Track live: ${liveLink}`);

  try { await sendText(jid, lines.join('\n')); } catch {}
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

/* ────────────────────────────────────────────────────────────────────────────
   Resolve WA JID by rideId
──────────────────────────────────────────────────────────────────────────── */
async function getWaJidForRideId(rideId) {
  const cached = waRideById.get(String(rideId));
  if (cached) return cached;
  try {
    const r = await Ride.findById(rideId).select('riderWaJid').lean();
    return r?.riderWaJid || null;
  } catch { return null; }
}

/* ────────────────────────────────────────────────────────────────────────────
   Public rating notifier
──────────────────────────────────────────────────────────────────────────── */
export async function notifyWhatsAppRiderToRate(rideOrId) {
  try {
    let ride = rideOrId;
    if (!ride || !ride._id) {
      ride = await Ride.findById(rideOrId).lean();
    }
    if (!ride || !ride._id) return;

    let jid = ride.riderWaJid || await getWaJidForRideId(ride._id);
    if (!jid) return;

    ratingAwait.set(jid, String(ride._id));
    await sendText(
      jid,
      '🧾 Your trip is complete.\nPlease rate your driver: reply with a number from *1* (worst) to *5* (best).'
    );
  } catch (e) {
    logger.warn('notifyWhatsAppRiderToRate failed: %s', e?.message || e);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Main menu sender
──────────────────────────────────────────────────────────────────────────── */
function sendMainMenu(jid) {
  return sendText(
    jid,
    `👋 *Welcome to VayaRide!*\n` +
    `Please reply with a number:\n\n` +
    `1) 🚕 Book Trip\n` +
    `2) 🗓️ Prebook Trip\n` +
    `3) ❓ Help\n` +
    `4) 👤 Profile\n` +
    `5) 🚗 I am a Driver`
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Lifecycle exports
──────────────────────────────────────────────────────────────────────────── */
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

export { waEvents };
