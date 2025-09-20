// src/bots/driverBot.js
import TelegramBot from 'node-telegram-bot-api';
import EventEmitter from 'events';
import Driver from '../models/Driver.js';
import Ride from '../models/Ride.js';
import Rider from '../models/Rider.js'; // NEW: to look up rider info for driver messages

export const driverEvents = new EventEmitter();

// ---- Singleton container (survives duplicate imports) ----
if (!globalThis.__driverBotSingleton) {
  globalThis.__driverBotSingleton = {
    bot: null,
    wired: false,
    started: false,
  };
}

let bot = globalThis.__driverBotSingleton.bot;
let ioRef = null;

const MODE = process.env.TELEGRAM_MODE || 'polling'; // 'polling' | 'webhook'
const token = process.env.TELEGRAM_DRIVER_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_DRIVER_BOT_TOKEN is not defined in .env');

const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
const DRIVER_WEBHOOK_PATH = process.env.TELEGRAM_DRIVER_WEBHOOK_PATH || '/telegram/driver';

const toNum = (v) => (v == null ? v : Number(v));

/* ---------------- Phone helpers ---------------- */
function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[^\d+]/g, '');
  if (!s) return null;

  if (s.startsWith('+')) {
    const digits = s.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return null;
    return '+' + digits;
  }

  // ZA-friendly defaults: 0xxxxxxxxx -> +27xxxxxxxxx ; 27xxxxxxxxx -> +27xxxxxxxxx
  if (s.startsWith('0')) s = '27' + s.slice(1);
  const digits = s.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return '+' + digits;
}
function hasPhone(drv) {
  return !!(drv && (drv.phone || drv.phoneNumber || drv.mobile || drv.msisdn));
}

/* ---------------- Vehicle helpers ---------------- */
const vtLabel = (t) =>
  t === 'comfort' ? 'Comfort' : t === 'luxury' ? 'Luxury' : t === 'xl' ? 'XL' : 'Normal';

const vtNormalize = (s = '') => {
  const v = String(s).trim().toLowerCase();
  if (['comfort'].includes(v)) return 'comfort';
  if (['luxury', 'premier', 'exec', 'premium'].includes(v)) return 'luxury';
  if (['xl', 'van', 'people carrier', 'minivan'].includes(v)) return 'xl';
  if (['normal', 'standard', 'uberx', 'bolt', 'economy', 'base'].includes(v)) return 'normal';
  return 'normal';
};

function carPretty(d) {
  const pieces = [];
  if (d?.vehicleName) pieces.push(d.vehicleName);
  else {
    const mm = [d?.vehicleMake, d?.vehicleModel].filter(Boolean).join(' ');
    if (mm) pieces.push(mm);
  }
  if (d?.vehicleColor) pieces.push(`(${d.vehicleColor})`);
  return pieces.join(' ').trim() || '—';
}

function missingVehicleFields(drv) {
  const missing = [];
  if (!drv?.vehiclePlate) missing.push('plate');
  if (!drv?.vehicleMake) missing.push('make');
  if (!drv?.vehicleModel) missing.push('model');
  if (!drv?.vehicleColor) missing.push('color');
  if (!drv?.vehicleType) missing.push('type');
  return missing;
}
function vehicleComplete(drv) {
  return missingVehicleFields(drv).length === 0;
}

/* ---------------- UI helpers ---------------- */
function onlineKeyboard(isOnline) {
  return {
    reply_markup: {
      inline_keyboard: [[
        isOnline
          ? { text: '🔴 Go Offline', callback_data: 'drv_offline' }
          : { text: '🟢 Go Online', callback_data: 'drv_online' }
      ]]
    }
  };
}
function starsKeyboard(kind, rideId) {
  const row = Array.from({ length: 5 }, (_, i) => {
    const n = i + 1;
    return { text: '★'.repeat(n), callback_data: `${kind}:${rideId}:${n}` };
  });
  return { reply_markup: { inline_keyboard: [row] } };
}
function locationKeyboard() {
  return {
    reply_markup: {
      keyboard: [[{ text: 'Send Live Location 📍', request_location: true }]],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}
function phoneKeyboard() {
  return {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [[{ text: '📲 Share my number', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
}
function typeKeyboard() {
  return {
    reply_markup: {
      keyboard: [[
        { text: 'normal' }, { text: 'comfort' }, { text: 'luxury' }, { text: 'xl' }
      ]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
}

/* ---------------- DB helpers ---------------- */
async function setAvailability(chatId, isOnline) {
  const driver = await Driver.findOneAndUpdate(
    { chatId: Number(chatId) },
    { $set: { isAvailable: !!isOnline } },
    { new: true }
  );
  return driver;
}
async function getOrLinkDriverByChat(msg) {
  const chatId = toNum(msg.chat.id);
  let driver = await Driver.findOne({ chatId });

  if (!driver) {
    const tgUsername = msg.from?.username;
    if (tgUsername) {
      driver = await Driver.findOneAndUpdate(
        { telegramUsername: tgUsername, $or: [{ chatId: { $exists: false } }, { chatId: null }] },
        { $set: { chatId } },
        { new: true }
      );
    }
  }
  return driver;
}

/* ---------------- Stats helpers ---------------- */
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
function formatStatsCompact(driver) {
  const s = driver?.stats || {};
  const parts = [];
  parts.push(`💰 <b>${fmtAmount(s.totalEarnings || 0)}</b>`);
  parts.push(`🧾 ${s.totalTrips || 0} trips`);
  if (typeof s.avgRating === 'number' && s.ratingsCount >= 0) {
    parts.push(`⭐ ${(s.avgRating || 0).toFixed(2)} (${s.ratingsCount || 0})`);
  }
  return parts.join(' · ');
}
async function ensureAndGetDriverStatsByChat(chatId) {
  const driver = await Driver.findOne({ chatId: Number(chatId) });
  if (!driver) return null;
  try { await Driver.computeAndUpdateStats(driver._id); } catch {}
  return await Driver.findById(driver._id);
}

/* ---------------- State ---------------- */
// chatId -> { step: 'awaiting_phone' | 'veh_plate' | 'veh_make' | 'veh_model' | 'veh_color' | 'veh_type' | post_action?: 'go_online'|'accept:<rideId>' }
const driverState = new Map();

/* ---------------- Vehicle wizard ---------------- */
async function startVehicleWizard(chatId, driver, postAction = null) {
  const d = driver || await Driver.findOne({ chatId: Number(chatId) }).lean();
  const next = nextVehicleStep(d);
  if (!next) return true; // already complete
  driverState.set(chatId, { step: next, post_action: postAction || null });
  await askVehicleQuestion(chatId, next);
  return false;
}
function nextVehicleStep(drv) {
  if (!drv?.vehiclePlate) return 'veh_plate';
  if (!drv?.vehicleMake)  return 'veh_make';
  if (!drv?.vehicleModel) return 'veh_model';
  if (!drv?.vehicleColor) return 'veh_color';
  if (!drv?.vehicleType)  return 'veh_type';
  return null;
}
async function askVehicleQuestion(chatId, step) {
  if (step === 'veh_plate') {
    return bot.sendMessage(
      chatId,
      '🔖 What is your number plate?\nExample: <b>CA 123 456</b>',
      { parse_mode: 'HTML' }
    );
  }
  if (step === 'veh_make') {
    return bot.sendMessage(chatId, '🏷️ Car make?\nExample: <b>Toyota</b>', { parse_mode: 'HTML' });
  }
  if (step === 'veh_model') {
    return bot.sendMessage(chatId, '🔤 Car model?\nExample: <b>Corolla</b>', { parse_mode: 'HTML' });
  }
  if (step === 'veh_color') {
    return bot.sendMessage(chatId, '🎨 Car color?\nExample: <b>white</b>', { parse_mode: 'HTML' });
  }
  if (step === 'veh_type') {
    return bot.sendMessage(
      chatId,
      '🚘 Vehicle type? (choose or type one)\nnormal · comfort · luxury · xl',
      typeKeyboard()
    );
  }
}

/* ---------------- helpers for outbound ride notifications ---------------- */
const toMap = ({ lat, lng }) => `https://maps.google.com/?q=${lat},${lng}`;

/* ---------------- NEW: formatting rider details for the driver ---------------- */
function formatRiderCardForDriver({ rider, ride }) {
  const rPhone = rider?.phone || rider?.mobile || rider?.msisdn || '—';
  const lines = [
    '🙋 <b>Rider Details</b>',
    `• Name: <b>${rider?.name || '—'}</b>`,
    `• Phone: <b>${rPhone}</b>`,
  ];
  if (ride?.pickup) lines.push(`• Pickup: <a href="${toMap(ride.pickup)}">map</a>`);
  if (ride?.destination) lines.push(`• Drop: <a href="${toMap(ride.destination)}">map</a>`);
  return lines.join('\n');
}

/* ---------------- Minimal home (after setup complete) ---------------- */
async function showDriverHome(chatId) {
  let d = await ensureAndGetDriverStatsByChat(chatId);
  if (!d) return;

  // 1) Compact stats first
  try { await bot.sendMessage(chatId, formatStatsCompact(d), { parse_mode: 'HTML' }); } catch {}

  // 2) Status + controls
  const isOnline = !!d.isAvailable;
  try {
    await bot.sendMessage(
      chatId,
      isOnline ? '✅ You are ONLINE.' : '⏸ You are OFFLINE.',
      onlineKeyboard(isOnline)
    );
  } catch {}

  // 3) Brief location tip
  try {
    await bot.sendMessage(
      chatId,
      'Tip: when ONLINE, share Live Location via 📎 → Location → Share Live Location.',
      { disable_web_page_preview: true }
    );
  } catch {}
}

/* ---------------- Bot init + wiring ---------------- */
async function sendApprovalNoticeInternal(chatId) {
  await bot.sendMessage(
    chatId,
    "🎉 You're approved as a VayaRide driver!\n\nTap below to go online when you're ready to accept trips.",
    onlineKeyboard(false)
  );
}

function wireHandlers() {
  if (globalThis.__driverBotSingleton.wired) return;
  globalThis.__driverBotSingleton.wired = true;

  bot.sendApprovalNotice = sendApprovalNoticeInternal;

  // Link by email (optional but helpful)
  bot.onText(/^link\s+(.+)$/i, async (msg, match) => {
    const chatId = toNum(msg.chat.id);
    const email = (match?.[1] || '').trim();
    if (!email) return void bot.sendMessage(chatId, 'Please provide an email: LINK your@email.com');

    const rx = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const driver = await Driver.findOneAndUpdate(
      { email: rx },
      { $set: { chatId } },
      { new: true }
    );
    if (!driver) {
      await bot.sendMessage(chatId, '❌ Could not find a driver with that email. Make sure you registered on the website.');
      return;
    }

    await bot.sendMessage(chatId, `✅ Linked to ${driver.email}.`);

    // Gate: phone first, nothing else
    if (!hasPhone(driver)) {
      driverState.set(chatId, { step: 'awaiting_phone' });
      await bot.sendMessage(
        chatId,
        '📱 Please share your mobile number (for rider contact & safety). You can *Share my number* or type it (e.g. 0812345678 or +27…):',
        phoneKeyboard()
      );
      return; // stop here — no extra noise
    }

    // Gate: vehicle wizard next
    if (!vehicleComplete(driver)) {
      await bot.sendMessage(chatId, '🚗 Quick setup (few questions) so riders can identify you.');
      await startVehicleWizard(chatId, driver);
      return; // stop — hide online/location/stats until done
    }

    // All set → compact home
    await showDriverHome(chatId);
  });

  bot.onText(/\/start\b/, async (msg) => {
    const chatId = toNum(msg.chat.id);
    let driver = await getOrLinkDriverByChat(msg);

    if (!driver) {
      await bot.sendMessage(
        chatId,
        "🚨 I couldn't find your driver profile by chat. If you've already registered on the website, link your account by sending:\n\nLINK your@email.com"
      );
      return;
    }

    if (driver.status !== 'approved') {
      await bot.sendMessage(chatId, '⏳ Your account is pending admin approval. You will get a message here when approved.');
      return;
    }

    // 1) Phone gate
    if (!hasPhone(driver)) {
      driverState.set(chatId, { step: 'awaiting_phone' });
      await bot.sendMessage(
        chatId,
        '📱 Please share your mobile number (for rider contact & safety). You can *Share my number* or type it (e.g. 0812345678 or +27…):',
        phoneKeyboard()
      );
      return;
    }

    // 2) Vehicle gate — run wizard and stop until done
    if (!vehicleComplete(driver)) {
      await bot.sendMessage(chatId, '🚗 Quick setup (few questions) so riders can identify you.');
      await startVehicleWizard(chatId, driver);
      return;
    }

    // 3) All good → compact home first (earnings), then status + tip
    await showDriverHome(chatId);

    // 4) (Optional) After home, rating prompt if needed
    try {
      const since = new Date(Date.now() - 48 * 3600 * 1000);
      const d = await Driver.findOne({ chatId }).lean();
      if (d?._id) {
        const lastUnrated = await Ride.findOne({
          driverId: d._id,
          status: 'completed',
          riderRating: { $in: [null, undefined] },
          completedAt: { $gte: since }
        }).sort({ completedAt: -1 }).lean();

        if (lastUnrated?._id) {
          await bot.sendMessage(
            chatId,
            'Please rate your last rider:',
            starsKeyboard('rate_rider', String(lastUnrated._id))
          );
        }
      }
    } catch {}
  });

  bot.onText(/^\/stats$/, async (msg) => {
    const chatId = toNum(msg.chat.id);
    const driver = await ensureAndGetDriverStatsByChat(chatId);
    if (!driver) return void bot.sendMessage(chatId, '❌ Driver profile not found.');
    await bot.sendMessage(chatId, formatStatsCompact(driver), { parse_mode: 'HTML' });
  });

  bot.onText(/^\/whoami$/, async (msg) => {
    const chatId = toNum(msg.chat.id);
    const driver = await Driver.findOne({ chatId }).lean();
    if (!driver) return void bot.sendMessage(chatId, "I don't see your driver profile yet. Try `LINK your@email.com`.");
    const phone =
      driver.phone || driver.phoneNumber || driver.mobile || driver.msisdn || '-';
    await bot.sendMessage(chatId, `You are:
• email: ${driver.email || '-'}
• name: ${driver.name || '-'}
• phone: ${phone}
• status: ${driver.status}
• online: ${driver.isAvailable ? 'yes' : 'no'}
• vehicle: ${carPretty(driver)} — ${vtLabel(driver.vehicleType)}
• plate: ${driver.vehiclePlate || '—'}
• chatId: ${driver.chatId}`);
  });

  // Manual trigger to re-run vehicle wizard
  bot.onText(/^\/vehicle$/, async (msg) => {
    const chatId = toNum(msg.chat.id);
    const d = await Driver.findOne({ chatId }).lean();
    if (!d) return void bot.sendMessage(chatId, '❌ Driver profile not found.');
    if (vehicleComplete(d)) {
      await bot.sendMessage(
        chatId,
        `✅ Vehicle on file: ${carPretty(d)} — plate ${d.vehiclePlate}, type ${vtLabel(d.vehicleType)}`
      );
      return;
    }
    await bot.sendMessage(chatId, '🚗 Quick setup (few questions).');
    await startVehicleWizard(chatId, d);
  });

  // Quick command to prompt phone again
  bot.onText(/^\/phone$/i, async (msg) => {
    const chatId = toNum(msg.chat.id);
    driverState.set(chatId, { step: 'awaiting_phone' });
    await bot.sendMessage(
      chatId,
      '📱 Please share your mobile number. You can *Share my number* or type it (e.g. 0812345678 or +27…):',
      phoneKeyboard()
    );
  });

  // Online/Offline commands (ONLINE gated on complete phone + vehicle)
  bot.onText(/^\/online$/, async (msg) => {
    const chatId = toNum(msg.chat.id);
    const driver = await Driver.findOne({ chatId }).lean();
    if (!driver) return void bot.sendMessage(chatId, '❌ Driver profile not found.');

    if (!hasPhone(driver)) {
      driverState.set(chatId, { step: 'awaiting_phone' });
      await bot.sendMessage(
        chatId,
        '📱 Please add your mobile number first. You can *Share my number* or type it (e.g. 0812345678 or +27…):',
        phoneKeyboard()
      );
      return;
    }
    if (!vehicleComplete(driver)) {
      await bot.sendMessage(chatId, '🚗 Before you go ONLINE, let’s finish your vehicle details.');
      await startVehicleWizard(chatId, driver, 'go_online');
      return;
    }

    const d = await setAvailability(chatId, true);
    if (!d) return void bot.sendMessage(chatId, '❌ Driver profile not found.');
    await bot.sendMessage(chatId, '🟢 You are now ONLINE.', onlineKeyboard(true));
    await bot.sendMessage(
      chatId,
      'Share Live Location via 📎 → Location → Share Live Location.',
      { disable_web_page_preview: true }
    );
  });

  bot.onText(/^\/offline$/, async (msg) => {
    const chatId = toNum(msg.chat.id);
    const driver = await setAvailability(chatId, false);
    if (!driver) return void bot.sendMessage(chatId, '❌ Driver profile not found.');
    await bot.sendMessage(chatId, '🔴 You are now OFFLINE.', onlineKeyboard(false));
  });

  async function recordAndBroadcastLocation(chatId, latitude, longitude) {
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return;

    await Driver.findOneAndUpdate(
      { chatId: Number(chatId) },
      { $set: { location: { lat: latitude, lng: longitude }, lastSeenAt: new Date(), isAvailable: true } },
      { new: true }
    );

    driverEvents.emit('driver:location', { chatId: Number(chatId), location: { lat: latitude, lng: longitude } });
  }

  bot.on('message', async (msg) => {
    const chatId = toNum(msg.chat.id);

    // --- PHONE CAPTURE (contact share preferred) ---
    if (msg.contact && driverState.get(chatId)?.step === 'awaiting_phone') {
      const phone = normalizePhone(msg.contact.phone_number);
      if (!phone) {
        await bot.sendMessage(chatId, '❌ That doesn’t look like a valid number. Please try again.');
        await bot.sendMessage(chatId, 'Share your number or type it (e.g. 0812345678 or +27…):', phoneKeyboard());
        return;
      }
      await Driver.findOneAndUpdate({ chatId: Number(chatId) }, { $set: { phone } }, { new: true });
      driverState.delete(chatId);
      await bot.sendMessage(chatId, `✅ Number saved: ${phone}`);

      // After phone, if vehicle incomplete, go straight to wizard
      const d = await Driver.findOne({ chatId }).lean();
      if (!vehicleComplete(d)) {
        await bot.sendMessage(chatId, '🚗 Quick setup (few questions) so riders can identify you.');
        await startVehicleWizard(chatId, d);
        return;
      }

      // If everything complete already
      await showDriverHome(chatId);
      return;
    }

    // Phone typed while awaiting_phone
    if (driverState.get(chatId)?.step === 'awaiting_phone' && msg.text) {
      const phone = normalizePhone(msg.text);
      if (!phone) {
        await bot.sendMessage(chatId, '❌ Please enter a valid phone number (e.g. 0812345678 or +27…)\nTip: tap *Share my number*.', { parse_mode: 'Markdown' });
        await bot.sendMessage(chatId, 'Share your number or type it:', phoneKeyboard());
        return;
      }
      await Driver.findOneAndUpdate({ chatId: Number(chatId) }, { $set: { phone } }, { new: true });
      driverState.delete(chatId);
      await bot.sendMessage(chatId, `✅ Number saved: ${phone}`);

      const d = await Driver.findOne({ chatId }).lean();
      if (!vehicleComplete(d)) {
        await bot.sendMessage(chatId, '🚗 Quick setup (few questions) so riders can identify you.');
        await startVehicleWizard(chatId, d);
        return;
      }
      await showDriverHome(chatId);
      return;
    }

    // --- VEHICLE WIZARD ANSWERS ---
    const state = driverState.get(chatId);
    if (state && state.step && state.step.startsWith('veh_') && msg.text) {
      const text = (msg.text || '').trim();
      let updated = null;

      if (state.step === 'veh_plate') {
        const val = text.replace(/\s+/g, ' ').trim().toUpperCase();
        updated = await Driver.findOneAndUpdate(
          { chatId: Number(chatId) },
          { $set: { vehiclePlate: val } },
          { new: true }
        );
      } else if (state.step === 'veh_make') {
        const val = text.replace(/\s+/g, ' ').trim();
        updated = await Driver.findOneAndUpdate(
          { chatId: Number(chatId) },
          { $set: { vehicleMake: val } },
          { new: true }
        );
      } else if (state.step === 'veh_model') {
        const val = text.replace(/\s+/g, ' ').trim();
        updated = await Driver.findOneAndUpdate(
          { chatId: Number(chatId) },
          { $set: { vehicleModel: val } },
          { new: true }
        );
      } else if (state.step === 'veh_color') {
        const val = text.replace(/\s+/g, ' ').trim();
        updated = await Driver.findOneAndUpdate(
          { chatId: Number(chatId) },
          { $set: { vehicleColor: val } },
          { new: true }
        );
      } else if (state.step === 'veh_type') {
        const vt = vtNormalize(text);
        updated = await Driver.findOneAndUpdate(
          { chatId: Number(chatId) },
          { $set: { vehicleType: vt } },
          { new: true }
        );
      }

      const next = nextVehicleStep(updated);
      if (next) {
        driverState.set(chatId, { step: next, post_action: state.post_action || null });
        await askVehicleQuestion(chatId, next);
        return;
      }

      driverState.delete(chatId);
      const summary = `✅ Vehicle saved:\n• ${carPretty(updated)}\n• Plate: ${updated.vehiclePlate}\n• Type: ${vtLabel(updated.vehicleType)}`;
      await bot.sendMessage(chatId, summary);
      const post = state.post_action;

      if (post === 'go_online') {
        const d = await setAvailability(chatId, true);
        if (d) {
          await bot.sendMessage(chatId, '🟢 You are now ONLINE.', onlineKeyboard(true));
          await bot.sendMessage(chatId, 'Share Live Location via 📎 → Location → Share Live Location.');
        }
      } else if (post && post.startsWith('accept:')) {
        const rideId = post.split(':')[1];
        await handleAcceptAfterSetup(chatId, rideId);
      } else {
        await showDriverHome(chatId);
      }
      return;
    }

    // --- LOCATION STREAM / ONE-OFF ---
    const loc = msg?.location;
    if (loc) {
      await recordAndBroadcastLocation(chatId, loc.latitude, loc.longitude);
      try { await bot.sendMessage(chatId, '📍 Location updated.'); } catch {}

      const looksOneOff = !msg.edit_date && !msg.live_period && !(msg.location && msg.location.live_period);
      if (looksOneOff) {
        try {
          await bot.sendMessage(
            chatId,
            'To stream continuously: 📎 → Location → Share Live Location.',
            { disable_web_page_preview: true }
          );
        } catch {}
      }
    }
  });

  bot.on('edited_message', async (msg) => {
    const loc = msg?.location;
    if (!loc) return;
    const chatId = toNum(msg.chat.id);
    await recordAndBroadcastLocation(chatId, loc.latitude, loc.longitude);
  });

  bot.on('callback_query', async (query) => {
    const chatId = toNum(query.message.chat.id);
    const data = String(query.data || '');

    try {
      if (data === 'drv_online') {
        const driver = await Driver.findOne({ chatId }).lean();
        if (!driver) { await bot.answerCallbackQuery(query.id); return void bot.sendMessage(chatId, '❌ Driver profile not found.'); }
        if (!hasPhone(driver)) {
          await bot.answerCallbackQuery(query.id);
          driverState.set(chatId, { step: 'awaiting_phone' });
          await bot.sendMessage(
            chatId,
            '📱 Add your mobile number first. You can *Share my number* or type it (e.g. 0812345678 or +27…):',
            phoneKeyboard()
          );
          return;
        }
        if (!vehicleComplete(driver)) {
          await bot.answerCallbackQuery(query.id);
          await bot.sendMessage(chatId, '🚗 Before you go ONLINE, let’s finish your vehicle details.');
          await startVehicleWizard(chatId, driver, 'go_online');
          return;
        }
        const updated = await setAvailability(chatId, true);
        await bot.answerCallbackQuery(query.id);
        if (!updated) return void bot.sendMessage(chatId, '❌ Driver profile not found.');
        await bot.editMessageText('🟢 You are now ONLINE.', {
          chat_id: chatId, message_id: query.message.message_id, ...onlineKeyboard(true)
        });
        await bot.sendMessage(chatId, 'Share Live Location via 📎 → Location → Share Live Location.');
        return;
      }

      if (data === 'drv_offline') {
        const driver = await setAvailability(chatId, false);
        await bot.answerCallbackQuery(query.id);
        if (!driver) return void bot.sendMessage(chatId, '❌ Driver profile not found.');
        await bot.editMessageText('🔴 You are now OFFLINE.', {
          chat_id: chatId, message_id: query.message.message_id, ...onlineKeyboard(false)
        });
        return;
      }

      if (data.startsWith('accept_')) {
        const rideId = data.replace('accept_', '');
        const ride = await Ride.findById(rideId);
        if (!ride) return void bot.answerCallbackQuery(query.id, { text: 'Ride not found' });

        const driver = await Driver.findOne({ chatId: Number(chatId) }).lean();
        if (!driver) { await bot.answerCallbackQuery(query.id, { text: 'Profile missing' }); return; }

        // Gate acceptance on vehicle completeness
        if (!vehicleComplete(driver)) {
          await bot.answerCallbackQuery(query.id, { text: 'Finish vehicle setup first' });
          await bot.sendMessage(chatId, '🚗 Let’s finish your vehicle details (for rider identification).');
          await startVehicleWizard(chatId, driver, `accept:${rideId}`);
          return;
        }

        // basic guard: don't override another driver's accepted job
        if (ride.status && ride.status !== 'pending' && ride.driverId) {
          await bot.answerCallbackQuery(query.id, { text: 'No longer available' });
          return;
        }

        // Accept now
        const d = await Driver.findOne({ chatId: Number(chatId) });
        if (d && !ride.driverId) { ride.driverId = d._id; }
        ride.status = 'accepted';
        await ride.save();

        await bot.answerCallbackQuery(query.id, { text: 'Ride accepted' });
        await bot.sendMessage(chatId, '✅ You accepted the ride.');

        // 🔔 Emit system event for dispatcher / rider bot
        driverEvents.emit('ride:accepted', { driverId: chatId, rideId });

        // 🧑‍🤝‍🧑 NEW: Send rider’s details to the driver immediately
        try {
          const rider = await Rider.findOne({ chatId: Number(ride.riderChatId) }).lean();
          const details = formatRiderCardForDriver({ rider, ride });
          await bot.sendMessage(chatId, details, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch {}

        // Send live trip map link for driver (parity with WA)
        if (PUBLIC_URL) {
          const base = `${PUBLIC_URL}/track.html?rideId=${encodeURIComponent(String(rideId))}`;
          const driverLink = `${base}&as=driver&driverChatId=${encodeURIComponent(String(chatId))}`;
          try {
            await bot.sendMessage(chatId, `🗺️ Live trip map:\n${driverLink}\nTip: Keep Live Location ON for the trip.`);
          } catch {}
        }
        return;
      }

      if (data.startsWith('ignore_')) {
        const rideId = data.replace('ignore_', '');
        const ride = await Ride.findById(rideId);
        await bot.answerCallbackQuery(query.id, { text: 'Ignored' });
        if (ride) driverEvents.emit('ride:ignored', { previousDriverId: chatId, ride });
        return;
      }

      // ⭐ driver rates rider
      if (data.startsWith('rate_rider:')) {
        const [, rideId, starsStr] = data.split(':');
        const stars = Number(starsStr);
        if (!(stars >= 1 && stars <= 5)) { try { await bot.answerCallbackQuery(query.id, { text: 'Invalid rating' }); } catch {} return; }

        const ride = await Ride.findById(rideId);
        if (!ride) { try { await bot.answerCallbackQuery(query.id, { text: 'Ride not found' }); } catch {} return; }

        const driver = await Driver.findOne({ chatId: Number(chatId) }).lean();
        if (!driver || String(ride.driverId) !== String(driver._id)) {
          try { await bot.answerCallbackQuery(query.id, { text: 'Not your trip' }); } catch {}
          return;
        }

        ride.riderRating = stars;
        ride.riderRatedAt = new Date();
        await ride.save();

        try { await bot.answerCallbackQuery(query.id, { text: `Thanks! You rated ${stars}★` }); } catch {}
        await bot.sendMessage(chatId, `✅ Rating saved: ${'★'.repeat(stars)}`);
        return;
      }

    } catch (err) {
      console.error('driver callback_query error:', err);
      try { await bot.answerCallbackQuery(query.id, { text: '⚠️ Error. Please try again.', show_alert: false }); } catch {}
    }
  });
}

async function handleAcceptAfterSetup(chatId, rideId) {
  const ride = await Ride.findById(rideId);
  if (!ride) return void bot.sendMessage(chatId, '❌ Ride not found anymore.');
  const d = await Driver.findOne({ chatId: Number(chatId) });
  if (!d) return void bot.sendMessage(chatId, '❌ Driver profile not found.');
  // Still available?
  if (ride.status && ride.status !== 'pending' && ride.driverId) {
    await bot.sendMessage(chatId, '⚠️ That request is no longer available.');
    return;
  }
  if (!vehicleComplete(d)) {
    await bot.sendMessage(chatId, '⚠️ Vehicle details incomplete. Please finish setup.');
    await startVehicleWizard(chatId, d, `accept:${rideId}`);
    return;
  }
  if (!ride.driverId) ride.driverId = d._id;
  ride.status = 'accepted';
  await ride.save();
  await bot.sendMessage(chatId, '✅ You accepted the ride.');

  // Emit + send rider details (same as in callback)
  driverEvents.emit('ride:accepted', { driverId: chatId, rideId });
  try {
    const rider = await Rider.findOne({ chatId: Number(ride.riderChatId) }).lean();
    const details = formatRiderCardForDriver({ rider, ride });
    await bot.sendMessage(chatId, details, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch {}

  if (PUBLIC_URL) {
    const base = `${PUBLIC_URL}/track.html?rideId=${encodeURIComponent(String(rideId))}`;
    const driverLink = `${base}&as=driver&driverChatId=${encodeURIComponent(String(chatId))}`;
    try { await bot.sendMessage(chatId, `🗺️ Live trip map:\n${driverLink}`); } catch {}
  }
}

/* ---------------- Initialization ---------------- */
export function initDriverBot({ io, app } = {}) {
  ioRef = io || ioRef;

  if (globalThis.__driverBotSingleton.started && bot) {
    console.log('🚗 Driver bot already initialized (singleton)');
    return bot;
  }

  const tokenTail = token.slice(-6);
  if (MODE === 'webhook') {
    if (!app) throw new Error('Driver bot webhook mode requires an Express app instance');
    if (!PUBLIC_URL) throw new Error('PUBLIC_URL must be set for webhook mode');

    bot = new TelegramBot(token, { polling: false });
    bot.setWebHook(`${PUBLIC_URL}${DRIVER_WEBHOOK_PATH}`)
      .then(() => console.log(`🚗 Driver webhook set (pid=${process.pid}, token=***${tokenTail}, path=${DRIVER_WEBHOOK_PATH})`))
      .catch((e) => console.error('Driver setWebHook error:', e));

    app.post(DRIVER_WEBHOOK_PATH, (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });
  } else {
    bot = new TelegramBot(token, {
      polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 10, allowed_updates: ['message', 'edited_message', 'callback_query'] }
      }
    });
    console.log(`🚗 Starting driver bot polling (pid=${process.pid}, token=***${tokenTail})`);
  }

  globalThis.__driverBotSingleton.bot = bot;
  globalThis.__driverBotSingleton.started = true;

  wireHandlers();

  console.log('🚗 Driver bot initialized');
  return bot;
}

/* ---------------- External hooks (server helpers) ---------------- */
// Notify a driver about a new request with Accept/Ignore buttons
export async function notifyDriverNewRequest({ chatId, ride }) {
  if (!bot || !chatId || !ride) return;

  const short = String(ride._id).slice(-4).toLowerCase();
  const bodyLines = [];
  bodyLines.push('🚗 <b>New Ride Request</b>');
  bodyLines.push(`• Vehicle: <b>${(ride.vehicleType || 'normal').toUpperCase()}</b>`);
  if (ride.estimate != null) bodyLines.push(`• Estimate: <b>R${ride.estimate}</b>`);
  if (ride.pickup) bodyLines.push(`• Pickup: <a href="${toMap(ride.pickup)}">map</a>`);
  if (ride.destination) bodyLines.push(`• Drop: <a href="${toMap(ride.destination)}">map</a>`);
  bodyLines.push('');
  bodyLines.push(`Reply with the buttons below (or use code <b>${short}</b>).`);

  try {
    await bot.sendMessage(chatId, bodyLines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Accept', callback_data: `accept_${String(ride._id)}` },
          { text: '🙈 Ignore', callback_data: `ignore_${String(ride._id)}` }
        ]]
      }
    });
  } catch {}
}

// Arrival & finish summaries for parity with WA bot
export async function notifyDriverArrived({ chatId }) {
  if (!bot || !chatId) return;
  try { await bot.sendMessage(chatId, '📍 Arrival detected at pickup.'); } catch {}
}

export async function notifyDriverFinishSummary({ chatId, body, rideId }) {
  if (!bot || !chatId) return;
  try { await bot.sendMessage(chatId, body || '🏁 Trip finished.'); } catch {}
  if (rideId) {
    try { await bot.sendMessage(chatId, 'How was the rider? Please leave a rating:', starsKeyboard('rate_rider', String(rideId))); } catch {}
  }
}

export async function notifyDriverRideFinished(rideId) {
  const ride = await Ride.findById(rideId).lean();
  if (!ride || !ride.driverId) return;

  try { await Driver.computeAndUpdateStats(ride.driverId); } catch {}
  const driver = await Driver.findById(ride.driverId).lean();
  const chatId = driver?.chatId;
  if (!bot || !chatId) return;

  const distM = Array.isArray(ride.path) && ride.path.length > 1
    ? ride.path.reduce((acc, curr, i, arr) => {
        if (i === 0) return 0;
        const prev = arr[i - 1];
        const toRad = (x) => (x * Math.PI) / 180;
        const R = 6371000;
        const dLat = toRad(curr.lat - prev.lat);
        const dLon = toRad(curr.lng - prev.lng);
        const s = Math.sin(dLat/2)**2 +
                  Math.cos(toRad(prev.lat)) *
                  Math.cos(toRad(curr.lat)) *
                  Math.sin(dLon/2)**2;
        return acc + 2 * R * Math.asin(Math.sqrt(Math.max(0, s)));
      }, 0)
    : 0;

  const startTs = ride.createdAt ? new Date(ride.createdAt).getTime() : null;
  const endTs   = ride.completedAt ? new Date(ride.completedAt).getTime()
              : (ride.updatedAt ? new Date(ride.updatedAt).getTime() : null);
  const durSec  = (startTs && endTs && endTs >= startTs) ? Math.round((endTs - startTs)/1000) : 0;

  const paidMethod = (ride.paymentMethod === 'cash' || ride.paymentMethod === 'payfast' || ride.paymentMethod === 'app') ? ride.paymentMethod : null;
  const paidLine = paidMethod ? `${paymentEmoji(paidMethod)} ${paidMethod.toUpperCase()}` : '✅ Finished';

  const header = `🏁 <b>Trip Finished</b>\n${paidLine}`;
  const amountLine = fmtAmount((ride.finalAmount != null ? ride.finalAmount : ride.estimate) || 0);
  const body = [
    `• Amount: <b>${amountLine}</b>`,
    `• Distance: <b>${fmtKm(distM)}</b>`,
    `• Duration: <b>${fmtDuration(durSec)}</b>`
  ].join('\n');

  const totals = driver?.stats
    ? `\n\n📊 <b>Totals</b>\n` +
      `• Trips: <b>${driver.stats.totalTrips || 0}</b>\n` +
      `• Earnings: <b>${fmtAmount(driver.stats.totalEarnings || 0)}</b>\n` +
      `• Distance: <b>${fmtKm(driver.stats.totalDistanceM || 0)}</b>`
    : '';

  try { await bot.sendMessage(chatId, `${header}\n${body}${totals}`, { parse_mode: 'HTML' }); } catch (e) {
    console.warn('notifyDriverRideFinished sendMessage failed:', e?.message || e);
  }

  try {
    await bot.sendMessage(chatId, 'How was the rider? Please leave a rating:', starsKeyboard('rate_rider', String(rideId)));
  } catch {}
}

export async function sendApprovalNotice(chatId) {
  if (!bot) throw new Error('Driver bot not initialized. Call initDriverBot() first.');
  if (chatId == null) { console.warn('⚠️ sendApprovalNotice called without chatId'); return; }
  try { await sendApprovalNoticeInternal(chatId); } catch (err) {
    console.error('Error sending Telegram approval notice:', err?.message || err);
  }
}

export { bot as driverBot };
