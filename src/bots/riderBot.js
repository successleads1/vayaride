// src/bots/riderBot.js
import TelegramBot from 'node-telegram-bot-api';
import EventEmitter from 'events';
import crypto from 'crypto';
import fetch from 'node-fetch';

import { getAvailableVehicleQuotes } from '../services/pricing.js';
import Ride from '../models/Ride.js';
import Rider from '../models/Rider.js';
import Driver from '../models/Driver.js';
import { sendAdminEmailToDrivers } from '../services/mailer.js';

// Driver bot hooks (events + notify)
import { driverEvents, notifyDriverNewRequest } from './driverBot.js';

export const riderEvents = new EventEmitter();

/* ---------------- Singleton ---------------- */
if (!globalThis.__riderBotSingleton) {
  globalThis.__riderBotSingleton = { bot: null, wired: false, started: false };
}
let riderBot = globalThis.__riderBotSingleton.bot;
let ioRef = null;

/* ---------------- Env ---------------- */
const MODE = process.env.TELEGRAM_MODE || 'polling';
const token = process.env.TELEGRAM_RIDER_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_RIDER_BOT_TOKEN is not defined in .env');

const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
const RIDER_WEBHOOK_PATH = process.env.TELEGRAM_RIDER_WEBHOOK_PATH || '/telegram/rider';

const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || 'admin@vayaride.co.za').trim();

/* ---------------- Google Places (ZA bias) ---------------- */
const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const GMAPS_COMPONENTS = process.env.GOOGLE_MAPS_COMPONENTS || 'country:za';
const GMAPS_LANGUAGE = process.env.GOOGLE_MAPS_LANGUAGE || 'en-ZA';
const GMAPS_REGION = process.env.GOOGLE_MAPS_REGION || 'za';
const ZA_CENTER = { lat: -28.4793, lng: 24.6727 };
const ZA_RADIUS_M = 1_500_000;

/* ---------------- In-memory state ---------------- */
const riderState = new Map();

/* --- referral (Telegram): pending code and applier --- */
const pendingRefByChat = new Map(); // chatId -> CODE

async function applyReferrerRewardByCode(code, newRiderId) {
  const refCode = String(code || '').trim().toUpperCase();
  if (!refCode) return false;

  const referrer = await Rider.findOne({ referralCode: refCode }).lean();
  if (!referrer?._id) return false;

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

  await Rider.updateOne({ _id: newRiderId }, { $set: { referredBy: referrer._id } });
  return true;
}

/* ---------------- Utils ---------------- */
const crop = (s, n = 48) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const generatePIN = () => Math.floor(1000 + Math.random() * 9000).toString();
const generateToken = () => crypto.randomBytes(24).toString('hex');

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
function isLikelyQuery(t) {
  if (!t) return false;
  const s = String(t).trim();
  if (!/[a-z]/i.test(s)) return false;
  if (/\d/.test(s) || /\s/.test(s)) return true;
  if (s.length >= 3) return true;
  if (ZA_SHORTCUTS[s.toLowerCase()]) return true;
  return false;
}

/* ---------------- formatter & map ---------------- */
const toMap = ({ lat, lng }) => `https://maps.google.com/?q=${lat},${lng}`;

function vehicleTypeLabel(vt) {
  if (vt === 'comfort') return 'Comfort';
  if (vt === 'luxury') return 'Luxury';
  if (vt === 'xl') return 'XL';
  return 'Normal';
}

function formatDriverCardForRider({ driver, ride }) {
  const dPhone = driver?.phone || driver?.phoneNumber || driver?.mobile || driver?.msisdn || '—';
  const carName = driver?.vehicleName || [driver?.vehicleMake, driver?.vehicleModel].filter(Boolean).join(' ');
  const lines = [
    '🚘 <b>Your Driver</b>',
    `• Name: <b>${driver?.name || '—'}</b>`,
    `• Phone: <b>${dPhone}</b>`,
    `• Vehicle: <b>${carName || '—'}</b>${driver?.vehicleColor ? ` (${driver.vehicleColor})` : ''}`,
    `• Plate: <b>${driver?.vehiclePlate || '—'}</b>`,
    `• Type: <b>${vehicleTypeLabel(driver?.vehicleType || 'normal')}</b>`,
  ];
  if (ride?.pickup) lines.push(`• Pickup: <a href="${toMap(ride.pickup)}">map</a>`);
  if (ride?.destination) lines.push(`• Drop: <a href="${toMap(ride.destination)}">map</a>`);
  return lines.join('\n');
}

/* ---------------- Google helpers ---------------- */
async function gmapsAutocomplete(input, { sessiontoken } = {}) {
  if (!GMAPS_KEY) return [];
  const expanded = expandShortcut(input);
  const maybeBoosted = boostToZA(expanded);

  const u = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
  u.searchParams.set('input', maybeBoosted);
  u.searchParams.set('key', GMAPS_KEY);
  u.searchParams.set('components', GMAPS_COMPONENTS);
  u.searchParams.set('language', GMAPS_LANGUAGE);
  u.searchParams.set('region', GMAPS_REGION);
  u.searchParams.set('location', `${ZA_CENTER.lat},${ZA_CENTER.lng}`);
  u.searchParams.set('radius', String(ZA_RADIUS_M));
  u.searchParams.set('strictbounds', 'true');
  if (sessiontoken) u.searchParams.set('sessiontoken', sessiontoken);

  try {
    const r = await fetch(u.toString());
    const j = await r.json();
    let preds = Array.isArray(j.predictions) ? j.predictions : [];
    if (!preds.length && expanded === input) {
      const u2 = new URL(u);
      u2.searchParams.set('input', `${expanded} South Africa`);
      const r2 = await fetch(u2.toString());
      const j2 = await r2.json();
      preds = Array.isArray(j2.predictions) ? j2.predictions : [];
    }
    return preds;
  } catch {
    return [];
  }
}
async function gmapsPlaceLatLng(placeId, { sessiontoken } = {}) {
  if (!GMAPS_KEY) return null;
  const u = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  u.searchParams.set('place_id', placeId);
  u.searchParams.set('fields', 'geometry/location,name,formatted_address');
  u.searchParams.set('key', GMAPS_KEY);
  u.searchParams.set('language', GMAPS_LANGUAGE);
  u.searchParams.set('region', GMAPS_REGION);
  if (sessiontoken) u.searchParams.set('sessiontoken', sessiontoken);

  try {
    const r = await fetch(u.toString());
    const j = await r.json();
    if (j.status !== 'OK') return null;
    const loc = j.result?.geometry?.location;
    if (!loc) return null;
    const addr = j.result?.formatted_address || j.result?.name || '';
    return { lat: Number(loc.lat), lng: Number(loc.lng), name: j.result?.name || '', address: addr };
  } catch {
    return null;
  }
}

/* ---------------- Dashboard link ---------------- */
async function sendDashboardLink(chatId) {
  const dashboardToken = generateToken();
  const dashboardPin = generatePIN();
  const expiry = new Date(Date.now() + 10 * 60 * 1000);

  await Rider.findOneAndUpdate(
    { chatId },
    { chatId, dashboardToken, dashboardPin, dashboardTokenExpiry: expiry, platform: 'telegram' },
    { upsert: true }
  );

  const link = `${PUBLIC_URL}/rider-dashboard.html?token=${dashboardToken}`;
  await riderBot.sendMessage(
    chatId,
    `🔐 Dashboard link:\n${link}\n\n🔢 Your PIN: <b>${dashboardPin}</b>\n⏱️ Expires in 10 mins`,
    { parse_mode: 'HTML' }
  );
}

/* ---------------- Live rider location (for admin socket) ---------------- */
async function emitRiderLocation(chatId, loc) {
  await Rider.findOneAndUpdate(
    { chatId },
    { $set: { lastLocation: { ...loc, ts: new Date() }, lastSeenAt: new Date(), platform: 'telegram' } },
    { upsert: true }
  );
  try { ioRef?.emit('rider:location', { chatId, location: loc }); } catch {}
}

/* ---------------- Support + menus ---------------- */
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🚕 Book Trip', callback_data: 'book_trip' }],
      [{ text: '👤 Profile', callback_data: 'open_dashboard' }],
      [{ text: '🧑‍💼 Support', callback_data: 'support' }]
    ]
  };
}
async function triggerSupportEmail(chatId, context = 'Telegram rider support') {
  try {
    const rider = await Rider.findOne({ chatId }).lean().catch(() => null);
    const subject = 'Telegram Support Request — VayaRide';
    const html =
      `<p>A rider opened Support in the Telegram bot.</p>
       <ul>
         <li><strong>Platform:</strong> Telegram</li>
         <li><strong>Chat ID:</strong> ${chatId}</li>
         <li><strong>Name:</strong> ${rider?.name || '—'}</li>
         <li><strong>Email:</strong> ${rider?.email || '—'}</li>
         <li><strong>When:</strong> ${new Date().toLocaleString()}</li>
         <li><strong>Context:</strong> ${context}</li>
       </ul>`;
    await sendAdminEmailToDrivers(SUPPORT_EMAIL, { subject, html });
  } catch {}
}
async function showSupport(chatId, context = 'menu') {
  const msg =
    `🧑‍💼 <b>Support</b>\n` +
    `If you’re having issues:\n\n` +
    `• Email: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>\n` +
    `We’re here to help.`;
  await riderBot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
  await triggerSupportEmail(chatId, `User opened Support (${context})`);
}

/* ---------------- UX prompts ---------------- */
function askPickup(chatId) {
  return riderBot.sendMessage(
    chatId,
    '📍 Send your pickup location (use 📎 → Location) or type your pickup address:',
    {
      reply_markup: {
        keyboard: [[{ text: 'Send Pickup 📍', request_location: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    }
  );
}
function askDrop(chatId) {
  return riderBot.sendMessage(
    chatId,
    '🎯 Now send your destination (use 📎 → Location) or type your destination address:',
    {
      reply_markup: {
        keyboard: [[{ text: 'Send Drop 📍', request_location: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    }
  );
}
async function showAddressSuggestions(chatId, predictions, kind) {
  if (!predictions.length) {
    await riderBot.sendMessage(
      chatId,
      '😕 No matching addresses found in South Africa. Try refining your address or send live location with the 📎 button.'
    );
    if (kind === 'pickup') await askPickup(chatId); else await askDrop(chatId);
    return;
  }
  const kb = predictions.slice(0, 8).map((p, i) => ([
    { text: crop(p.description, 56), callback_data: `${kind === 'pickup' ? 'pick_idx' : 'drop_idx'}:${i}` }
  ]));
  await riderBot.sendMessage(
    chatId,
    `🔎 Select your ${kind === 'pickup' ? 'pickup' : 'destination'} address (ZA):\n(Or send your live location with 📎)`,
    { reply_markup: { inline_keyboard: kb } }
  );
}

/* ---------- Quotes after destination ---------- */
async function showQuotesOrRetry(chatId, st) {
  let quotes = [];
  try {
    quotes = await getAvailableVehicleQuotes({
      pickup: st.pickup,
      destination: st.destination,
      radiusKm: 30
    });
  } catch (e) { console.error('getAvailableVehicleQuotes failed:', e); }

  if (!quotes.length) {
    st.step = 'awaiting_pickup';
    riderState.set(chatId, st);
    await riderBot.sendMessage(chatId, '😞 No drivers are currently available nearby. Please try again.');
    return askPickup(chatId);
  }

  const keyboard = quotes.map((q) => ([
    { text: `${vehicleTypeLabel(q.vehicleType)} — R${q.price}${q.etaMin ? ` (~${q.etaMin}m)` : ''}`, callback_data: `veh:${q.vehicleType}:${q.price}` }
  ]));
  st.dynamicQuotes = quotes;
  st.step = 'selecting_vehicle';
  riderState.set(chatId, st);

  await riderBot.sendMessage(chatId, '🚘 Select your ride (based on nearby drivers):', { reply_markup: { inline_keyboard: keyboard } });
}

/* ---------- Create ride + fan-out to drivers ---------- */
async function createRideAndNotifyDrivers({ chatId, st, vehicleType, price }) {
  const ride = await Ride.create({
    riderChatId: chatId,
    pickup: st.pickup,
    destination: st.destination,
    vehicleType,
    estimate: Number(price),
    status: 'pending',
    createdAt: new Date(),
    source: 'telegram'
  });

  // Notify online drivers of this vehicle type (simple filter)
  const drivers = await Driver.find({
    isAvailable: true,
    vehicleType: vehicleType || 'normal',
    chatId: { $exists: true, $ne: null }
  }).select('chatId').limit(50).lean();

  for (const d of drivers) {
    try {
      await notifyDriverNewRequest({ chatId: Number(d.chatId), ride });
    } catch (e) {
      console.warn('notifyDriverNewRequest failed for driver', d.chatId, e?.message || e);
    }
  }

  return ride;
}

/* ---------------- Wire handlers once ---------------- */
function wireRiderHandlers() {
  if (globalThis.__riderBotSingleton.wired) return;
  globalThis.__riderBotSingleton.wired = true;

  // === when a driver accepts, inform the rider with driver details ===
  try {
    driverEvents.on('ride:accepted', async ({ driverId, rideId }) => {
      try {
        const ride = await Ride.findById(rideId).lean();
        if (!ride || !ride.riderChatId || !ride.driverId) return;

        const riderChatId = Number(ride.riderChatId);
        const driver = await Driver.findById(ride.driverId).lean();
        if (!driver) return;

        const card = formatDriverCardForRider({ driver, ride });
        await riderBot.sendMessage(
          riderChatId,
          `✅ <b>Driver assigned</b>\n${card}`,
          { parse_mode: 'HTML', disable_web_page_preview: true }
        );

        // Send driver photo to rider (optional)
        try {
          const photoUrl =
            driver?.documents?.driverProfilePhoto ||
            driver?.documents?.vehiclePhoto ||
            null;

          if (photoUrl) {
            await riderBot.sendPhoto(
              riderChatId,
              photoUrl,
              { caption: '🪪 Driver photo', parse_mode: 'HTML' }
            );
          }
        } catch (e) {
          console.warn('Failed to send driver photo to rider:', e?.message || e);
        }

        // Live map link to the rider **only after acceptance**
        if (PUBLIC_URL) {
          const base = `${PUBLIC_URL}/track.html?RideId=${encodeURIComponent(String(rideId))}`;
          const riderLink = `${PUBLIC_URL}/track.html?rideId=${encodeURIComponent(String(rideId))}&as=rider&riderChatId=${encodeURIComponent(String(riderChatId))}`;
          await riderBot.sendMessage(riderChatId, `🗺️ Live trip map:\n${riderLink}`);
        }
      } catch (e) {
        console.warn('riderBot driverEvents ride:accepted handler failed:', e?.message || e);
      }
    });
  } catch (e) {
    console.warn('driverEvents subscription failed (riderBot):', e?.message || e);
  }

  // /start with optional payload
  riderBot.onText(/\/start(?:\s+(.+))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    riderState.delete(chatId);

    const payload = (match && match[1]) ? String(match[1]).trim() : '';
    const m = /^ref[_\s-]*([A-Z0-9]{4,12})$/i.exec(payload);
    if (m) {
      const code = m[1].toUpperCase();
      pendingRefByChat.set(chatId, code);
    }

    const rider = await Rider.findOneAndUpdate(
      { chatId },
      { $setOnInsert: { platform: 'telegram' } },
      { new: true, upsert: true }
    );

    if (!rider?.name) {
      riderState.set(chatId, { step: 'awaiting_name' });
      await riderBot.sendMessage(chatId, '👋 Welcome! Please enter your full name to register:');
    } else {
      await riderBot.sendMessage(chatId, '👋 Welcome back! Choose an option:', {
        reply_markup: mainMenuKeyboard()
      });
    }

    // Prompt rating if there’s a completed trip without rating (last 48h)
    try {
      const since = new Date(Date.now() - 48 * 3600 * 1000);
      const lastUnrated = await Ride.findOne({
        riderChatId: chatId,
        status: 'completed',
        driverRating: { $in: [null, undefined] },
        completedAt: { $gte: since }
      }).sort({ completedAt: -1 }).lean();

      if (lastUnrated?._id) {
        const row = Array.from({ length: 5 }, (_, i) => {
          const n = i + 1;
          return [{ text: '★'.repeat(n), callback_data: `rate_driver:${String(lastUnrated._id)}:${n}` }];
        });
        await riderBot.sendMessage(chatId, 'Please rate your last driver:', {
          reply_markup: { inline_keyboard: row }
        });
      }
    } catch {}
  });

  riderBot.onText(/\/support|^support$|^help$|\/help/i, async (msg) => {
    await showSupport(msg.chat.id, 'command');
  });

  riderBot.on('message', async (msg) => {
    const chatId = msg.chat.id;

    if (msg.location) {
      const { latitude, longitude } = msg.location;
      await emitRiderLocation(chatId, { lat: latitude, lng: longitude });
    }

    const st = riderState.get(chatId);
    const text = (msg.text || '').trim();

    if (/^support$|^help$/i.test(text)) {
      await showSupport(chatId, 'keyword');
      return;
    }

    // Registration flow
    if (st && st.step && (st.step === 'awaiting_name' || st.step === 'awaiting_email')) {
      if (st.step === 'awaiting_name' && text) {
        st.name = text;
        st.step = 'awaiting_email';
        riderState.set(chatId, st);
        return riderBot.sendMessage(chatId, '📧 Enter your email address:');
      }
      if (st.step === 'awaiting_email' && text) {
        const dashboardToken = crypto.randomBytes(24).toString('hex');
        const dashboardPin = Math.floor(1000 + Math.random() * 9000).toString();
        const expiry = new Date(Date.now() + 10 * 60 * 1000);
        await Rider.findOneAndUpdate(
          { chatId },
          {
            $set: {
              name: st.name,
              email: text,
              dashboardToken,
              dashboardPin,
              dashboardTokenExpiry: expiry,
              platform: 'telegram'
            }
          },
          { upsert: true }
        );

        // Apply pending referral (if any)
        try {
          const fresh = await Rider.findOne({ chatId }).select('_id').lean();
          const pending = pendingRefByChat.get(chatId);
          if (fresh?._id && pending) {
            await applyReferrerRewardByCode(pending, fresh._id);
          }
        } catch {}
        pendingRefByChat.delete(chatId);

        riderState.delete(chatId);
        const link = `${PUBLIC_URL}/rider-dashboard.html?token=${dashboardToken}`;
        return riderBot.sendMessage(
          chatId,
          `✅ Registration complete!\n\n🔐 Dashboard link:\n${link}\n\n🔢 Your PIN: <b>${dashboardPin}</b>\n⏱️ Expires in 10 mins`,
          { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
        );
      }
      return;
    }

    /* ---------------- BOOKING FLOW (messages) ---------------- */
    if (!st || !st.step) return; // no active booking context

    // PICKUP text / location
    if (st.step === 'awaiting_pickup') {
      if (msg.location) {
        st.pickup = { lat: msg.location.latitude, lng: msg.location.longitude };
        st.step = 'awaiting_drop';
        riderState.set(chatId, st);
        return askDrop(chatId);
      }
      if (isLikelyQuery(text)) {
        const preds = await gmapsAutocomplete(text, {});
        st.pickupPredictions = preds;
        riderState.set(chatId, st);
        return showAddressSuggestions(chatId, preds, 'pickup');
      }
      return riderBot.sendMessage(chatId, 'Please send your pickup location or type an address.');
    }

    // DROP text / location
    if (st.step === 'awaiting_drop') {
      if (msg.location) {
        st.destination = { lat: msg.location.latitude, lng: msg.location.longitude };
        riderState.set(chatId, st);
        return showQuotesOrRetry(chatId, st);
      }
      if (isLikelyQuery(text)) {
        const preds = await gmapsAutocomplete(text, {});
        st.dropPredictions = preds;
        riderState.set(chatId, st);
        return showAddressSuggestions(chatId, preds, 'drop');
      }
      return riderBot.sendMessage(chatId, 'Please send your destination or type an address.');
    }

    // selecting_vehicle is handled in callback_query
  });

  riderBot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = String(query.data || '');

    try {
      if (data === 'open_dashboard') {
        await sendDashboardLink(chatId);
        try { await riderBot.answerCallbackQuery(query.id); } catch {}
        return;
      }
      if (data === 'support') {
        await showSupport(chatId, 'menu');
        try { await riderBot.answerCallbackQuery(query.id); } catch {}
        return;
      }

      /* -------- BOOKING FLOW (callbacks) -------- */
      if (data === 'book_trip') {
        // start booking
        riderState.set(chatId, { step: 'awaiting_pickup' });
        await riderBot.answerCallbackQuery(query.id);
        return askPickup(chatId);
      }

      const st = riderState.get(chatId) || {};

      // choose pickup from suggestions
      if (data.startsWith('pick_idx:')) {
        const i = Number(data.split(':')[1]);
        const pred = st.pickupPredictions?.[i];
        if (!pred) { try { await riderBot.answerCallbackQuery(query.id, { text: 'Not found' }); } catch {} return; }
        const place = await gmapsPlaceLatLng(pred.place_id, {});
        if (!place) { try { await riderBot.answerCallbackQuery(query.id, { text: 'Lookup failed' }); } catch {} return; }
        st.pickup = { lat: place.lat, lng: place.lng, address: place.address };
        st.step = 'awaiting_drop';
        riderState.set(chatId, st);
        try { await riderBot.answerCallbackQuery(query.id); } catch {}
        await riderBot.sendMessage(chatId, `✅ Pickup set: ${place.address || `${place.lat},${place.lng}`}`);
        return askDrop(chatId);
      }

      // choose drop from suggestions
      if (data.startsWith('drop_idx:')) {
        const i = Number(data.split(':')[1]);
        const pred = st.dropPredictions?.[i];
        if (!pred) { try { await riderBot.answerCallbackQuery(query.id, { text: 'Not found' }); } catch {} return; }
        const place = await gmapsPlaceLatLng(pred.place_id, {});
        if (!place) { try { await riderBot.answerCallbackQuery(query.id, { text: 'Lookup failed' }); } catch {} return; }
        st.destination = { lat: place.lat, lng: place.lng, address: place.address };
        riderState.set(chatId, st);
        try { await riderBot.answerCallbackQuery(query.id); } catch {}
        await riderBot.sendMessage(chatId, `✅ Destination set: ${place.address || `${place.lat},${place.lng}`}`);
        return showQuotesOrRetry(chatId, st);
      }

      // choose vehicle option
      if (data.startsWith('veh:')) {
        const [, vt, price] = data.split(':');
        if (!st.pickup || !st.destination) {
          try { await riderBot.answerCallbackQuery(query.id, { text: 'Missing pickup/drop' }); } catch {}
          return;
        }
        try { await riderBot.answerCallbackQuery(query.id, { text: 'Requesting driver…' }); } catch {}

        const ride = await createRideAndNotifyDrivers({
          chatId,
          st,
          vehicleType: vt || 'normal',
          price: Number(price)
        });

        // reset state for this chat (booking handed to backend)
        riderState.delete(chatId);

        const msg =
          '📨 <b>Request sent</b>\n' +
          'Waiting for a driver to accept…\n' +
          (st.pickup?.address ? `\nPickup: ${st.pickup.address}` : '') +
          (st.destination?.address ? `\nDrop: ${st.destination.address}` : '');

        await riderBot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
        return;
      }

      // ratings etc handled elsewhere
    } catch (e) {
      console.warn('riderBot callback error:', e?.message || e);
      try { await riderBot.answerCallbackQuery(query.id, { text: '⚠️ Error' }); } catch {}
    }
  });
}

/* ---------------- Public helpers ---------------- */
export async function notifyRiderToRateDriver(rideIdOrRide) {
  // Exposed for the /finish endpoint
  const ride = typeof rideIdOrRide === 'object' ? rideIdOrRide
              : await Ride.findById(rideIdOrRide).lean();
  if (!ride || !ride.riderChatId) return;
  const row = Array.from({ length: 5 }, (_, i) => {
    const n = i + 1;
    return [{ text: '★'.repeat(n), callback_data: `rate_driver:${String(ride._id)}:${n}` }];
  });
  try {
    await riderBot.sendMessage(
      Number(ride.riderChatId),
      'How was your driver? Please rate:',
      { reply_markup: { inline_keyboard: row } }
    );
  } catch {}
}

export function initRiderBot({ io, app } = {}) {
  ioRef = io || ioRef;

  if (globalThis.__riderBotSingleton.started && riderBot) {
    console.log('🧍 Rider bot already initialized (singleton)');
    return riderBot;
  }

  const tokenTail = token.slice(-6);
  if (MODE === 'webhook') {
    if (!app) throw new Error('Rider bot webhook mode requires an Express app instance');
    if (!PUBLIC_URL) throw new Error('PUBLIC_URL must be set for webhook mode');

    riderBot = new TelegramBot(token, { polling: false });
    riderBot.setWebHook(`${PUBLIC_URL}${RIDER_WEBHOOK_PATH}`)
      .then(() => console.log(`🧍 Rider webhook set (pid=${process.pid}, token=***${tokenTail}, path=${RIDER_WEBHOOK_PATH})`))
      .catch((e) => console.error('Rider setWebHook error:', e));

    app.post(RIDER_WEBHOOK_PATH, (req, res) => {
      riderBot.processUpdate(req.body);
      res.sendStatus(200);
    });
  } else {
    riderBot = new TelegramBot(token, {
      polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 10, allowed_updates: ['message', 'edited_message', 'callback_query'] }
      }
    });
    console.log(`🧍 Starting rider bot polling (pid=${process.pid}, token=***${tokenTail})`);
  }

  globalThis.__riderBotSingleton.bot = riderBot;
  globalThis.__riderBotSingleton.started = true;

  wireRiderHandlers();

  console.log('🧍 Rider bot initialized');
  return riderBot;
}

export { riderBot };
