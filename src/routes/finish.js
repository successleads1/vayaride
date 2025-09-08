// src/routes/finish.js
import express from 'express';
import Ride from '../models/Ride.js';
import Driver from '../models/Driver.js';
import Rider from '../models/Rider.js';
import { sendPaymentReceiptEmail } from '../services/mailer.js';
import { computeFinalFare, appendPathPoint } from '../services/pricing.js';
import { notifyDriverRideFinished } from '../bots/driverBot.js';
import { notifyRiderToRateDriver } from '../bots/riderBot.js';
import { sendWhatsAppMessage, notifyWhatsAppRiderToRate } from '../bots/whatsappBot.js';

const router = express.Router();

router.post('/api/ride/:rideId/finish', async (req, res) => {
  try {
    const { rideId } = req.params;
    const { paidMethod } = req.body || {}; // 'cash' | 'payfast'
    const ride = await Ride.findById(rideId);

    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    // Stamp final coords before computing/saving (use driver's latest location)
    if (ride.driverId) {
      const drv = await Driver.findById(ride.driverId).lean();
      if (
        drv?.location &&
        typeof drv.location.lat === 'number' &&
        typeof drv.location.lng === 'number'
      ) {
        await appendPathPoint(ride._id, drv.location.lat, drv.location.lng, 'FINISH');
      }
    }

    // Compute final fare details
    const {
      price,
      tripKm,
      actualDurationSec,
      // expectedDurationSec (not used in response)
      trafficFactor,
      surge
    } = await computeFinalFare({
      pickup: ride.pickup,
      destination: ride.destination,
      vehicleType: ride.vehicleType || 'normal',
      path: ride.path || null,
      createdAt: ride.createdAt,
      pickedAt: ride.pickedAt || ride.startedAt || ride.createdAt,
      completedAt: new Date()
    });

    // Update ride details
    ride.status = 'completed';
    ride.completedAt = new Date();
    ride.paymentMethod = paidMethod === 'cash' ? 'cash' : 'payfast';

    if (ride.paymentMethod === 'cash' && ride.paymentStatus !== 'paid') {
      ride.paymentStatus = 'paid';
      ride.paidAt = new Date();
    }

    ride.finalAmount = price;
    ride.finalDistanceKm = tripKm;
    ride.finalDurationSec = actualDurationSec;
    ride.finalTrafficFactor = trafficFactor;
    ride.finalSurge = surge;

    await ride.save();

    // Resolve rider's email (Telegram or WhatsApp profile, if present)
    let riderEmail = '';
    if (ride.riderChatId != null) {
      const r = await Rider.findOne({ chatId: ride.riderChatId }).lean();
      riderEmail = r?.email || '';
    }
    if (!riderEmail && ride.riderWaJid) {
      const r = await Rider.findOne({ waJid: ride.riderWaJid }).lean();
      riderEmail = r?.email || '';
    }

    // Email (simple receipt)
    if (riderEmail) {
      try {
        await sendPaymentReceiptEmail(riderEmail, {
          amount: price,
          paymentMethod: ride.paymentMethod,
          paidAt: ride.paidAt
        });
      } catch (e) {
        console.warn('Email receipt failed:', e?.message || e);
      }
    }

    // WhatsApp summary + rating prompt (if ride was booked on WhatsApp)
    try {
      if (ride.riderWaJid) {
        const km = (Number(ride.finalDistanceKm || 0)).toFixed(2);
        const mins = Math.max(1, Math.round(Number(ride.finalDurationSec || 0) / 60));
        const priceZAR = Math.round(Number(ride.finalAmount || 0));

        const summaryMsg =
          `🏁 *Trip Complete*\n` +
          `• Distance: *${km} km*\n` +
          `• Duration: *~${mins} min*\n` +
          `• Fare: *R${priceZAR}*\n` +
          (ride.paymentMethod ? `• Payment: *${ride.paymentMethod.toUpperCase()}*\n` : '') +
          `\nPlease rate your driver: reply with a number from *1* (worst) to *5* (best).`;

        await sendWhatsAppMessage(ride.riderWaJid, summaryMsg);
        await notifyWhatsAppRiderToRate(ride);
      }
    } catch (e) {
      console.warn('WA finish notify failed:', e?.message || e);
    }

    // Telegram rating prompt (if rider is on Telegram)
    try {
      if (ride.riderChatId) {
        // Trigger the bot helper that shows the ★ buttons
        await notifyRiderToRateDriver(ride);

        // Optional compact receipt
        const { riderBot } = await import('../bots/riderBot.js');
        const ZAR = (n) => `R${Math.round(Number(n || 0))}`;
        const durFmt = (s) => {
          const sec = Number(s || 0);
          const h = Math.floor(sec / 3600);
          const m = Math.floor((sec % 3600) / 60);
          const r = sec % 60;
          if (h) return `${h}h ${m}m`;
          if (m) return `${m}m ${r}s`;
          return `${r}s`;
        };
        const methodEmoji = ride.paymentMethod === 'cash' ? '💵' : '💳';
        const methodText = ride.paymentMethod === 'cash' ? 'Cash' : 'Card (PayFast)';
        const tgText =
          `🏁 <b>Trip Complete</b>\n` +
          `• Amount: <b>${ZAR(price)}</b>\n` +
          `• Distance: <b>${(tripKm || 0).toFixed(2)} km</b>\n` +
          `• Duration: <b>${durFmt(actualDurationSec)}</b>\n` +
          `• Payment: ${methodEmoji} <b>${methodText}</b>\n\n` +
          `Please leave a rating in the message above 👆`;
        try {
          await riderBot.sendMessage(Number(ride.riderChatId), tgText, { parse_mode: 'HTML' });
        } catch {}
      }
    } catch (e) {
      console.warn('Telegram finish notify failed:', e?.message || e);
    }

    // Notify driver (thanks/summary and driver-side rating of rider)
    try {
      await notifyDriverRideFinished(ride._id);
    } catch (e) {
      console.warn('notifyDriverRideFinished failed:', e?.message || e);
    }

    // Emit to front-end via Socket.IO (if available)
    try {
      const io = req.app.get('io');
      io?.emit?.(`ride:${rideId}:finished`, {
        paidMethod: ride.paymentMethod,
        amount: price,
        distanceKm: tripKm,
        durationSec: actualDurationSec
      });
    } catch (e) {
      console.warn('socket emit failed:', e?.message || e);
    }

    console.log(
      `🏁 FINISHED ride=${rideId} method=${ride.paymentMethod} amount=R${price} dist=${tripKm.toFixed(
        2
      )}km dur=${actualDurationSec}s`
    );

    return res.json({
      ok: true,
      paidMethod: ride.paymentMethod,
      paymentStatus: ride.paymentStatus,
      amount: price,
      distanceKm: tripKm,
      durationSec: actualDurationSec
    });
  } catch (e) {
    console.error('finish error', e);
    res.status(500).json({ error: 'Failed to finish trip' });
  }
});

export default router;
