// src/bots/riderBot.js
// VayaRide – Rider Telegram Bot (ESM)
//
// Key change in this version:
// - Quotes now come from getAvailableVehicleQuotes (pricing.js), so each
//   vehicle type shows its correct, dynamic price (driver pricing + pickup
//   distance + traffic + surge). No more flat/same price across types.

import TelegramBot from 'node-telegram-bot-api';
import EventEmitter from 'events';
import crypto from 'crypto';
import fetch from 'node-fetch';

import Ride from '../models/Ride.js';
import Rider from '../models/Rider.js';
import Driver from '../models/Driver.js';

import { notifyDriverNewRequest, driverEvents } from './driverBot.js';
import { sendAdminEmailToDrivers } from '../services/mailer.js';

// ✅ use the real quote engine
import { getAvailableVehicleQuotes } from '../services/pricing.js';

/* ────────────────────────────────────────────────────────────────────────────
   Singleton
──────────────────────────────────────────────────────────────────────────── */
export const riderEvents = new EventEmitter();

if (!globalThis.__riderBotSingleton) {
  globalThis.__riderBotSingleton = { bot: null, wired: false, started: false };
}

let riderBot = globalThis.__riderBotSingleton.bot;
let ioRef = null;

/* ────────────────────────────────────────────────────────────────────────────
   Env
──────────────────────────────────────────────────────────────────────────── */
const MODE = process.env.TELEGRAM_MODE || 'polling';
const token = process.env.TELEGRAM_RIDER_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_RIDER_BOT_TOKEN is not defined in .env');

const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
const RIDER_WEBHOOK_PATH = process.env.TELEGRAM_RIDER_WEBHOOK_PATH || '/telegram/rider';
const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || 'admin@vayaride.co.za').trim();

// Optional Google Places (ZA bias)
const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const GMAPS_COMPONENTS = process.env.GOOGLE_MAPS_COMPONENTS || 'country:za';
const GMAPS_LANGUAGE = process.env.GOOGLE_MAPS_LANGUAGE || 'en-ZA';
const GMAPS_REGION = process.env.GOOGLE_MAPS_REGION || 'za';
const ZA_CENTER = { lat: -28.4793, lng: 24.6727 };
const ZA_RADIUS_M = 1_500_000;

/* ────────────────────────────────────────────────────────────────────────────
   In-memory state
──────────────────────────────────────────────────────────────────────────── */
const riderState = new Map();
/** Track message ids we sent, so we can wipe the chat UI (client side). */
const sentByBot = new Map(); // chatId -> [message_id]

function trackSent(chatId, messageId) {
  if (!messageId) return;
  const arr = sentByBot.get(chatId) || [];
  arr.push(messageId);
  if (arr.length > 200) arr.splice(0, arr.length - 200);
  sentByBot.set(chatId, arr);
}
async function clearScreen(chatId) {
  const ids = (sentByBot.get(chatId) || []).slice().reverse();
  for (const id of ids) {
    try { await riderBot.deleteMessage(chatId, id); } catch {}
  }
  sentByBot.set(chatId, []);
}
async function startFresh(chatId) {
  riderState.delete(chatId);
  await clearScreen(chatId);
  await riderBot.sendMessage(chatId, '🔄 Started fresh. Choose an option:', {
    reply_markup: mainMenuKeyboard()
  });
}

/* ────────────────────────────────────────────────────────────────────────────
   Helpers
──────────────────────────────────────────────────────────────────────────── */
const VEHICLE_LABEL = (t) =>
  t === 'comfort' ? 'Comfort' :
  t === 'luxury'  ? 'Luxury'  :
  t === 'xl'      ? 'XL'      : 'Normal';

const crop = (s, n = 56) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

function toMap({ lat, lng }) { return `https://maps.google.com/?q=${lat},${lng}`; }

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🚕 Book Trip', callback_data: 'book_trip' }],
      [{ text: '🗓️ Prebook Trip', callback_data: 'prebook_trip' }],
      [{ text: '👤 Profile', callback_data: 'open_dashboard' }],
      [{ text: '🧑‍💼 Support', callback_data: 'support' }],
      [{ text: '🔄 Start fresh', callback_data: 'start_fresh' }],
    ]
  };
}

function afterFirstAddressControls(kind) {
  return {
    inline_keyboard: [
      [{ text: '🔄 Start fresh', callback_data: 'start_fresh' }],
      [{ text: '❌ Cancel booking', callback_data: 'cancel_booking' }],
    ]
  };
}

/* ────────────────────────────────────────────────────────────────────────────
   Google Places helpers (ZA focus)
──────────────────────────────────────────────────────────────────────────── */
async function gmapsAutocomplete(input, { sessiontoken } = {}) {
  if (!GMAPS_KEY) return [];
  const u = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
  u.searchParams.set('input', String(input));
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
    return Array.isArray(j.predictions) ? j.predictions : [];
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
    return {
      lat: Number(loc.lat),
      lng: Number(loc.lng),
      address: j.result?.formatted_address || j.result?.name || ''
    };
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   UX prompts
──────────────────────────────────────────────────────────────────────────── */
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

function confirmPickupKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '✅ Looks correct', callback_data: 'confirm_pickup_yes' },
        { text: '✏️ Correct pickup', callback_data: 'correct_pickup' }
      ],
      [{ text: '❌ Cancel booking', callback_data: 'cancel_booking' }],
    ]
  };
}
function confirmDropKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '✅ Looks correct', callback_data: 'confirm_drop_yes' },
        { text: '✏️ Correct destination', callback_data: 'correct_drop' }
      ],
      [{ text: '❌ Cancel booking', callback_data: 'cancel_booking' }],
    ]
  };
}
function reviewTripKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🚀 Continue', callback_data: 'review_proceed' }],
      [
        { text: '✏️ Fix pickup', callback_data: 'review_correct_pickup' },
        { text: '✏️ Fix destination', callback_data: 'review_correct_drop' }
      ],
      [{ text: '🔄 Start fresh', callback_data: 'start_fresh' }],
      [{ text: '❌ Cancel booking', callback_data: 'cancel_booking' }],
    ]
  };
}
function payMethodKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '💵 Cash', callback_data: 'pay:cash' },
        { text: '💳 PayFast (Card)', callback_data: 'pay:payfast' }
      ],
      [{ text: '🔄 Start fresh', callback_data: 'start_fresh' }],
      [{ text: '❌ Cancel booking', callback_data: 'cancel_booking' }],
    ]
  };
}
function waitingKeyboard(rideId) {
  return {
    inline_keyboard: [
      [{ text: '❌ Cancel request', callback_data: `cancel_request:${rideId}` }],
      [{ text: '🔄 Start fresh', callback_data: 'start_fresh' }],
    ]
  };
}

/* ────────────────────────────────────────────────────────────────────────────
   Support & dashboard
──────────────────────────────────────────────────────────────────────────── */
async function showSupport(chatId, context = 'menu') {
  const msg =
    `🧑‍💼 <b>Support</b>\n` +
    `• Email: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>\n` +
    `We’re here to help.`;
  await riderBot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
  try {
    await sendAdminEmailToDrivers(SUPPORT_EMAIL, {
      subject: 'Telegram Support Request — VayaRide',
      html:
        `<p>Rider opened Support via Telegram.</p>
         <p><b>Chat ID:</b> ${chatId}<br/><b>When:</b> ${new Date().toLocaleString()}</p>`
    });
  } catch {}
}
async function sendDashboardLink(chatId) {
  if (!PUBLIC_URL) return;
  const dashboardToken = crypto.randomBytes(24).toString('hex');
  const dashboardPin = Math.floor(1000 + Math.random() * 9000).toString();
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

/* ────────────────────────────────────────────────────────────────────────────
   Address suggestion UI
──────────────────────────────────────────────────────────────────────────── */
async function showAddressSuggestions(chatId, predictions, kind) {
  if (!predictions.length) {
    await riderBot.sendMessage(
      chatId,
      '😕 No matching addresses in South Africa. Try a clearer address or share your live location (📎).',
      { reply_markup: afterFirstAddressControls(kind) }
    );
    return;
  }
  const prefix = kind === 'pickup' ? 'pick_idx' : 'drop_idx';
  const kb = predictions.slice(0, 8).map((p, i) => ([{ text: crop(p.description, 56), callback_data: `${prefix}:${i}` }]));
  await riderBot.sendMessage(
    chatId,
    `🔎 Select your ${kind === 'pickup' ? 'pickup' : 'destination'} (ZA):`,
    { reply_markup: { inline_keyboard: kb } }
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Quotes UI (NOW USING pricing.getAvailableVehicleQuotes)
──────────────────────────────────────────────────────────────────────────── */
async function showQuotes(chatId, st) {
  try {
    const quotes = await getAvailableVehicleQuotes({
      pickup: st.pickup,
      destination: st.destination,
      radiusKm: 30,
    });

    if (!quotes.length) {
      await riderBot.sendMessage(
        chatId,
        '🚘 No drivers are currently available nearby. Please try again shortly.',
        { reply_markup: reviewTripKeyboard() }
      );
      return;
    }

    // quotes are already the cheapest per vehicleType; sort is by price asc
    const rows = quotes.map(q => ([
      { text: `${VEHICLE_LABEL(q.vehicleType)} — R${q.price}${q.driverCount ? ` (drivers: ${q.driverCount})` : ''}`,
        callback_data: `veh:${q.vehicleType}:${q.price}` }
    ]));

    // Keep the quotes in state in case you want to reuse later
    st.dynamicQuotes = quotes;
    riderState.set(chatId, st);

    await riderBot.sendMessage(
      chatId,
      '🚘 Select your ride (based on nearby drivers and live pricing):',
      { reply_markup: { inline_keyboard: rows } }
    );
  } catch (e) {
    console.error('showQuotes failed:', e?.message || e);
    await riderBot.sendMessage(
      chatId,
      '⚠️ Could not fetch quotes right now. Please try again.',
      { reply_markup: reviewTripKeyboard() }
    );
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Ride creation / notify drivers / waiting
──────────────────────────────────────────────────────────────────────────── */
async function broadcastToDrivers(ride) {
  const drivers = await Driver.find({
    status: 'approved',
    chatId: { $exists: true, $ne: null },
    ...(ride.vehicleType ? { vehicleType: ride.vehicleType } : {})
  }).select('chatId').limit(1000).lean();

  for (const d of drivers) {
    try {
      await notifyDriverNewRequest({ chatId: Number(d.chatId), ride });
    } catch (e) {
      console.warn('notifyDriverNewRequest failed for driver', d.chatId, e?.message || e);
    }
  }
}

async function createRideRecord({ chatId, st, vehicleType, price, paymentMethod }) {
  const ride = await Ride.create({
    riderChatId: chatId,
    pickup: st.pickup,
    destination: st.destination,
    vehicleType,
    estimate: Number(price) || undefined,
    status: 'pending',
    createdAt: new Date(),
    paymentMethod: paymentMethod || undefined,
    source: 'telegram',
    platform: 'telegram'
  });
  return ride;
}

/* ────────────────────────────────────────────────────────────────────────────
   Driver accepted → inform rider
──────────────────────────────────────────────────────────────────────────── */
function formatDriverCardForRider({ driver, ride }) {
  const dPhone = driver?.phone || driver?.phoneNumber || driver?.mobile || driver?.msisdn || '—';
  const carName = driver?.vehicleName || [driver?.vehicleMake, driver?.vehicleModel].filter(Boolean).join(' ');
  const lines = [
    '🚘 <b>Your Driver</b>',
    `• Name: <b>${driver?.name || '—'}</b>`,
    `• Phone: <b>${dPhone}</b>`,
    `• Vehicle: <b>${carName || '—'}</b>${driver?.vehicleColor ? ` (${driver.vehicleColor})` : ''}`,
    `• Plate: <b>${driver?.vehiclePlate || '—'}</b>`,
    `• Type: <b>${VEHICLE_LABEL(driver?.vehicleType || 'normal')}</b>`,
  ];
  if (ride?.pickup) lines.push(`• Pickup: <a href="${toMap(ride.pickup)}">map</a>`);
  if (ride?.destination) lines.push(`• Drop: <a href="${toMap(ride.destination)}">map</a>`);
  return lines.join('\n');
}

/* ────────────────────────────────────────────────────────────────────────────
   Rating flow (EXPORTED helper)
──────────────────────────────────────────────────────────────────────────── */
export async function notifyRiderToRateDriver(rideIdOrRide) {
  const ride = typeof rideIdOrRide === 'object' ? rideIdOrRide : await Ride.findById(rideIdOrRide).lean();
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
  } catch (e) {
    console.warn('notifyRiderToRateDriver failed:', e?.message || e);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Wire handlers once
──────────────────────────────────────────────────────────────────────────── */
function wireRiderHandlers() {
  if (globalThis.__riderBotSingleton.wired) return;
  globalThis.__riderBotSingleton.wired = true;

  // Driver ACCEPTED
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

      try {
        const photoUrl = driver?.documents?.driverProfilePhoto || driver?.documents?.vehiclePhoto || null;
        if (photoUrl) {
          await riderBot.sendPhoto(riderChatId, photoUrl, { caption: '🪪 Driver photo', parse_mode: 'HTML' });
        }
      } catch (e) { console.warn('Failed to send driver photo to rider:', e?.message || e); }

      if (PUBLIC_URL) {
        const riderLink =
          `${PUBLIC_URL}/track.html?rideId=${encodeURIComponent(String(rideId))}` +
          `&as=rider&riderChatId=${encodeURIComponent(String(riderChatId))}`;
        await riderBot.sendMessage(riderChatId, `🗺️ Live trip map:\n${riderLink}`);
      }
    } catch (e) {
      console.warn('riderBot ride:accepted handler failed:', e?.message || e);
    }
  });

  // /start
  riderBot.onText(/\/start(?:\s+.*)?$/i, async (msg) => {
    const chatId = msg.chat.id;
    riderState.delete(chatId);

    await Rider.findOneAndUpdate(
      { chatId },
      { $setOnInsert: { platform: 'telegram' } },
      { new: true, upsert: true }
    );

    await riderBot.sendMessage(chatId, '👋 Welcome! Choose an option:', {
      reply_markup: mainMenuKeyboard()
    });
  });

  // /support quick keyword
  riderBot.onText(/^(support|help)$/i, async (msg) => {
    await showSupport(msg.chat.id, 'command');
  });

  // Any message (locations + typed text for addresses)
  riderBot.on('message', async (msg) => {
    const chatId = msg.chat.id;

    // Track live location for admin map
    if (msg.location) {
      try {
        await Rider.findOneAndUpdate(
          { chatId },
          { $set: {
              lastLocation: { lat: msg.location.latitude, lng: msg.location.longitude, ts: new Date() },
              lastSeenAt: new Date(),
              platform: 'telegram'
            }
          },
          { upsert: true }
        );
        ioRef?.emit?.('rider:location', { chatId, location: { lat: msg.location.latitude, lng: msg.location.longitude } });
      } catch {}
    }

    const st = riderState.get(chatId) || {};
    const text = (msg.text || '').trim();

    // BOOKING: PICKUP
    if (st.step === 'awaiting_pickup') {
      if (msg.location) {
        st.pickup = { lat: msg.location.latitude, lng: msg.location.longitude };
        st.step = 'confirm_pickup';
        riderState.set(chatId, st);
        await riderBot.sendMessage(chatId, '📍 Pickup received.', { reply_markup: afterFirstAddressControls('pickup') });
        const addr = `${st.pickup.lat.toFixed(5)}, ${st.pickup.lng.toFixed(5)}`;
        await riderBot.sendMessage(chatId, `📍 <b>Confirm pickup</b>\n${addr}\n\nIs this correct?`, { parse_mode: 'HTML', reply_markup: confirmPickupKeyboard() });
        return;
      }
      if (text && text.length >= 3) {
        const preds = await gmapsAutocomplete(text, {});
        st.pickupPredictions = preds;
        riderState.set(chatId, st);
        return showAddressSuggestions(chatId, preds, 'pickup');
      }
      return; // keep quiet
    }

    // BOOKING: DROP
    if (st.step === 'awaiting_drop') {
      if (msg.location) {
        st.destination = { lat: msg.location.latitude, lng: msg.location.longitude };
        st.step = 'confirm_drop';
        riderState.set(chatId, st);
        await riderBot.sendMessage(chatId, '🎯 Destination received.', { reply_markup: afterFirstAddressControls('drop') });
        const addr = `${st.destination.lat.toFixed(5)}, ${st.destination.lng.toFixed(5)}`;
        await riderBot.sendMessage(chatId, `🎯 <b>Confirm destination</b>\n${addr}\n\nIs this correct?`, { parse_mode: 'HTML', reply_markup: confirmDropKeyboard() });
        return;
      }
      if (text && text.length >= 3) {
        const preds = await gmapsAutocomplete(text, {});
        st.dropPredictions = preds;
        riderState.set(chatId, st);
        return showAddressSuggestions(chatId, preds, 'drop');
      }
      return;
    }
  });

  // Inline buttons
  riderBot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    const data = String(q.data || '');
    try { await riderBot.answerCallbackQuery(q.id); } catch {}

    // Top-level menu actions
    if (data === 'open_dashboard') return sendDashboardLink(chatId);
    if (data === 'support') return showSupport(chatId, 'menu');
    if (data === 'start_fresh') return startFresh(chatId);
    if (data === 'cancel_booking') {
      riderState.delete(chatId);
      await riderBot.sendMessage(chatId, '❌ Booking cancelled.', { reply_markup: mainMenuKeyboard() });
      return;
    }
    if (data === 'book_trip') {
      riderState.set(chatId, { step: 'awaiting_pickup' });
      return askPickup(chatId);
    }
    if (data === 'prebook_trip') {
      riderState.set(chatId, { prebook: { step: 'awaiting_pickup' } });
      return askPickup(chatId); // (prebook time UI can be added later)
    }

    const st = riderState.get(chatId) || {};

    // Address picks
    if (data.startsWith('pick_idx:')) {
      const i = Number(data.split(':')[1]);
      const pred = st.pickupPredictions?.[i];
      if (!pred) return riderBot.sendMessage(chatId, 'Not found.');
      const place = await gmapsPlaceLatLng(pred.place_id, {});
      if (!place) return riderBot.sendMessage(chatId, 'Lookup failed.');
      st.pickup = { lat: place.lat, lng: place.lng, address: place.address };
      st.step = 'confirm_pickup';
      riderState.set(chatId, st);
      await riderBot.sendMessage(chatId, `✅ Pickup set: ${place.address}`);
      return riderBot.sendMessage(chatId, `📍 <b>Confirm pickup</b>\n${place.address}\n\nIs this correct?`, { parse_mode: 'HTML', reply_markup: confirmPickupKeyboard() });
    }
    if (data.startsWith('drop_idx:')) {
      const i = Number(data.split(':')[1]);
      const pred = st.dropPredictions?.[i];
      if (!pred) return riderBot.sendMessage(chatId, 'Not found.');
      const place = await gmapsPlaceLatLng(pred.place_id, {});
      if (!place) return riderBot.sendMessage(chatId, 'Lookup failed.');
      st.destination = { lat: place.lat, lng: place.lng, address: place.address };
      st.step = 'confirm_drop';
      riderState.set(chatId, st);
      await riderBot.sendMessage(chatId, `✅ Destination set: ${place.address}`);
      return riderBot.sendMessage(chatId, `🎯 <b>Confirm destination</b>\n${place.address}\n\nIs this correct?`, { parse_mode: 'HTML', reply_markup: confirmDropKeyboard() });
    }

    // Confirm / correct pickup
    if (data === 'confirm_pickup_yes') {
      st.step = st.destination ? 'review_trip' : 'awaiting_drop';
      riderState.set(chatId, st);
      if (st.step === 'awaiting_drop') return askDrop(chatId);
      const pAddr = st.pickup.address || `${st.pickup.lat.toFixed(5)}, ${st.pickup.lng.toFixed(5)}`;
      const dAddr = st.destination?.address || `${st.destination.lat.toFixed(5)}, ${st.destination.lng.toFixed(5)}`;
      return riderBot.sendMessage(chatId, `🧭 <b>Review trip</b>\n• Pickup: ${pAddr}\n• Destination: ${dAddr}`, { parse_mode: 'HTML', reply_markup: reviewTripKeyboard() });
    }
    if (data === 'correct_pickup') {
      st.step = 'awaiting_pickup';
      delete st.pickup; delete st.pickupPredictions;
      riderState.set(chatId, st);
      return askPickup(chatId);
    }

    // Confirm / correct destination
    if (data === 'confirm_drop_yes') {
      st.step = st.pickup ? 'review_trip' : 'awaiting_pickup';
      riderState.set(chatId, st);
      if (st.step === 'awaiting_pickup') return askPickup(chatId);
      const pAddr = st.pickup.address || `${st.pickup.lat.toFixed(5)}, ${st.pickup.lng.toFixed(5)}`;
      const dAddr = st.destination?.address || `${st.destination.lat.toFixed(5)}, ${st.destination.lng.toFixed(5)}`;
      return riderBot.sendMessage(chatId, `🧭 <b>Review trip</b>\n• Pickup: ${pAddr}\n• Destination: ${dAddr}`, { parse_mode: 'HTML', reply_markup: reviewTripKeyboard() });
    }
    if (data === 'correct_drop') {
      st.step = 'awaiting_drop';
      delete st.destination; delete st.dropPredictions;
      riderState.set(chatId, st);
      return askDrop(chatId);
    }

    // Review proceed → SHOW REAL QUOTES (pricing.js)
    if (data === 'review_proceed') {
      if (!st.pickup || !st.destination) {
        return riderBot.sendMessage(chatId, 'Missing pickup or destination.');
      }
      await riderBot.sendMessage(chatId, '🔎 Finding options…');
      return showQuotes(chatId, st);
    }
    if (data === 'review_correct_pickup') {
      st.step = 'awaiting_pickup';
      delete st.pickup; delete st.pickupPredictions;
      riderState.set(chatId, st);
      return askPickup(chatId);
    }
    if (data === 'review_correct_drop') {
      st.step = 'awaiting_drop';
      delete st.destination; delete st.dropPredictions;
      riderState.set(chatId, st);
      return askDrop(chatId);
    }

    // Vehicle type chosen → ask payment method
    if (data.startsWith('veh:')) {
      const [, vt, price] = data.split(':');
      if (!st.pickup || !st.destination) return riderBot.sendMessage(chatId, 'Missing pickup/drop.');
      st.selectedVehicle = { type: vt, price: Number(price) || 0 };
      riderState.set(chatId, st);
      return riderBot.sendMessage(chatId, `💳 Choose payment method for ${VEHICLE_LABEL(vt)} (R${st.selectedVehicle.price}):`, {
        reply_markup: payMethodKeyboard()
      });
    }

    // Payment method
    if (data.startsWith('pay:')) {
      const method = data.split(':')[1]; // cash | payfast
      if (!st.pickup || !st.destination || !st.selectedVehicle) {
        return riderBot.sendMessage(chatId, 'Missing details.');
      }
      const ride = await createRideRecord({
        chatId,
        st,
        vehicleType: st.selectedVehicle.type,
        price: st.selectedVehicle.price,
        paymentMethod: (method === 'cash' ? 'cash' : 'payfast')
      });

      // Notify drivers of the selected vehicle type only
      await riderBot.sendMessage(chatId, '📨 Request sent. Waiting for a driver to accept…', {
        reply_markup: waitingKeyboard(String(ride._id))
      });
      riderEvents.emit('booking:new', { rideId: String(ride._id) });

      // Fan out
      await broadcastToDrivers(ride);

      // Keep minimal state; user can cancel or start fresh
      st.waitingRideId = String(ride._id);
      st.step = 'waiting_driver';
      riderState.set(chatId, st);
      return;
    }

    // Cancel the specific pending request
    if (data.startsWith('cancel_request:')) {
      const rideId = data.split(':')[1];
      try {
        const ride = await Ride.findById(rideId);
        if (ride && ride.status === 'pending') {
          ride.status = 'cancelled';
          ride.cancelReason = 'rider_cancelled';
          ride.cancelledAt = new Date();
          await ride.save();
        }
      } catch {}
      riderState.delete(chatId);
      await riderBot.sendMessage(chatId, '❌ Request cancelled.', { reply_markup: mainMenuKeyboard() });
      return;
    }

    // Rating
    if (data.startsWith('rate_driver:')) {
      const [, rideId, starsStr] = data.split(':');
      const stars = Math.max(1, Math.min(5, Number(starsStr) || 0));
      try {
        const ride = await Ride.findById(rideId);
        if (ride) {
          ride.driverRating = stars;
          ride.driverRatedAt = new Date();
          await ride.save();
          await riderBot.sendMessage(chatId, `⭐ Thanks for rating your driver ${'★'.repeat(stars)}.`);
        }
      } catch (e) {
        console.warn('rate_driver failed:', e?.message || e);
      }
      return;
    }
  });
}

/* ────────────────────────────────────────────────────────────────────────────
   Init
──────────────────────────────────────────────────────────────────────────── */
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

  // Patch sendMessage/sendPhoto to track message ids for wiping UI
  if (!riderBot.__patchedTracking) {
    riderBot.__origSendMessage = riderBot.sendMessage.bind(riderBot);
    riderBot.__origSendPhoto = riderBot.sendPhoto.bind(riderBot);

    riderBot.sendMessage = async function patchedSendMessage(chatId, text, options = {}) {
      const m = await riderBot.__origSendMessage(chatId, text, options);
      try { trackSent(chatId, m?.message_id); } catch {}
      return m;
    };
    riderBot.sendPhoto = async function patchedSendPhoto(chatId, photo, options = {}) {
      const m = await riderBot.__origSendPhoto(chatId, photo, options);
      try { trackSent(chatId, m?.message_id); } catch {}
      return m;
    };
    riderBot.__patchedTracking = true;
  }

  globalThis.__riderBotSingleton.bot = riderBot;
  globalThis.__riderBotSingleton.started = true;

  wireRiderHandlers();

  console.log('🧍 Rider bot initialized');
  return riderBot;
}

export { riderBot };
