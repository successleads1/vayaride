// src/bots/driverBot.js
import TelegramBot from 'node-telegram-bot-api';
import EventEmitter from 'events';
import Driver from '../models/Driver.js';
import Ride from '../models/Ride.js';

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

const PUBLIC_URL = process.env.PUBLIC_URL || '';
const DRIVER_WEBHOOK_PATH = process.env.TELEGRAM_DRIVER_WEBHOOK_PATH || '/telegram/driver';

const toNum = (v) => (v == null ? v : Number(v));

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
async function linkDriverByEmail(email, msg) {
  const chatId = toNum(msg.chat.id);
  const tgUsername = msg.from?.username || null;

  const emailRegex = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  await Driver.updateMany({ chatId }, { $unset: { chatId: '' } });

  const driver = await Driver.findOneAndUpdate(
    { email: emailRegex },
    { $set: { chatId, telegramUsername: tgUsername } },
    { new: true }
  );
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
function formatStatsMessage(driver) {
  const s = driver?.stats || {}; const last = s.lastTrip || {};
  const lines = [];
  lines.push('📊 <b>Your Stats</b>');
  lines.push(`• Trips: <b>${s.totalTrips || 0}</b>`);
  lines.push(`• Distance: <b>${fmtKm(s.totalDistanceM || 0)}</b>`);
  lines.push(`• Earnings: <b>${fmtAmount(s.totalEarnings || 0)}</b>`);
  lines.push(`• Payments: ${s.cashCount || 0} cash · ${s.payfastCount || 0} payfast`);
  if (typeof s.avgRating === 'number' && s.ratingsCount >= 0) {
    lines.push(`• Rating: <b>${(s.avgRating || 0).toFixed(2)}</b> (${s.ratingsCount || 0})`);
  }
  if (last && last.rideId) {
    const p = last.pickup ? `${last.pickup.lat?.toFixed(5)},${last.pickup.lng?.toFixed(5)}` : '—';
    const d = last.drop ? `${last.drop.lat?.toFixed(5)},${last.drop.lng?.toFixed(5)}` : '—';
    lines.push('\n🧾 <b>Last Trip</b>');
    lines.push(`• Distance: <b>${fmtKm(last.distanceMeters || 0)}</b>`);
    lines.push(`• Duration: <b>${fmtDuration(last.durationSec || 0)}</b>`);
    lines.push(`• Amount: <b>${fmtAmount(last.amount || 0)}</b> ${paymentEmoji(last.method)}`);
    lines.push(`• Pickup: <code>${p}</code>`);
    lines.push(`• Drop:   <code>${d}</code>`);
  }
  return lines.join('\n');
}
async function ensureAndGetDriverStatsByChat(chatId) {
  const driver = await Driver.findOne({ chatId: Number(chatId) });
  if (!driver) return null;
  try { await Driver.computeAndUpdateStats(driver._id); } catch {}
  return await Driver.findById(driver._id);
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

    const isOnline = !!driver.isAvailable;
    await bot.sendMessage(
      chatId,
      isOnline
        ? '✅ You are currently ONLINE. You will receive ride requests.'
        : '⏸ You are currently OFFLINE.',
      onlineKeyboard(isOnline)
    );

    await bot.sendMessage(chatId, 'When ONLINE, share your **live location** so riders can be matched to you.', { parse_mode: 'Markdown' });
    await bot.sendMessage(chatId, 'Tap below to send your location:', locationKeyboard());
    await bot.sendMessage(
      chatId,
      '🛰 To stream **Live Location** (so the red dot moves):\n' +
      '1) Tap the 📎 (attach) button → *Location*\n' +
      '2) Choose **Share Live Location** (e.g., 15 minutes)\n' +
      '3) Keep Telegram open in the background.',
      { parse_mode: 'Markdown' }
    );

    try {
      driver = await ensureAndGetDriverStatsByChat(chatId);
      if (driver?.stats) {
        await bot.sendMessage(chatId, formatStatsMessage(driver), { parse_mode: 'HTML' });
      }
    } catch {}

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
          await bot.sendMessage(chatId, 'Please rate your last rider:', starsKeyboard('rate_rider', String(lastUnrated._id)));
        }
      }
    } catch {}
  });

  bot.onText(/^\/stats$/, async (msg) => {
    const chatId = toNum(msg.chat.id);
    const driver = await ensureAndGetDriverStatsByChat(chatId);
    if (!driver) return void bot.sendMessage(chatId, '❌ Driver profile not found.');
    await bot.sendMessage(chatId, formatStatsMessage(driver), { parse_mode: 'HTML' });
  });

  bot.onText(/^\/whoami$/, async (msg) => {
    const chatId = toNum(msg.chat.id);
    const driver = await Driver.findOne({ chatId }).lean();
    if (!driver) return void bot.sendMessage(chatId, "I don't see your driver profile yet. Try `LINK your@email.com`.");
    await bot.sendMessage(chatId, `You are:
• email: ${driver.email || '-'}
• name: ${driver.name || '-'}
• status: ${driver.status}
• online: ${driver.isAvailable ? 'yes' : 'no'}
• chatId: ${driver.chatId}`);
  });

  bot.onText(/^\/online$/, async (msg) => {
    const chatId = toNum(msg.chat.id);
    const driver = await setAvailability(chatId, true);
    if (!driver) return void bot.sendMessage(chatId, '❌ Driver profile not found.');
    await bot.sendMessage(chatId, '🟢 You are now ONLINE. You will receive ride requests.', onlineKeyboard(true));
    await bot.sendMessage(chatId, 'Send your live location:', locationKeyboard());
    await bot.sendMessage(
      chatId,
      '🛰 To stream **Live Location**:\n' +
      '📎 → Location → **Share Live Location**.',
      { parse_mode: 'Markdown' }
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
    console.log(`📥 DRIVER LOC <- chatId=${chatId} lat=${latitude} lng=${longitude}`);

    await Driver.findOneAndUpdate(
      { chatId: Number(chatId) },
      { $set: { location: { lat: latitude, lng: longitude }, lastSeenAt: new Date(), isAvailable: true } },
      { new: true }
    );

    console.log(`📤 EMIT driver:location -> chatId=${Number(chatId)} lat=${latitude} lng=${longitude}`);
    driverEvents.emit('driver:location', { chatId: Number(chatId), location: { lat: latitude, lng: longitude } });
  }

  bot.on('message', async (msg) => {
    const loc = msg?.location;
    if (!loc) return;
    const chatId = toNum(msg.chat.id);
    await recordAndBroadcastLocation(chatId, loc.latitude, loc.longitude);
    try { await bot.sendMessage(chatId, '📍 Location updated. Thanks!'); } catch {}

    const looksOneOff = !msg.edit_date && !msg.live_period && !(msg.location && msg.location.live_period);
    if (looksOneOff) {
      try {
        await bot.sendMessage(
          chatId,
          'ℹ️ I received a one-time location. To **update live** while you move:\n' +
          '📎 → Location → **Share Live Location**.',
          { parse_mode: 'Markdown' }
        );
      } catch {}
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
        const driver = await setAvailability(chatId, true);
        await bot.answerCallbackQuery(query.id);
        if (!driver) return void bot.sendMessage(chatId, '❌ Driver profile not found.');
        await bot.editMessageText('🟢 You are now ONLINE. You will receive ride requests.', {
          chat_id: chatId, message_id: query.message.message_id, ...onlineKeyboard(true)
        });
        await bot.sendMessage(chatId, 'Send your live location:', locationKeyboard());
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

        const driver = await Driver.findOne({ chatId: Number(chatId) });
        if (driver && !ride.driverId) { ride.driverId = driver._id; }
        ride.status = 'accepted';
        await ride.save();

        await bot.answerCallbackQuery(query.id, { text: 'Ride accepted' });
        await bot.sendMessage(chatId, '✅ You accepted the ride.');

        console.log(`✅ Driver ${chatId} accepted ride ${rideId}`);
        driverEvents.emit('ride:accepted', { driverId: chatId, rideId });
        return;
      }

      if (data.startsWith('ignore_')) {
        const rideId = data.replace('ignore_', '');
        const ride = await Ride.findById(rideId);
        await bot.answerCallbackQuery(query.id, { text: 'Ignored' });
        if (ride) driverEvents.emit('ride:ignored', { previousDriverId: chatId, ride });
        console.log(`🙈 Driver ${chatId} ignored ride ${rideId}`);
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

/* ---------------- External hooks ---------------- */
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
