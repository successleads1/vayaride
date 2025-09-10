// src/bots/riderBot.js
import TelegramBot from 'node-telegram-bot-api';
import EventEmitter from 'events';
import crypto from 'crypto';
import fetch from 'node-fetch';

import { getAvailableVehicleQuotes } from '../services/pricing.js';
import Ride from '../models/Ride.js';
import Rider from '../models/Rider.js';
import { sendAdminEmailToDrivers } from '../services/mailer.js';

export const riderEvents = new EventEmitter();

// ---- Singleton container (survives duplicate imports) ----
if (!globalThis.__riderBotSingleton) {
  globalThis.__riderBotSingleton = { bot: null, wired: false, started: false };
}

let riderBot = globalThis.__riderBotSingleton.bot;
let ioRef = null;

const MODE = process.env.TELEGRAM_MODE || 'polling'; // 'polling' | 'webhook'
const token = process.env.TELEGRAM_RIDER_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_RIDER_BOT_TOKEN is not defined in .env');

const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
const RIDER_WEBHOOK_PATH = process.env.TELEGRAM_RIDER_WEBHOOK_PATH || '/telegram/rider';

const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || 'admin@vayaride.co.za').trim();
const TG_HELPDESK_URL = (process.env.TELEGRAM_HELPDESK_URL || 'https://t.me/yourSupportBot').trim();

// ✅ Force ZA by default; can override via env
const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const GMAPS_COMPONENTS = process.env.GOOGLE_MAPS_COMPONENTS || 'country:za';
const GMAPS_LANGUAGE = process.env.GOOGLE_MAPS_LANGUAGE || 'en-ZA';
const GMAPS_REGION = process.env.GOOGLE_MAPS_REGION || 'za';

// South Africa centroid (for biasing)
const ZA_CENTER = { lat: -28.4793, lng: 24.6727 };
const ZA_RADIUS_M = 1_500_000; // ~1500km

/* ---------- In-memory state per chat ---------- */
const riderState = new Map();

/* ---------- Utils ---------- */
const crop = (s, n = 48) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const generatePIN = () => Math.floor(1000 + Math.random() * 9000).toString();
const generateToken = () => crypto.randomBytes(24).toString('hex');

/* ---------- Shortcut expansions (UCT/UWC/CPUT/etc.) ---------- */
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

/* ---------- Looser address detector (accepts acronyms) ---------- */
function isLikelyQuery(t) {
  if (!t) return false;
  const s = String(t).trim();
  if (!/[a-z]/i.test(s)) return false;
  if (/\d/.test(s) || /\s/.test(s)) return true;     // street-like
  if (s.length >= 3) return true;                    // short tokens like "uct"
  if (ZA_SHORTCUTS[s.toLowerCase()]) return true;    // explicit shortcut
  return false;
}

/* ---------- Rating UI helper ---------- */
function riderStarsKeyboard(rideId) {
  const row = Array.from({ length: 5 }, (_, i) => {
    const n = i + 1;
    return { text: '★'.repeat(n), callback_data: `rate_driver:${rideId}:${n}` };
  });
  return { reply_markup: { inline_keyboard: [row] } };
}

/* ---------- Google helpers (ZA-restricted) ---------- */
async function gmapsAutocomplete(input, { sessiontoken } = {}) {
  if (!GMAPS_KEY) return [];
  const expanded = expandShortcut(input);
  const maybeBoosted = boostToZA(expanded);

  const u = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
  u.searchParams.set('input', maybeBoosted);
  u.searchParams.set('key', GMAPS_KEY);
  u.searchParams.set('components', GMAPS_COMPONENTS); // country:za
  u.searchParams.set('language', GMAPS_LANGUAGE);     // en-ZA
  u.searchParams.set('region', GMAPS_REGION);         // za
  u.searchParams.set('location', `${ZA_CENTER.lat},${ZA_CENTER.lng}`);
  u.searchParams.set('radius', String(ZA_RADIUS_M));
  u.searchParams.set('strictbounds', 'true');
  if (sessiontoken) u.searchParams.set('sessiontoken', sessiontoken);

  try {
    const r = await fetch(u.toString());
    const j = await r.json();
    if (j.status !== 'OK' && j.status !== 'ZERO_RESULTS') {
      console.warn('gmapsAutocomplete status', j.status, j.error_message);
    }
    let preds = Array.isArray(j.predictions) ? j.predictions : [];

    if (!preds.length && expanded === input) {
      const u2 = new URL(u);
      u2.searchParams.set('input', `${expanded} South Africa`);
      const r2 = await fetch(u2.toString());
      const j2 = await r2.json();
      preds = Array.isArray(j2.predictions) ? j2.predictions : [];
    }
    return preds;
  } catch (e) {
    console.warn('gmapsAutocomplete error', e?.message || e);
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
    if (j.status !== 'OK') {
      console.warn('gmapsPlaceLatLng status', j.status, j.error_message);
      return null;
    }
    const loc = j.result?.geometry?.location;
    if (!loc) return null;
    const addr = j.result?.formatted_address || j.result?.name || '';
    return {
      lat: Number(loc.lat),
      lng: Number(loc.lng),
      name: j.result?.name || '',
      address: addr
    };
  } catch (e) {
    console.warn('gmapsPlaceLatLng error', e?.message || e);
    return null;
  }
}

/* ---------- Dashboard link ---------- */
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

/* ---------- Live rider location ---------- */
async function emitRiderLocation(chatId, loc) {
  await Rider.findOneAndUpdate(
    { chatId },
    { $set: { lastLocation: { ...loc, ts: new Date() }, lastSeenAt: new Date(), platform: 'telegram' } },
    { upsert: true }
  );
  try { ioRef?.emit('rider:location', { chatId, location: loc }); } catch {}
}

/* ---------- Support helpers ---------- */
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
  } catch (e) {
    console.warn('Support email trigger failed:', e?.message || e);
  }
}

async function showSupport(chatId, context = 'menu') {
  const msg =
    `🧑‍💼 <b>Support</b>\n` +
    `If you’re having issues:\n\n` +
    `• Email: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>\n` +
    
    `We’re here to help.`;
  await riderBot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
  // Notify admin team
  await triggerSupportEmail(chatId, `User opened Support (${context})`);
}

/* ---------- UX prompts ---------- */
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

/* ---------- Wire handlers once ---------- */
function wireRiderHandlers() {
  if (globalThis.__riderBotSingleton.wired) return;
  globalThis.__riderBotSingleton.wired = true;

  // /start
  riderBot.onText(/\/start/i, async (msg) => {
    const chatId = msg.chat.id;
    riderState.delete(chatId);

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
        await riderBot.sendMessage(chatId, 'Please rate your last driver:', {
          reply_markup: riderStarsKeyboard(String(lastUnrated._id)).reply_markup
        });
      }
    } catch {}
  });

  // /help or /support from text
  riderBot.onText(/\/support|^support$|^help$|\/help/i, async (msg) => {
    const chatId = msg.chat.id;
    await showSupport(chatId, 'command');
  });

  riderBot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (msg.location) {
      const { latitude, longitude } = msg.location;
      await emitRiderLocation(chatId, { lat: latitude, lng: longitude });
    }

    const state = riderState.get(chatId);
    const text = (msg.text || '').trim();

    // quick support keyword while in any state
    if (/^support$|^help$/i.test(text)) {
      await showSupport(chatId, 'keyword');
      return;
    }

    if (state && state.step) {
      if (state.step === 'awaiting_name' && text) {
        state.name = text;
        state.step = 'awaiting_email';
        riderState.set(chatId, state);
        return riderBot.sendMessage(chatId, '📧 Enter your email address:');
      }
      if (state.step === 'awaiting_email' && text) {
        // Finish registration WITHOUT any credit flow
        const dashboardToken = crypto.randomBytes(24).toString('hex');
        const dashboardPin = Math.floor(1000 + Math.random() * 9000).toString();
        const expiry = new Date(Date.now() + 10 * 60 * 1000);

        await Rider.findOneAndUpdate(
          { chatId },
          {
            $set: {
              name: state.name,
              email: text,
              dashboardToken,
              dashboardPin,
              dashboardTokenExpiry: expiry,
              platform: 'telegram'
            }
          },
          { upsert: true }
        );

        riderState.delete(chatId);

        const link = `${PUBLIC_URL}/rider-dashboard.html?token=${dashboardToken}`;
        return riderBot.sendMessage(
          chatId,
          `✅ Registration complete!\n\n🔐 Dashboard link:\n${link}\n\n🔢 Your PIN: <b>${dashboardPin}</b>\n⏱️ Expires in 10 mins`,
          {
            parse_mode: 'HTML',
            reply_markup: mainMenuKeyboard()
          }
        );
      }
    }

    const st = riderState.get(chatId);
    if (st && (st.step === 'awaiting_pickup' || st.step === 'awaiting_drop')) {
      const typed = (msg.text || '').trim();
      if (typed && isLikelyQuery(typed)) {
        const sessiontoken = crypto.randomBytes(16).toString('hex');
        const preds = await gmapsAutocomplete(typed, { sessiontoken });
        st.gmapsSession = sessiontoken;
        st.predictions = preds; // save for index callback
        riderState.set(chatId, st);
        await showAddressSuggestions(chatId, preds, st.step === 'awaiting_pickup' ? 'pickup' : 'drop');
        return;
      }
      if (!msg.location) return;
    }
  });

  riderBot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data || '';

    try {
      if (data === 'open_dashboard') {
        await sendDashboardLink(chatId);
        return;
      }

      if (data === 'book_trip') {
        const rider = await Rider.findOne({ chatId });
        if (!rider || !rider.name) {
          riderState.set(chatId, { step: 'awaiting_name' });
          return riderBot.sendMessage(chatId, '🚨 Please register first. Enter your full name:');
        }
        riderState.set(chatId, { step: 'awaiting_pickup' });
        await askPickup(chatId);
        return;
      }

      if (data === 'support') {
        await showSupport(chatId, 'menu button');
        return;
      }

      /* ======= pickup/destination via short indices ======= */
      if (data.startsWith('pick_idx:')) {
        const idx = Number(data.split(':')[1] || -1);
        const st = riderState.get(chatId) || { step: 'awaiting_pickup' };
        const arr = Array.isArray(st.predictions) ? st.predictions : [];
        const choice = arr[idx];
        if (!choice?.place_id) {
          await riderBot.sendMessage(chatId, '⚠️ Selection expired. Please type your pickup again or share your location.');
          return askPickup(chatId);
        }
        const loc = await gmapsPlaceLatLng(choice.place_id, { sessiontoken: st.gmapsSession });
        if (!loc) {
          await riderBot.sendMessage(chatId, '❌ Could not resolve that address (ZA). Please try again or send your location.');
          return askPickup(chatId);
        }
        st.pickup = { lat: loc.lat, lng: loc.lng };
        st.step = 'awaiting_drop';
        st.predictions = [];
        riderState.set(chatId, st);
        await riderBot.sendMessage(chatId, `✅ Pickup set to: ${loc.address || `(${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)})`}`);
        return askDrop(chatId);
      }

      if (data.startsWith('drop_idx:')) {
        const idx = Number(data.split(':')[1] || -1);
        const st = riderState.get(chatId);
        if (!st || !st.pickup) {
          riderState.set(chatId, { step: 'awaiting_pickup' });
          await riderBot.sendMessage(chatId, '⚠️ Session expired. Please set pickup again.');
          return askPickup(chatId);
        }
        const arr = Array.isArray(st.predictions) ? st.predictions : [];
        const choice = arr[idx];
        if (!choice?.place_id) {
          await riderBot.sendMessage(chatId, '⚠️ Selection expired. Please type your destination again or share your location.');
          return askDrop(chatId);
        }
        const loc = await gmapsPlaceLatLng(choice.place_id, { sessiontoken: st.gmapsSession });
        if (!loc) {
          await riderBot.sendMessage(chatId, '❌ Could not resolve that address (ZA). Please try again or send your location.');
          return askDrop(chatId);
        }

        st.destination = { lat: loc.lat, lng: loc.lng };
        st.step = 'selecting_vehicle';
        st.predictions = [];
        riderState.set(chatId, st);

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

        const toLabel = (vt) => vt === 'comfort' ? 'Comfort' : vt === 'luxury' ? 'Luxury' : vt === 'xl' ? 'XL' : 'Normal';
        const keyboard = quotes.map((q) => ([{ text: `${toLabel(q.vehicleType)} — R${q.price}`, callback_data: `veh:${q.vehicleType}:${q.price}` }]));
        st.dynamicQuotes = quotes;
        riderState.set(chatId, st);

        await riderBot.sendMessage(chatId, '🚘 Select your ride (based on nearby drivers):', { reply_markup: { inline_keyboard: keyboard } });
        return;
      }
      /* ======= END new index handlers ======= */

      // Back-compat: old long payloads (safe to keep)
      if (data.startsWith('pick_place:')) {
        const placeId = data.split(':')[1];
        const st = riderState.get(chatId) || { step: 'awaiting_pickup' };
        const loc = await gmapsPlaceLatLng(placeId, { sessiontoken: st.gmapsSession });
        if (!loc) {
          await riderBot.sendMessage(chatId, '❌ Could not resolve that address (ZA). Please try again or send your location.');
          return askPickup(chatId);
        }
        st.pickup = { lat: loc.lat, lng: loc.lng };
        st.step = 'awaiting_drop';
        riderState.set(chatId, st);
        await riderBot.sendMessage(chatId, `✅ Pickup set to: ${loc.address || `(${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)})`}`);
        return askDrop(chatId);
      }

      if (data.startsWith('drop_place:')) {
        const placeId = data.split(':')[1];
        const st = riderState.get(chatId);
        if (!st || !st.pickup) {
          riderState.set(chatId, { step: 'awaiting_pickup' });
          await riderBot.sendMessage(chatId, '⚠️ Session expired. Please set pickup again.');
          return askPickup(chatId);
        }
        const loc = await gmapsPlaceLatLng(placeId, { sessiontoken: st.gmapsSession });
        if (!loc) {
          await riderBot.sendMessage(chatId, '❌ Could not resolve that address (ZA). Please try again or send your location.');
          return askDrop(chatId);
        }

        st.destination = { lat: loc.lat, lng: loc.lng };
        st.step = 'selecting_vehicle';
        riderState.set(chatId, st);

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

        const toLabel = (vt) => vt === 'comfort' ? 'Comfort' : vt === 'luxury' ? 'Luxury' : vt === 'xl' ? 'XL' : 'Normal';
        const keyboard = quotes.map((q) => ([{ text: `${toLabel(q.vehicleType)} — R${q.price}`, callback_data: `veh:${q.vehicleType}:${q.price}` }]));
        st.dynamicQuotes = quotes;
        riderState.set(chatId, st);

        await riderBot.sendMessage(chatId, '🚘 Select your ride (based on nearby drivers):', { reply_markup: { inline_keyboard: keyboard } });
        return;
      }

      if (data.startsWith('veh:')) {
        const [, vehicleType, priceStr] = data.split(':');
        const price = Number(priceStr);
        const st = riderState.get(chatId);

        if (!st || !st.pickup || !st.destination || Number.isNaN(price)) {
          riderState.set(chatId, { step: 'awaiting_pickup' });
          await riderBot.sendMessage(chatId, '⚠️ Session expired. Please send your pickup location again.');
          return askPickup(chatId);
        }

        const ride = await Ride.create({
          riderChatId: chatId,
          pickup: st.pickup,
          destination: st.destination,
          estimate: price,
          vehicleType,
          status: 'payment_pending',
          paymentMethod: 'payfast',
          platform: 'telegram'
        });

        const payfastRedirect = `${PUBLIC_URL}/pay/${ride._id}`;

        await riderBot.sendMessage(chatId, '💳 Choose your payment method:', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💵 Cash', callback_data: `pay_cash_${ride._id}` }],
              [{ text: '💳 Pay with Card (Payfast)', url: payfastRedirect }]
            ]
          }
        });

        riderState.set(chatId, {
          ...st,
          step: 'awaiting_payment',
          chosenVehicleType: vehicleType,
          rideId: String(ride._id)
        });

        return;
      }

      // ⭐ rider rates driver
      if (data.startsWith('rate_driver:')) {
        const [, rideId, starsStr] = data.split(':');
        const stars = Number(starsStr);
        if (!(stars >= 1 && stars <= 5)) { try { await riderBot.answerCallbackQuery(query.id, { text: 'Invalid rating' }); } catch {} return; }

        const ride = await Ride.findById(rideId);
        if (!ride) { try { await riderBot.answerCallbackQuery(query.id, { text: 'Ride not found' }); } catch {} return; }
        if (String(ride.riderChatId) !== String(chatId)) { try { await riderBot.answerCallbackQuery(query.id, { text: 'Not your ride' }); } catch {} return; }

        ride.driverRating = stars;
        ride.driverRatedAt = new Date();
        await ride.save();

        try {
          if (ride.driverId) {
            const { default: Driver } = await import('../models/Driver.js');
            await Driver.computeAndUpdateStats(ride.driverId);
          }
        } catch {}

        try { await riderBot.answerCallbackQuery(query.id, { text: `Thanks! You rated ${stars}★` }); } catch {}
        await riderBot.sendMessage(chatId, `✅ Rating saved: ${'★'.repeat(stars)}`);
        return;
      }

    } catch (err) {
      console.error('rider callback_query error:', err);
      try { await riderBot.answerCallbackQuery(query.id, { text: '⚠️ Error. Try again.' }); } catch {}
      await riderBot.sendMessage(chatId, '⚠️ Something went wrong. Please try again.');
    }
  });

  riderBot.on('location', async (msg) => {
    const chatId = msg.chat.id;
    const { latitude, longitude } = msg.location || {};
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return;

    const coords = { lat: latitude, lng: longitude };
    await emitRiderLocation(chatId, coords);

    const state = riderState.get(chatId);
    if (!state) return;

    if (state.step === 'awaiting_pickup') {
      state.pickup = coords;
      state.step = 'awaiting_drop';
      riderState.set(chatId, state);
      await riderBot.sendMessage(chatId, '📍 Pickup saved.');
      return askDrop(chatId);
    }

    if (state.step === 'awaiting_drop') {
      state.destination = coords;
      state.step = 'selecting_vehicle';

      let quotes = [];
      try {
        quotes = await getAvailableVehicleQuotes({
          pickup: state.pickup, destination: state.destination, radiusKm: 30
        });
      } catch (e) { console.error('getAvailableVehicleQuotes failed:', e); }

      if (!quotes.length) {
        state.step = 'awaiting_pickup';
        riderState.set(chatId, state);
        await riderBot.sendMessage(chatId, '😞 No drivers are currently available nearby. Please try again.');
        return askPickup(chatId);
      }

      const toLabel = (vt) => vt === 'comfort' ? 'Comfort' : vt === 'luxury' ? 'Luxury' : vt === 'xl' ? 'XL' : 'Normal';
      const keyboard = quotes.map((q) => ([{ text: `${toLabel(q.vehicleType)} — R${q.price}`, callback_data: `veh:${q.vehicleType}:${q.price}` }]));
      state.dynamicQuotes = quotes;
      riderState.set(chatId, state);

      await riderBot.sendMessage(chatId, '🚘 Select your ride (based on nearby drivers):', { reply_markup: { inline_keyboard: keyboard } });
    }
  });

  riderBot.on('edited_message', async (msg) => {
    if (!msg?.location) return;
    const chatId = msg.chat.id;
    const { latitude, longitude } = msg.location;
    await emitRiderLocation(chatId, { lat: latitude, lng: longitude });
  });
}

/* ---------- Notifier: ask rider to rate driver (exported) ---------- */
export async function notifyRiderToRateDriver(ride) {
  try {
    const chatId = ride.riderChatId;
    if (!chatId) return;
    await riderBot.sendMessage(chatId, 'Your trip is complete. Please rate your driver:', riderStarsKeyboard(String(ride._id)));
  } catch (e) {
    console.warn('notifyRiderToRateDriver failed:', e?.message || e);
  }
}

/* ---------- Init ---------- */
export function initRiderBot({ io, app } = {}) {
  ioRef = io || ioRef;

  if (globalThis.__riderBotSingleton.started && riderBot) {
    console.log('🤖 Rider bot already initialized (singleton)'); 
    return riderBot;
  }

  const tokenTail = token.slice(-6);
  if (MODE === 'webhook') {
    if (!app) throw new Error('Rider bot webhook mode requires an Express app instance');
    if (!PUBLIC_URL) throw new Error('PUBLIC_URL must be set for webhook mode');

    riderBot = new TelegramBot(token, { polling: false });
    riderBot.setWebHook(`${PUBLIC_URL}${RIDER_WEBHOOK_PATH}`)
      .then(() => console.log(`🤖 Rider webhook set (pid=${process.pid}, token=***${tokenTail}, path=${RIDER_WEBHOOK_PATH})`))
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
    console.log(`🤖 Starting rider bot polling (pid=${process.pid}, token=***${tokenTail})`);
  }

  globalThis.__riderBotSingleton.bot = riderBot;
  globalThis.__riderBotSingleton.started = true;

  wireRiderHandlers();

  console.log('🤖 Rider bot initialized');
  return riderBot;
}

export { riderBot };
