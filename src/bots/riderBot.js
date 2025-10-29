// src/bots/whatsappBot.js
// WhatsApp Rider Bot (Baileys / ESM) — parity with Telegram rider flow
// Features:
// - First-time registration (name → email → ensure phone)
// - Main menu: Book now, Help, Support, Profile, Driver, Prebook Trip
// - ZA-scoped address entry via text or location share (Google Places)
// - Quotes → vehicle select → payment select (Cash or PayFast) BEFORE driver assignment
// - After payment choice (both Cash & PayFast): create ride, emit booking, broadcast to drivers
// - Secure dashboard link (token + 4-digit PIN, 10-minute expiry)
// - Live tracking link after driver accepts; arrival/started/cancelled notifications
// - Ratings flow (1–5) after trip completion
// - Referral code capture on first inbound message (ref/REFCODE)
// - Dedupe layer to prevent double sends
// - Robust reconnect, auth purge on bad session, QR broadcasting + PNG snapshot
// - Safe public send API (phone or JID)
// - Prebooking flow: pickup → destination → when → review (edit pickup/destination) → quotes → payment

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
// NOTE: we also import notifyDriverNewRequest so WA rider can broadcast to Telegram drivers like Telegram rider does.
import { riderEvents } from './riderBot.js';
import { driverEvents, notifyDriverNewRequest } from './driverBot.js';

// ✅ real quote engine (cheapest per vehicleType with live availability)
import { getAvailableVehicleQuotes } from '../services/pricing.js';

// Mailers (non-fatal if they fail)
import {
  sendAdminEmailToDrivers,
  sendRiderWelcomeEmail,
  sendAdminNewRiderAlert
} from '../services/mailer.js';

/* --------------- Paths / ENV --------------- */
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

/* ---------- ZA-only parameters / tuning ---------- */
const GMAPS_COMPONENTS = process.env.GOOGLE_MAPS_COMPONENTS || 'country:za';
const GMAPS_LANGUAGE = process.env.GOOGLE_MAPS_LANGUAGE || 'en-ZA';
const GMAPS_REGION = process.env.GOOGLE_MAPS_REGION || 'za';
const ZA_CENTER = { lat: -28.4793, lng: 24.6727 };
const ZA_RADIUS_M = 1_500_000;

/* ---------- Phone normalization ---------- */
const DEFAULT_CC = (process.env.DEFAULT_COUNTRY_CODE || '27').replace(/^\+/, ''); // e.g. "27"
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

/* --------------- State --------------- */
let sock = null;
let initializing = false;
let currentQR = null;
let connState = 'disconnected';

const waNames = new Map();       // jid -> name (pre-save during reg)
const waRideById = new Map();    // rideId -> jid (cache)

const convo = new Map();         // jid -> { stage, ... }
const ratingAwait = new Map();   // jid -> rideId
const pendingRefByJid = new Map(); // jid -> referral code (until registration saved)

/* ---------- Regex / helpers ---------- */
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

/* --------------- Logger --------------- */
const logger = pino({ level: process.env.WA_LOG_LEVEL || 'info' });

/* --------------- QR helpers --------------- */
async function saveQrPng(dataUrl) {
  try {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const file = path.join(PUBLIC_DIR, 'wa-qr.png');
    fs.writeFileSync(file, base64, 'base64');
  } catch (e) {
    logger.warn('WA: failed to save wa-qr.png: %s', e?.message || e);
  }
}

/* --------------- Auth helpers --------------- */
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

/* --------------- Dedupe layer --------------- */
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

/* --------------- Public tolerant sender (Admin) --------------- */
export async function sendWhatsAppTo(target, text) {
  if (!sock) throw new Error('WA client not ready');
  const jid = isJid(target) ? String(target) : jidFromPhone(target);
  if (!jid) throw new Error('Invalid JID/phone for WhatsApp');
  return sendText(jid, text);
}

/* --------------- Tokens / PINs --------------- */
function generatePIN() { return Math.floor(1000 + Math.random() * 9000).toString(); }
function generateToken() { return crypto.randomBytes(24).toString('hex'); }

/* --------------- Conversation helpers --------------- */
function resetFlow(jid) { convo.set(jid, { stage: 'idle' }); }
function startBooking(jid) { convo.set(jid, { stage: 'await_pickup' }); }
function startRegistration(jid) { convo.set(jid, { stage: 'reg_name', temp: {} }); }
function startDriverMenu(jid) { convo.set(jid, { stage: 'driver_menu' }); }

/* --------------- Rider upsert / phone ensure --------------- */
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

/* --------------- Dashboard link (token + PIN) --------------- */
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

/* --------------- Google Places (ZA-scoped) --------------- */
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

/* --------------- Review + Date helpers --------------- */
function addrPretty(pt) {
  if (!pt) return '—';
  if (pt.address) return pt.address;
  return `(${Number(pt.lat).toFixed(5)}, ${Number(pt.lng).toFixed(5)})`;
}
function vehicleLabel(t) {
  if (t === 'comfort') return 'Comfort';
  if (t === 'luxury')  return 'Luxury';
  if (t === 'xl')      return 'XL';
  return 'Normal';
}
function printTripReview({ pickup, destination, when = null }) {
  const lines = [
    '🧭 *Review Trip*',
    `• Pickup: ${addrPretty(pickup)}`,
    `• Destination: ${addrPretty(destination)}`
  ];
  if (when) lines.push(`• When: ${new Date(when).toLocaleString('en-ZA')}`);
  lines.push('');
  lines.push('Type: *continue*  |  *edit pickup*  |  *edit destination*  |  *cancel*');
  return lines.join('\n');
}

/**
 * Best-effort ZA date/time parsing.
 * Accepts examples like:
 *  - 2025-10-31 14:30
 *  - 31/10/2025 2pm
 *  - tomorrow 09:00
 *  - friday 18:15
 */
function parseZAWhen(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();

  // Simple keywords
  const now = new Date();
  const base = new Date(now);
  if (s.startsWith('tomorrow')) {
    base.setDate(base.getDate() + 1);
    const time = s.replace('tomorrow', '').trim();
    if (time) {
      const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(time);
      if (m) {
        let hh = Number(m[1]);
        const mm = Number(m[2] || 0);
        const ampm = (m[3] || '').toLowerCase();
        if (ampm === 'pm' && hh < 12) hh += 12;
        if (ampm === 'am' && hh === 12) hh = 0;
        base.setHours(hh, mm, 0, 0);
      } else {
        base.setHours(9, 0, 0, 0);
      }
    } else {
      base.setHours(9, 0, 0, 0);
    }
    return base;
  }

  // Weekday names
  const weekdays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const wd = weekdays.findIndex(w => s.startsWith(w));
  if (wd >= 0) {
    const target = new Date(now);
    const delta = (wd - now.getDay() + 7) % 7 || 7; // next occurrence
    target.setDate(now.getDate() + delta);
    const tail = s.replace(weekdays[wd], '').trim();
    if (tail) {
      const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(tail);
      if (m) {
        let hh = Number(m[1]);
        const mm = Number(m[2] || 0);
        const ampm = (m[3] || '').toLowerCase();
        if (ampm === 'pm' && hh < 12) hh += 12;
        if (ampm === 'am' && hh === 12) hh = 0;
        target.setHours(hh, mm, 0, 0);
      } else {
        target.setHours(9, 0, 0, 0);
      }
    } else {
      target.setHours(9, 0, 0, 0);
    }
    return target;
  }

  // Try common numeric formats
  // 1) ISO-ish
  let dt = Date.parse(s);
  if (!isNaN(dt)) return new Date(dt);

  // 2) DD/MM/YYYY HH:mm
  const m1 = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\s+(\d{1,2}):(\d{2})/.exec(s);
  if (m1) {
    const [ , dd, mm, yyyy, hh, min ] = m1.map(Number);
    const y = yyyy < 100 ? 2000 + yyyy : yyyy;
    const d = new Date(y, mm - 1, dd, hh, min, 0, 0);
    return d;
  }
  // 3) DD/MM HH:mm (assume current year)
  const m2 = /(\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(s);
  if (m2) {
    const [ , dd, mm, hh, min ] = m2.map(Number);
    const d = new Date(now.getFullYear(), mm - 1, dd, hh, min, 0, 0);
    return d;
  }

  return null;
}

function isTimeInFuture(d) {
  if (!(d instanceof Date)) return false;
  return d.getTime() > Date.now() + 10 * 60 * 1000; // at least 10 minutes from now
}

/* --------------- Support email trigger --------------- */
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

/* --------------- WA Client setup --------------- */
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

    // Inbound messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of (messages || [])) {
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

/* --------------- Driver broadcast (parity with Telegram rider) --------------- */
async function broadcastToDrivers(ride) {
  try {
    const drivers = await Driver.find({
      status: 'approved',
      chatId: { $exists: true, $ne: null },     // Telegram driver chatId
      ...(ride.vehicleType ? { vehicleType: ride.vehicleType } : {})
    }).select('chatId').limit(1000).lean();

    for (const d of drivers) {
      try {
        await notifyDriverNewRequest({ chatId: Number(d.chatId), ride });
      } catch (e) {
        console.warn('notifyDriverNewRequest failed for driver', d.chatId, e?.message || e);
      }
    }
  } catch (e) {
    console.warn('broadcastToDrivers failed:', e?.message || e);
  }
}

/* --------------- Message Handlers --------------- */
async function handleTextMessage(jid, raw) {
  if (!raw) return;
  const txt = (raw || '').toLowerCase();
  const state = convo.get(jid) || { stage: 'idle' };

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
  if ((convo.get(jid)?.stage) === 'reg_phone') {
    const phone = normalizePhone(raw);
    if (!phone) {
      await sendText(jid, '❌ Please send a valid phone number like *+27XXXXXXXXX*.');
      return;
    }
    await Rider.findOneAndUpdate(
      { waJid: jid },
      { $set: { phone, msisdn: phone, platform: 'whatsapp' } },
      { upsert: true }
    );
    const prev = (convo.get(jid) || {})._returnTo || 'idle';
    convo.set(jid, { stage: prev });
    await sendText(jid, `✅ Saved your number: ${phone}`);
    if (prev === 'idle') await sendMainMenu(jid);
    return;
  }

  // Quick driver links
  if (txt === '/driver' || txt === 'driver') {
    await sendText(jid, `🧑‍✈️ *Driver Status*\nCheck your status or log in to your dashboard:\n${PUBLIC_URL}/driver`);
    return;
  }
  if (txt === '/driver/register' || txt === 'driver register') {
    await sendText(jid, `📝 *Driver Registration*\nRegister here:\n${PUBLIC_URL}/driver/register`);
    return;
  }

  // First time / greetings → registration
  if ((!hasName || !hasEmail) && (txt === '/start' || txt === 'start' || txt === 'hi' || txt === 'hello' || txt === 'menu' || state.stage === 'idle')) {
    startRegistration(jid);
    await sendText(jid, '👋 Welcome! Please enter your *full name* to register:');
    return;
  }

  // Registration: name
  if (state.stage === 'reg_name') {
    const name = raw.trim();
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
    const email = raw.trim();
    if (!EMAIL_RE.test(email)) {
      await sendText(jid, '❌ Invalid email. Please enter a valid email like name@example.com');
      return;
    }
    const name = state.temp?.name || waNames.get(jid) || 'New Rider';

    await Rider.findOneAndUpdate(
      { waJid: jid },
      { $set: { name, email, platform: 'whatsapp' } },
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

    // Non-fatal best-effort emails
    try { await sendRiderWelcomeEmail(email, { name }); } catch {}
    try {
      await sendAdminNewRiderAlert({
        name,
        email,
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

  // Ratings quick path
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

  // Menu aliases
  if (txt === '/start' || txt === 'start' || txt === 'hi' || txt === 'hello' || txt === 'menu') {
    resetFlow(jid);
    await sendMainMenu(jid);
    return;
  }

  // Idle menu actions
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
      await sendText(jid, `🧑‍💼 *Support*\nEmail us at: ${SUPPORT_EMAIL}\nWe’ve also sent a note to our team — they’ll reach out if needed.`);
      try {
        const r = await Rider.findOne({ waJid: jid }).lean().catch(() => null);
        await triggerSupportEmail({ jid, rider: r, context: 'User selected Support (3)' });
      } catch {}
      return;
    }
    if (txt === '4' || txt === 'profile' || txt === 'open profile' || txt === 'dashboard' || txt === 'open dashboard') {
      await sendDashboardLinkWA(jid);
      return;
    }
    if (txt === '5' || txt === 'driver' || txt === 'i am a driver' || txt === 'i’m a driver') {
      startDriverMenu(jid);
      await sendText(
        jid,
        `🧑‍✈️ *Driver Portal*\n` +
        `Are you already registered as a driver?\n\n` +
        `1) No, not registered — show me the registration link\n` +
        `2) Yes, I’m registered — take me to the dashboard/status`
      );
      return;
    }
    if (txt === '6' || txt === 'prebook' || txt === 'prebook trip' || txt === '/prebook') {
      convo.set(jid, { stage: 'pre_pickup' });
      await sendText(
        jid,
        `🗓️ *Prebook a Trip*\n` +
        `Send your *pickup* — share location (📎 → Location) or type the address (South Africa).`
      );
      return;
    }
  }

  // Driver sub-menu
  if (state.stage === 'driver_menu') {
    if (txt === '1' || txt === 'no' || txt === 'not registered') {
      await sendText(jid, `📝 *Driver Registration*\nRegister here:\n${PUBLIC_URL}/driver/register`);
      resetFlow(jid);
      await sendMainMenu(jid);
      return;
    }
    if (txt === '2' || txt === 'yes' || txt === 'i am registered') {
      await sendText(jid, `🔐 *Driver Dashboard / Status*\nLog in here:\n${PUBLIC_URL}/driver`);
      resetFlow(jid);
      await sendMainMenu(jid);
      return;
    }
    await sendText(jid, `Please reply with *1* (register) or *2* (dashboard).`);
    return;
  }

  /* ========= NOW BOOKING (INSTANT) FLOW ========= */

  // PICKUP choose by number (from suggestions)
  if (state.stage === 'await_pickup' && /^\d{1,2}$/.test(txt) && Array.isArray(state.suggestions) && state.suggestions.length) {
    const idx = Number(txt) - 1;
    const choice = state.suggestions[idx];
    if (!choice) { await sendText(jid, '⚠️ Invalid number. Choose one from the list or type the address again.'); return; }
    try {
      const sessionToken = ensureSessionToken(state);
      const det = await placeDetails(choice.place_id, sessionToken);
      if (!det) throw new Error('no details');
      state.pickup = { lat: det.lat, lng: det.lng, address: det.address };
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

  // PICKUP typed → suggestions
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

  // DEST choose by number
  if (state.stage === 'await_destination' && /^\d{1,2}$/.test(txt) && Array.isArray(state.suggestions) && state.suggestions.length) {
    const idx = Number(txt) - 1;
    const choice = state.suggestions[idx];
    if (!choice) { await sendText(jid, '⚠️ Invalid number. Choose one from the list or type the address again.'); return; }
    try {
      const sessionToken = ensureSessionToken(state);
      const det = await placeDetails(choice.place_id, sessionToken);
      if (!det) throw new Error('no details');
      state.destination = { lat: det.lat, lng: det.lng, address: det.address };
      state.suggestions = [];

      let quotes = [];
      try { quotes = await getAvailableVehicleQuotes({ pickup: state.pickup, destination: state.destination, radiusKm: 30 }); } catch {}

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

      const lines = quotes.map((q, i) => `${i + 1}) ${vehicleLabel(q.vehicleType)} — R${q.price}${q.driverCount ? ` (drivers: ${q.driverCount})` : ''}`);
      await sendText(jid, '🚘 Select your ride (live pricing):\n' + lines.join('\n') + '\n\nReply with the *number* of your choice.');
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

  // Vehicle select
  if (state.stage === 'await_vehicle' && /^\d{1,2}$/.test(txt)) {
    const idx = Number(txt) - 1;
    const q = state.quotes?.[idx];
    if (!q) { await sendText(jid, '⚠️ Invalid choice. Reply with a valid number from the list.'); return; }
    state.chosenVehicle = q.vehicleType;
    state.price = q.price;

    // No ride creation yet — wait for payment choice like Telegram UI
    state.stage = 'await_payment';
    convo.set(jid, state);

    const label = vehicleLabel(q.vehicleType);

    const summary =
      `🧾 *Trip Summary*\n` +
      `• Vehicle: ${label}\n` +
      `• Estimate: R${q.price}\n` +
      `• Pickup: ${addrPretty(state.pickup)}\n` +
      `• Drop:   ${addrPretty(state.destination)}\n\n` +
      `Choose payment:\n` +
      `1) 💵 Cash\n` +
      `2) 💳 Card (PayFast)\n` +
      `Reply with *1* or *2*.`;

    await sendText(jid, summary);
    return;
  }

  // Payment choice (PARITY: both Cash and PayFast create ride and fan out to drivers)
  if (state.stage === 'await_payment') {
    const isCash = (txt === '1' || txt === 'cash');
    const isCard = (txt === '2' || txt === 'card' || txt === 'payfast');

    if (!isCash && !isCard) {
      await sendText(jid, 'Reply with *1* for Cash or *2* for Card.');
      return;
    }

    if (!state.pickup || !state.destination || !state.chosenVehicle || typeof state.price !== 'number') {
      resetFlow(jid);
      await sendText(jid, '⚠️ Session expired. Type *menu* → *1* to start again.');
      return;
    }

    // Create the ride now (Telegram parity): status 'pending' (assignment can proceed)
    let ride = null;
    try {
      ride = await Ride.create({
        pickup: state.pickup,
        destination: state.destination,
        estimate: state.price,
        paymentMethod: isCash ? 'cash' : 'payfast',
        vehicleType: state.chosenVehicle,
        status: 'pending',
        platform: 'whatsapp',
        riderWaJid: jid,
        createdAt: new Date()
      });
      waRideById.set(String(ride._id), jid);
    } catch (e) {
      await sendText(jid, '⚠️ Could not create the ride. Please try again.');
      resetFlow(jid);
      return;
    }

    // Fan out: assignment event + broadcast to driver bot (Telegram)
    try {
      riderEvents.emit('booking:new', { rideId: String(ride._id), vehicleType: state.chosenVehicle });
      await broadcastToDrivers(ride);
    } catch {}

    if (isCard) {
      const link = `${PUBLIC_URL}/pay/${encodeURIComponent(String(ride._id))}`;
      await sendText(jid, `💳 Pay with card here:\n${link}\n\nWe’re notifying drivers while you complete payment.`);
    } else {
      await sendText(jid, '✅ Cash selected. Requesting the nearest driver for you…');
    }

    resetFlow(jid);
    return;
  }

  /* ========= PREBOOKING FLOW ========= */

  // PREBOOK: PICKUP typed → suggestions
  if (state.stage === 'pre_pickup' && raw.trim().length >= 2) {
    if (!GOOGLE_MAPS_API_KEY) { await sendText(jid, '⚠️ Address search unavailable. Please share pickup via 📎.'); return; }
    try {
      const sessionToken = ensureSessionToken(state);
      const sugs = await placesAutocomplete(raw, sessionToken);
      if (!sugs.length) { await sendText(jid, 'No matches (ZA). Try another address or share location (📎).'); return; }
      state.suggestions = sugs;
      convo.set(jid, state);
      await sendText(jid, '📍 *Pickup suggestions (ZA):*\n' + formatSuggestionList(sugs) + '\n\nReply with the *number* of your choice or type a new address.');
      return;
    } catch {
      await sendText(jid, '⚠️ Address search failed. Try again or share your location (📎).');
      return;
    }
  }

  // PREBOOK: PICKUP choose by number
  if (state.stage === 'pre_pickup' && /^\d{1,2}$/.test(txt) && Array.isArray(state.suggestions) && state.suggestions.length) {
    const idx = Number(txt) - 1;
    const choice = state.suggestions[idx];
    if (!choice) { await sendText(jid, '⚠️ Invalid number. Choose one from the list or type the address again.'); return; }
    try {
      const sessionToken = ensureSessionToken(state);
      const det = await placeDetails(choice.place_id, sessionToken);
      if (!det) throw new Error('no details');
      state.pickup = { lat: det.lat, lng: det.lng, address: det.address };
      state.suggestions = [];
      state.stage = 'pre_destination';
      convo.set(jid, state);
      await sendText(jid, `✅ Pickup set to: ${det.address}\n\n🎯 Now send your *destination* — share location (📎) or type address for suggestions.`);
      return;
    } catch {
      await sendText(jid, '⚠️ Failed to fetch that place. Type the pickup address again.');
      return;
    }
  }

  // PREBOOK: DEST typed → suggestions
  if (state.stage === 'pre_destination' && raw.trim().length >= 2) {
    if (!GOOGLE_MAPS_API_KEY) { await sendText(jid, '⚠️ Address search unavailable. Please share destination via 📎.'); return; }
    try {
      const sessionToken = ensureSessionToken(state);
      const sugs = await placesAutocomplete(raw, sessionToken);
      if (!sugs.length) { await sendText(jid, 'No matches (ZA). Try another address or share location (📎).'); return; }
      state.suggestions = sugs;
      convo.set(jid, state);
      await sendText(jid, '🎯 *Destination suggestions (ZA):*\n' + formatSuggestionList(sugs) + '\n\nReply with the *number* of your choice or type a new address.');
      return;
    } catch {
      await sendText(jid, '⚠️ Address search failed. Try again or share your location (📎).');
      return;
    }
  }

  // PREBOOK: DEST choose by number → ask WHEN
  if (state.stage === 'pre_destination' && /^\d{1,2}$/.test(txt) && Array.isArray(state.suggestions) && state.suggestions.length) {
    const idx = Number(txt) - 1;
    const choice = state.suggestions[idx];
    if (!choice) { await sendText(jid, '⚠️ Invalid number. Choose one from the list or type the address again.'); return; }
    try {
      const sessionToken = ensureSessionToken(state);
      const det = await placeDetails(choice.place_id, sessionToken);
      if (!det) throw new Error('no details');
      state.destination = { lat: det.lat, lng: det.lng, address: det.address };
      state.suggestions = [];
      state.stage = 'pre_when';
      convo.set(jid, state);
      await sendText(
        jid,
        `🗓️ When do you need the ride?\nExamples:\n• 2025-10-31 14:30\n• 31/10/2025 2pm\n• tomorrow 09:00\n• friday 18:15`
      );
      return;
    } catch {
      await sendText(jid, '⚠️ Failed to fetch that place. Type the destination address again.');
      return;
    }
  }

  // PREBOOK: WHEN input
  if (state.stage === 'pre_when') {
    const when = parseZAWhen(raw);
    if (!when || !isTimeInFuture(when)) {
      await sendText(jid, '❌ Please send a valid future time (e.g., "tomorrow 09:00" or "2025-10-31 14:30").');
      return;
    }
    state.when = when;
    state.stage = 'pre_review';
    convo.set(jid, state);
    await sendText(jid, printTripReview({ pickup: state.pickup, destination: state.destination, when }));
    return;
  }

  // PREBOOK: REVIEW edit / continue / cancel
  if (state.stage === 'pre_review') {
    if (txt === 'edit pickup' || txt === 'fix pickup' || txt === 'correct pickup') {
      state.stage = 'pre_pickup';
      delete state.pickup;
      delete state.suggestions;
      convo.set(jid, state);
      await sendText(jid, '✏️ Send the *new pickup* — share location (📎) or type address.');
      return;
    }
    if (txt === 'edit destination' || txt === 'fix destination' || txt === 'correct destination') {
      state.stage = 'pre_destination';
      delete state.destination;
      delete state.suggestions;
      convo.set(jid, state);
      await sendText(jid, '✏️ Send the *new destination* — share location (📎) or type address.');
      return;
    }
    if (txt === 'cancel') {
      resetFlow(jid);
      await sendText(jid, '❌ Prebooking cancelled.');
      await sendMainMenu(jid);
      return;
    }
    if (txt === 'continue') {
      // fetch quotes (same as instant)
      let quotes = [];
      try { quotes = await getAvailableVehicleQuotes({ pickup: state.pickup, destination: state.destination, radiusKm: 30 }); } catch {}
      if (!quotes.length) {
        await sendText(jid, '😞 No drivers are available for that route right now. You can still set the prebooking; a driver will be notified closer to the time.');
        // proceed with vehicle selection using placeholder list so rider can choose type for scheduling
        quotes = [
          { vehicleType: 'normal', price: 0 },
          { vehicleType: 'comfort', price: 0 },
          { vehicleType: 'xl', price: 0 },
          { vehicleType: 'luxury', price: 0 },
        ];
      }
      state.quotes = quotes;
      state.stage = 'pre_vehicle';
      convo.set(jid, state);
      const lines = quotes.map((q, i) => `${i + 1}) ${vehicleLabel(q.vehicleType)}${q.price ? ` — R${q.price}` : ''}`);
      await sendText(jid, '🚘 Select your ride type for the prebooking:\n' + lines.join('\n') + '\n\nReply with the *number* of your choice.');
      return;
    }
    // any other text: reprint review
    await sendText(jid, printTripReview({ pickup: state.pickup, destination: state.destination, when: state.when }));
    return;
  }

  // PREBOOK: VEHICLE select
  if (state.stage === 'pre_vehicle' && /^\d{1,2}$/.test(txt)) {
    const idx = Number(txt) - 1;
    const q = state.quotes?.[idx];
    if (!q) { await sendText(jid, '⚠️ Invalid choice. Reply with a valid number from the list.'); return; }
    state.chosenVehicle = q.vehicleType;
    state.price = q.price || 0;
    state.stage = 'pre_payment';
    convo.set(jid, state);

    const label = vehicleLabel(q.vehicleType);
    const summary =
      `🧾 *Prebook Summary*\n` +
      `• Vehicle: ${label}\n` +
      (state.price ? `• Est. Price Now: R${state.price}\n` : '') +
      `• Pickup: ${addrPretty(state.pickup)}\n` +
      `• Drop:   ${addrPretty(state.destination)}\n` +
      `• When:   ${new Date(state.when).toLocaleString('en-ZA')}\n\n` +
      `Choose payment:\n` +
      `1) 💵 Cash\n` +
      `2) 💳 Card (PayFast)\n` +
      `Reply with *1* or *2*.`;
    await sendText(jid, summary);
    return;
  }

  // PREBOOK: PAYMENT
  if (state.stage === 'pre_payment') {
    const isCash = (txt === '1' || txt === 'cash');
    const isCard = (txt === '2' || txt === 'card' || txt === 'payfast');

    if (!isCash && !isCard) {
      await sendText(jid, 'Reply with *1* for Cash or *2* for Card.');
      return;
    }
    if (!state.pickup || !state.destination || !state.chosenVehicle || !state.when) {
      resetFlow(jid);
      await sendText(jid, '⚠️ Session expired. Type *menu* → *6* to start prebooking again.');
      return;
    }

    let ride = null;
    try {
      ride = await Ride.create({
        pickup: state.pickup,
        destination: state.destination,
        estimate: state.price || undefined, // price may change by time; stored if you wish
        paymentMethod: isCash ? 'cash' : 'payfast',
        vehicleType: state.chosenVehicle,
        status: 'scheduled',                   // key: scheduled, not pending
        platform: 'whatsapp',
        riderWaJid: jid,
        scheduledFor: new Date(state.when),
        createdAt: new Date()
      });
      waRideById.set(String(ride._id), jid);
    } catch (e) {
      await sendText(jid, '⚠️ Could not create the prebooking. Please try again.');
      resetFlow(jid);
      return;
    }

    // Optionally notify admins / system; actual driver assignment can occur N minutes before scheduled time
    try {
      // If you have a scheduler, it will flip 'scheduled' → 'pending' and emit riderEvents then.
      await sendText(jid, `✅ Prebooking saved for *${new Date(state.when).toLocaleString('en-ZA')}*.\nWe’ll notify a driver at the right time.`);
      if (isCard) {
        const link = `${PUBLIC_URL}/pay/${encodeURIComponent(String(ride._id))}`;
        await sendText(jid, `💳 Optional early payment link:\n${link}`);
      }
    } catch {}

    resetFlow(jid);
    await sendMainMenu(jid);
    return;
  }

  // Hints if user is stuck
  if (state.stage === 'await_pickup')  { await sendText(jid, `📍 Please send your *pickup* — share location (📎) or type the address for suggestions.`); return; }
  if (state.stage === 'await_destination') { await sendText(jid, `📍 Please send your *destination* — share location (📎) or type the address for suggestions.`); return; }
  if (state.stage === 'pre_pickup')  { await sendText(jid, `📍 Please send your *prebook pickup* — share location (📎) or type the address for suggestions.`); return; }
  if (state.stage === 'pre_destination') { await sendText(jid, `🎯 Please send your *prebook destination* — share location (📎) or type the address for suggestions.`); return; }
  if (state.stage === 'pre_when') { await sendText(jid, `🗓️ Please send the *date/time* for your trip (e.g., 2025-10-31 14:30).`); return; }

  // Fallback to menu
  if ((convo.get(jid)?.stage || 'idle') === 'idle') {
    await sendMainMenu(jid);
  }
}

async function handleLocationMessage(jid, locationMessage) {
  const lat = locationMessage.degreesLatitude;
  const lng = locationMessage.degreesLongitude;

  await upsertWaRider(jid, { lastLocation: { lat, lng } }).catch(() => {});

  const state = convo.get(jid) || { stage: 'idle' };
  const ensured = await ensurePhonePresence({ jid, state });
  if (ensured === 'prompted') return;

  // Handle for both instant and prebooking flows
  if (state.stage === 'idle') {
    // Default to instant flow
    startBooking(jid);
    state.stage = 'await_pickup';
  }

  // INSTANT
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
    try { quotes = await getAvailableVehicleQuotes({ pickup: state.pickup, destination: state.destination, radiusKm: 30 }); } catch {}

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

    const lines = quotes.map((q, i) => `${i + 1}) ${vehicleLabel(q.vehicleType)} — R${q.price}${q.driverCount ? ` (drivers: ${q.driverCount})` : ''}`);
    await sendText(jid, '🚘 Select your ride:\n' + lines.join('\n') + '\n\nReply with the *number* of your choice.');
    return;
  }

  // PREBOOK
  if (state.stage === 'pre_pickup') {
    state.pickup = { lat, lng };
    state.suggestions = [];
    state.stage = 'pre_destination';
    convo.set(jid, state);
    await sendText(jid, '✅ Pickup saved.\n\n🎯 Now send your *destination* — share location (📎) or type address for suggestions.');
    return;
  }
  if (state.stage === 'pre_destination') {
    state.destination = { lat, lng };
    state.suggestions = [];
    state.stage = 'pre_when';
    convo.set(jid, state);
    await sendText(
      jid,
      `🗓️ When do you need the ride?\nExamples:\n• 2025-10-31 14:30\n• 31/10/2025 2pm\n• tomorrow 09:00\n• friday 18:15`
    );
    return;
  }
}

/* --------------- Driver → Rider notifications --------------- */
function vtLabel(t) { return vehicleLabel(t); }
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

  const driverLoc = (driver?.location && typeof driver.location.lat === 'number' && typeof driver.location.lng === 'number')
    ? toMap(driver.location)
    : null;

  const lines = [
    '🚗 *Driver assigned*',
    `• Name: ${dName}${rating ? ` — ${rating}` : ''}${trips ? ` · ${trips}` : ''}`,
    `• Car: ${dCar} — ${dType}`,
    `• Plate: ${dPlate}`,
    `• Call/Text: ${dPhone}`,
  ];

  if (driverLoc) lines.push(`• Driver location: ${driverLoc}`);
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

/* --------------- Resolve WA JID by rideId --------------- */
async function getWaJidForRideId(rideId) {
  const cached = waRideById.get(String(rideId));
  if (cached) return cached;
  try {
    const r = await Ride.findById(rideId).select('riderWaJid').lean();
    return r?.riderWaJid || null;
  } catch { return null; }
}

/* --------------- Public rating notifier --------------- */
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

/* --------------- Main menu sender --------------- */
function sendMainMenu(jid) {
  return sendText(
    jid,
    `👋 *Welcome to VayaRide!*\n` +
    `Please reply with a number:\n\n` +
    `1) 🚕 Book Trip (now)\n` +
    `2) ❓ Help\n` +
    `3) 🧑‍💼 Support\n` +
    `4) 👤 Profile\n` +
    `5) 🚗 I am a Driver\n` +
    `6) 🗓️ Prebook Trip`
  );
}

/* --------------- Lifecycle exports --------------- */
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
