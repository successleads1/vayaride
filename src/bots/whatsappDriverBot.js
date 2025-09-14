// src/bots/whatsappDriverBot.js
// WhatsApp bot dedicated to DRIVERS (separate Baileys session from rider WA bot)

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

import Driver from '../models/Driver.js';
import Ride from '../models/Ride.js';
import { driverEvents } from './driverBot.js'; // reuse same event bus as TG bot

/* -------------------- env & paths -------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT_DIR   = path.resolve(process.cwd());

// Default PUBLIC_URL for dev so links work without env
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:3000').trim().replace(/\/$/, '');

// Use a separate auth folder so this session is completely independent
const AUTH_DIR = process.env.WA_DRIVER_AUTH_DIR
  ? path.resolve(process.env.WA_DRIVER_AUTH_DIR)
  : path.resolve(ROOT_DIR, 'baileys_auth_driver');

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const logger = pino({ level: process.env.WA_DRIVER_LOG_LEVEL || 'warn' });

/* -------------------- state -------------------- */
let sock = null;
let initializing = false;
let currentQR = null;
let connState = 'disconnected';

const driverNames = new Map(); // jid -> name (cached displayName)
const recentSends = new Map(); // dedupe "same message spam"
const DEDUPE_TTL_MS = Number(process.env.WA_DEDUPE_TTL_MS || 12000);

// Track pending ride per-driver so they can just reply ACCEPT/IGNORE
const pendingRideByJid = new Map();      // jid -> full rideId
const pendingShortByJid = new Map();     // jid -> short 4-char -> full rideId

// Exported so server/UI can wait for QR in browser
export const driverWaEvents = new EventEmitter();

/* -------------------- tiny helpers -------------------- */
function normText(s = '') { return String(s).trim().replace(/\s+/g, ' '); }
function shouldSendOnce(jid, text) {
  const key = `${jid}|${normText(text)}`;
  const now = Date.now();
  const last = recentSends.get(key) || 0;
  if (now - last < DEDUPE_TTL_MS) return false;
  recentSends.set(key, now);
  if (recentSends.size > 2000) {
    const cutoff = now - 2 * DEDUPE_TTL_MS;
    for (const [k, ts] of recentSends) if (ts < cutoff) recentSends.delete(k);
  }
  return true;
}

function isJid(str) {
  return /@(s\.whatsapp\.net|g\.us|broadcast)$/.test(String(str || ''));
}

function jidFromPhone(phoneLike) {
  // accepts +27..., 27..., 0... (ZA); returns 27xxxxxxxxx@s.whatsapp.net
  const raw = String(phoneLike || '').trim();
  if (!raw) return null;
  let digits = raw.replace(/[^\d]/g, '');
  if (digits.startsWith('0')) {
    // ZA local → assume +27
    digits = '27' + digits.slice(1);
  }
  if (!/^\d{8,15}$/.test(digits)) return null;
  return `${digits}@s.whatsapp.net`;
}

function phoneFromJid(jid) {
  // '27xxxxxxxxx@s.whatsapp.net' -> +27xxxxxxxxx
  const m = String(jid || '').match(/^(\d+)@s\.whatsapp\.net$/);
  if (!m) return null;
  return `+${m[1]}`;
}

async function sendText(jidOrPhone, text) {
  if (!sock) throw new Error('WA driver client not ready');
  let jid = null;

  if (isJid(jidOrPhone)) {
    jid = String(jidOrPhone);
  } else {
    jid = jidFromPhone(jidOrPhone);
  }

  if (!jid) {
    logger.warn('[WA-DRIVER] sendText skipped (invalid JID/phone): %s', jidOrPhone);
    return;
  }
  if (!shouldSendOnce(jid, text)) return;
  await sock.sendMessage(jid, { text });
}

async function sendButtons(jid, body, rideId) {
  // Old-style buttons; if they fail, caller falls back to text.
  const buttonsMessage = {
    text: body,
    buttons: [
      { buttonId: `accept_${rideId}`, buttonText: { displayText: '✅ Accept' }, type: 1 },
      { buttonId: `ignore_${rideId}`, buttonText: { displayText: '🙈 Ignore' }, type: 1 },
    ],
    headerType: 1
  };
  await sock.sendMessage(jid, buttonsMessage);
}

function onlineKeyboardText(isOnline) {
  return isOnline
    ? '🔴 *2 — Go OFFLINE* to stop receiving jobs.'
    : '🟢 *1 — Go ONLINE* to start receiving jobs.';
}

function fmtKm(meters) { return `${(Number(meters || 0) / 1000).toFixed(2)} km`; }
function fmtDuration(sec) {
  const s = Number(sec || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h}h ${m}m`; if (m) return `${m}m ${r}s`; return `${r}s`;
}
function fmtAmount(n) { return `R${Number(n || 0).toFixed(0)}`; }
function paymentEmoji(method) {
  if (method === 'cash') return '💵';
  if (method === 'payfast' || method === 'app') return '💳';
  return '✅';
}

/* -------------------- DB helpers -------------------- */
async function setAvailabilityByJid(jid, isOnline) {
  const phone = phoneFromJid(jid);
  let driver = null;

  if (phone) {
    driver = await Driver.findOneAndUpdate(
      { phone: phone }, // phone normalized to +27...
      { $set: { isAvailable: !!isOnline, lastSeenAt: new Date() } },
      { new: true }
    );
  }

  return driver;
}

async function findDriverByJid(jid) {
  const phone = phoneFromJid(jid);
  if (!phone) return null;
  return Driver.findOne({ phone }).lean();
}

async function linkDriverByEmail(email, jid) {
  const phone = phoneFromJid(jid);
  if (!phone) return null;

  const emailRegex = new RegExp(`^${String(email).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const driver = await Driver.findOneAndUpdate(
    { email: emailRegex },
    { $set: { phone, lastSeenAt: new Date() } },
    { new: true }
  );
  return driver;
}

async function ensureAndGetDriverStats(driver) {
  try { await Driver.computeAndUpdateStats(driver._id); } catch {}
  return Driver.findById(driver._id);
}

function formatStatsMessage(driver) {
  const s = driver?.stats || {}; const last = s.lastTrip || {};
  const lines = [];
  lines.push('📊 *Your Stats*');
  lines.push(`• Trips: *${s.totalTrips || 0}*`);
  lines.push(`• Distance: *${fmtKm(s.totalDistanceM || 0)}*`);
  lines.push(`• Earnings: *${fmtAmount(s.totalEarnings || 0)}*`);
  lines.push(`• Payments: ${s.cashCount || 0} cash · ${s.payfastCount || 0} payfast`);
  if (typeof s.avgRating === 'number' && s.ratingsCount >= 0) {
    lines.push(`• Rating: *${(s.avgRating || 0).toFixed(2)}* (${s.ratingsCount || 0})`);
  }
  if (last && last.rideId) {
    lines.push('');
    lines.push('🧾 *Last Trip*');
    lines.push(`• Distance: *${fmtKm(last.distanceMeters || 0)}*`);
    lines.push(`• Duration: *${fmtDuration(last.durationSec || 0)}*`);
    lines.push(`• Amount: *${fmtAmount(last.amount || 0)}* ${paymentEmoji(last.method)}`);
  }
  return lines.join('\n');
}

/* -------------------- helpers for pending rides -------------------- */
function setPendingFor(jid, rideId) {
  pendingRideByJid.set(jid, rideId);
  const short = String(rideId).slice(-4).toLowerCase();
  const map = pendingShortByJid.get(jid) || new Map();
  map.set(short, rideId);
  if (map.size > 10) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
  pendingShortByJid.set(jid, map);
}

function resolveRideIdFromInput(jid, maybeCode) {
  if (!maybeCode) return pendingRideByJid.get(jid) || null;
  const code = String(maybeCode).trim().toLowerCase();
  if (/^[a-f0-9]{24}$/.test(code)) return code;
  if (/^[a-f0-9]{4}$/.test(code)) {
    const map = pendingShortByJid.get(jid);
    return map?.get(code) || null;
  }
  return null;
}

/* -------------------- Inbound handlers -------------------- */
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

async function handleTextMessage(jid, raw) {
  const txt = String(raw || '').trim();
  const lower = txt.toLowerCase();

  // greet / menu
  if (['/start','start','menu','help','/help','hi','hello'].includes(lower)) {
    const driver = await findDriverByJid(jid);
    if (!driver) {
      await sendText(jid,
        '👋 *VayaRide Driver*\n' +
        'I couldn’t find your driver profile for this WhatsApp number.\n' +
        '• *Just type your email address* to link your account (example: driver@email.com)\n' +
        `• Or register here:\n${PUBLIC_URL}/driver/register\n\n` +
        'Once linked, reply:\n' +
        '1 — Go ONLINE\n' +
        '2 — Go OFFLINE'
      );
      return;
    }
    const pending = pendingRideByJid.get(jid);
    const short = pending ? String(pending).slice(-4) : null;
    await sendText(jid,
      `👋 Hi ${driver.name || ''}\n` +
      `Status: *${driver.isAvailable ? 'ONLINE' : 'OFFLINE'}*\n` +
      `${onlineKeyboardText(!!driver.isAvailable)}\n\n` +
      'Quick actions:\n' +
      '1 — Go ONLINE\n' +
      '2 — Go OFFLINE\n\n' +
      'Other commands:\n' +
      '• *STATS*\n' +
      '• *WHOAMI*\n' +
      (pending ? `• For the latest request: reply *ACCEPT* or *IGNORE* (or include code *${short}*)` : '')
    );
    return;
  }

  // allow plain email anywhere in the message to link
  const emailMatch = txt.match(EMAIL_RE);
  if (emailMatch && !lower.startsWith('accept') && !lower.startsWith('ignore')) {
    const email = emailMatch[0];
    const linked = await linkDriverByEmail(email, jid);
    if (linked) {
      await sendText(jid, `✅ Linked this WhatsApp number to *${linked.email}*.\nNow send *1* to go ONLINE and start receiving jobs.`);
    } else {
      await sendText(jid, `❌ Couldn’t find a driver with email: ${email}\nPlease make sure you registered on the website.`);
    }
    return;
  }

  // legacy: explicit "LINK you@example.com" still works
  if (lower.startsWith('link ')) {
    const email = txt.slice(5).trim();
    const linked = await linkDriverByEmail(email, jid);
    if (linked) {
      await sendText(jid, `✅ Linked this WhatsApp number to *${linked.email}*.\nNow send *1* to go ONLINE and start receiving jobs.`);
    } else {
      await sendText(jid, `❌ Couldn’t find a driver with email: ${email}\nPlease make sure you registered on the website.`);
    }
    return;
  }

  // normalize for simple numeric shortcuts
  const cleaned = lower.replace(/[\s().:-]+/g, ' ').trim();

  // availability — accept: "1", "go online", "online", "/online"
  if (cleaned === '1' || cleaned === 'online' || cleaned === '/online' || cleaned.startsWith('go online')) {
    const driver = await setAvailabilityByJid(jid, true);
    if (!driver) { await sendText(jid, '❌ Driver profile not found. Please send your *email address* to link.'); return; }
    await sendText(
      jid,
      '🟢 You are now *ONLINE*.\n' +
      '➡️ Please *Share Live Location* so we can keep tracking your position for jobs:\n' +
      '   • Tap 📎 (attach) → *Location* → *Share live location* → choose *Until turned off*.\n' +
      '   • Keep live location ON while you are online.\n' +
      'You can also send a one-off location, but *live location* is best.\n\n' +
      'To stop, send *2* (Go OFFLINE).'
    );
    return;
  }

  // availability — accept: "2", "go offline", "offline", "/offline"
  if (cleaned === '2' || cleaned === 'offline' || cleaned === '/offline' || cleaned.startsWith('go offline') || cleaned.startsWith('go off line')) {
    const driver = await setAvailabilityByJid(jid, false);
    if (!driver) { await sendText(jid, '❌ Driver profile not found.'); return; }
    await sendText(jid, '🔴 You are now *OFFLINE*.\nSend *1* to go ONLINE again.');
    return;
  }

  // stats
  if (lower === 'stats' || lower === '/stats') {
    const d = await findDriverByJid(jid);
    if (!d) { await sendText(jid, '❌ Driver profile not found.'); return; }
    const full = await ensureAndGetDriverStats(d);
    await sendText(jid, formatStatsMessage(full));
    return;
  }

  // whoami
  if (lower === 'whoami' || lower === '/whoami') {
    const d = await findDriverByJid(jid);
    if (!d) { await sendText(jid, '❌ Driver profile not found.'); return; }
    await sendText(jid,
      `You are:\n` +
      `• email: ${d.email || '-'}\n` +
      `• name: ${d.name || '-'}\n` +
      `• status: ${d.status}\n` +
      `• online: ${d.isAvailable ? 'yes' : 'no'}\n` +
      `• phone: ${d.phone || phoneFromJid(jid) || '-'}`
    );
    return;
  }

  // accept/ignore — allow plain ACCEPT/IGNORE or with 4-char short or full id
  if (/^accept(\s+([a-f0-9]{4}|[a-f0-9]{24}))?$/i.test(lower)) {
    const maybe = txt.split(/\s+/)[1]; // short or full
    const rideId = resolveRideIdFromInput(jid, maybe);
    if (!rideId) { await sendText(jid, '❌ No pending ride to accept.'); return; }
    await tryAcceptRide(jid, rideId);
    return;
  }
  if (/^(ignore|skip|decline)(\s+([a-f0-9]{4}|[a-f0-9]{24}))?$/i.test(lower)) {
    const maybe = txt.split(/\s+/)[1]; // short or full
    const rideId = resolveRideIdFromInput(jid, maybe);
    if (!rideId) { await sendText(jid, '❌ No pending ride to ignore.'); return; }
    await tryIgnoreRide(jid, rideId);
    return;
  }

  // legacy: "ACCEPT <24hex>" still works
  if (/^accept\s+[a-f0-9]{24}$/i.test(lower)) {
    const rideId = txt.split(/\s+/)[1];
    await tryAcceptRide(jid, rideId);
    return;
  }
  if (/^(ignore|skip|decline)\s+[a-f0-9]{24}$/i.test(lower)) {
    const rideId = txt.split(/\s+/)[1];
    await tryIgnoreRide(jid, rideId);
    return;
  }

  // unrecognized → beginner-friendly help
  await sendText(
    jid,
    '🤖 Quick actions:\n' +
    '1 — Go ONLINE\n' +
    '2 — Go OFFLINE\n\n' +
    'Other commands:\n' +
    '• *Type your email address* to link your account (e.g. name@example.com)\n' +
    '• *STATS*, *WHOAMI*, *ACCEPT*, *IGNORE*\n' +
    'Tip: Keep *Share live location* on while ONLINE.'
  );
}

async function upsertDriverLocationByPhone(phone, lat, lng) {
  await Driver.findOneAndUpdate(
    { phone },
    { $set: { location: { lat, lng }, lastSeenAt: new Date(), isAvailable: true } },
    { new: true }
  );

  // Prefer numeric Telegram chatId if available so server.js can Number() it
  const drvDoc = await Driver.findOne({ phone }).select('chatId').lean();
  const idForEvents =
    (drvDoc && Number.isFinite(Number(drvDoc.chatId))) ? Number(drvDoc.chatId) : phone; // fallback to phone

  driverEvents.emit('driver:location', { chatId: idForEvents, location: { lat, lng } });
}

async function handleLocationMessage(jid, locationMessage) {
  const lat = locationMessage.degreesLatitude;
  const lng = locationMessage.degreesLongitude;

  const phone = phoneFromJid(jid);
  if (!phone) return;

  await upsertDriverLocationByPhone(phone, lat, lng);
  try { await sendText(jid, '📍 Location received. For best results, use *Share live location* (📎 → Location → Share live).'); } catch {}
}

// Live location updates come as liveLocationMessage (sent repeatedly by WhatsApp)
async function handleLiveLocationMessage(jid, liveLocMessage) {
  const lat = liveLocMessage.degreesLatitude;
  const lng = liveLocMessage.degreesLongitude;

  const phone = phoneFromJid(jid);
  if (!phone) return;

  await upsertDriverLocationByPhone(phone, lat, lng);

  // Only thank once in a while (don’t spam every tick)
  const key = `${jid}|live_thanks`;
  const last = recentSends.get(key) || 0;
  if (Date.now() - last > 60_000) { // 1 min
    recentSends.set(key, Date.now());
    try { await sendText(jid, '🛰️ Live location updating — thanks! Keep it on while ONLINE.'); } catch {}
  }
}

/* -------------------- ride actions -------------------- */
async function tryAcceptRide(jid, rideId) {
  const driver = await findDriverByJid(jid);
  if (!driver) { await sendText(jid, '❌ Driver profile not found.'); return; }

  const ride = await Ride.findById(rideId);
  if (!ride) { await sendText(jid, '❌ Ride not found.'); return; }
  if (!ride.driverId) { ride.driverId = driver._id; }
  ride.status = 'accepted';
  await ride.save();

  await sendText(jid, '✅ You accepted the ride.');

  // Notify system (same event path as Telegram)
  driverEvents.emit('ride:accepted', {
    driverId: (Number.isFinite(Number(driver.chatId)) ? Number(driver.chatId) : (driver.phone || phoneFromJid(jid))),
    rideId
  });

  // Send live map links (prefer numeric TG chatId for server-side APIs)
  const base = `${PUBLIC_URL}/track.html?rideId=${encodeURIComponent(rideId)}`;
  const idForLink = (Number.isFinite(Number(driver.chatId)) ? String(driver.chatId) : (driver.phone ?? ''));
  const driverLink = `${base}&as=driver&driverChatId=${encodeURIComponent(idForLink)}`;
  try { await sendText(jid, `🗺️ Open the live trip map (shares your GPS):\n${driverLink}\nTip: Keep *Share live location* ON for the trip.`); } catch {}

  // clear pending (only if it matched)
  const current = pendingRideByJid.get(jid);
  if (current === rideId) {
    pendingRideByJid.delete(jid);
    const map = pendingShortByJid.get(jid);
    if (map) {
      for (const [k, v] of map) if (v === rideId) map.delete(k);
    }
  }
}

async function tryIgnoreRide(jid, rideId) {
  const ride = await Ride.findById(rideId);
  if (ride) {
    driverEvents.emit('ride:ignored', { previousDriverId: phoneFromJid(jid) || 'wa', ride });
  }
  await sendText(jid, '🙈 Ignored. Looking for another driver…');

  // clear pending (only if it matched)
  const current = pendingRideByJid.get(jid);
  if (current === rideId) {
    pendingRideByJid.delete(jid);
    const map = pendingShortByJid.get(jid);
    if (map) {
      for (const [k, v] of map) if (v === rideId) map.delete(k);
    }
  }
}

/* -------------------- outbound API (export) -------------------- */
export async function waNotifyDriverNewRequest({ to, driver, ride }) {
  const phone = to || driver?.phone;
  if (!phone) return;

  const jid = jidFromPhone(phone);
  if (!jid) return;

  // Record "pending" so driver can just reply ACCEPT / IGNORE
  setPendingFor(jid, ride._id);

  const short = String(ride._id).slice(-4).toLowerCase();
  const toMap = ({ lat, lng }) => `https://maps.google.com/?q=${lat},${lng}`;
  const body =
    '🚗 *New Ride Request*\n' +
    `• Vehicle: *${(ride.vehicleType || 'normal').toUpperCase()}*\n` +
    (ride.estimate ? `• Estimate: *R${ride.estimate}*\n` : '') +
    (ride.pickup ? `• Pickup: ${toMap(ride.pickup)}\n` : '') +
    (ride.destination ? `• Drop:   ${toMap(ride.destination)}\n` : '') +
    '\n' +
    `Reply *ACCEPT* or *IGNORE* (or include code *${short}* if you have multiple).`;

  // Try to send buttons; if it fails, fall back to text
  try {
    await sendButtons(jid, body, String(ride._id));
  } catch (e) {
    logger.warn('[WA-DRIVER] buttons send failed, falling back to text: %s', e?.message || e);
    await sendText(jid, body);
  }
}

export async function waNotifyDriverArrived({ to }) {
  if (!to) return;
  await sendText(jidFromPhone(to), '📍 Arrival detected at pickup.');
}

export async function waNotifyDriverFinishSummary({ to, body }) {
  if (!to) return;
  await sendText(jidFromPhone(to), body);
}

/* -------------------- init / lifecycle -------------------- */
async function setupClient() {
  if (initializing) return;
  initializing = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[WA-DRIVER] Using WA v${version.join('.')}, latest: ${isLatest}`);

    connState = 'connecting';

    sock = makeWASocket({
      version,
      logger,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      browser: ['VayaRide Driver', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: false,
      qrTimeout: 60_000,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 10_000,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      printQRInTerminal: process.env.WA_DRIVER_SHOW_QR === '1'
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        try {
          if (process.env.WA_DRIVER_SHOW_QR === '1') {
            console.log('\n' + await qrcode.toString(qr, { type: 'terminal', small: true }));
          }
          driverWaEvents.emit('qr', await qrcode.toDataURL(qr));
        } catch (e) {
          logger.warn('[WA-DRIVER] could not generate QR dataURL: %s', e?.message || e);
        }
      }

      if (connection === 'open') {
        currentQR = null;
        connState = 'connected';
        console.log('✅ WhatsApp (driver) connected');
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
          console.log('[WA-DRIVER] Logged out / bad session, clearing creds…');
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
          await delay(1500);
          initializing = false;
          return setupClient();
        }

        console.log('[WA-DRIVER] reconnecting in 5s…');
        await delay(5000);
        initializing = false;
        return setupClient();
      }
    });

    // inbound messages
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

          // cache pushName
          if (m.pushName) driverNames.set(jid, m.pushName);

          // Button replies
          const btn = msg.buttonsResponseMessage || msg.templateButtonReplyMessage || null;
          if (btn?.selectedButtonId) {
            const id = String(btn.selectedButtonId);
            if (id.startsWith('accept_')) {
              const rideId = id.slice('accept_'.length);
              await tryAcceptRide(jid, rideId);
              continue;
            }
            if (id.startsWith('ignore_')) {
              const rideId = id.slice('ignore_'.length);
              await tryIgnoreRide(jid, rideId);
              continue;
            }
          }

          // Location / Live Location / Text
          const live = msg.liveLocationMessage || null;
          const loc  = msg.locationMessage || null;
          let text =
            msg.conversation ||
            msg.extendedTextMessage?.text ||
            msg.imageMessage?.caption ||
            msg.videoMessage?.caption || '';
          text = (text || '').trim();

          if (live) { await handleLiveLocationMessage(jid, live); continue; }
          if (loc)  { await handleLocationMessage(jid, loc); continue; }
          if (text) { await handleTextMessage(jid, text); continue; }
        } catch (e) {
          console.error('[WA-DRIVER] handle error:', e);
          try {
            const rjid = m?.key?.remoteJid;
            if (isJid(rjid)) {
              await sendText(rjid, '⚠️ Error. Please try again.');
            } else {
              logger.warn('[WA-DRIVER] skip error reply, invalid JID: %s', rjid);
            }
          } catch {}
        }
      }
    });

  } catch (err) {
    console.error('❌ Error setting up WA driver client:', err);
  } finally {
    initializing = false;
  }
}

/* -------------------- public control API -------------------- */
export function initWhatsappDriverBot() {
  if (sock || initializing) {
    console.log('[WA-DRIVER] already initialized');
    return;
  }
  console.log('🚀 Initializing WhatsApp *Driver* Bot…');
  setupClient();
}

export function isWhatsAppDriverConnected() {
  return !!(sock && sock.ws && sock.ws.readyState === 1);
}

export function getDriverConnectionStatus() { return connState; }

export async function waitForDriverQrDataUrl(timeoutMs = 25000) {
  if (currentQR) return qrcode.toDataURL(currentQR);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for driver QR')), timeoutMs);
    driverWaEvents.once('qr', (dataUrl) => { clearTimeout(t); resolve(dataUrl); });
  });
}

export async function resetWhatsAppDriverSession() {
  try {
    if (sock) {
      try { await sock.logout(); } catch {}
      try { sock.end?.(); } catch {}
      sock = null;
    }
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
    currentQR = null;
    connState = 'disconnected';
  } finally {
    setupClient();
  }
}

/* -------------------- export a direct send for server dispatch -------------------- */
export async function sendWhatsAppDriverMessage(toPhoneOrJid, text) {
  return sendText(toPhoneOrJid, text);
}
