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

/**
 * Finish a ride and notify all channels (email/Telegram/WhatsApp + driver)
 * POST /api/ride/:rideId/finish
 * body: { paidMethod?: 'cash'|'payfast' }
 */
router.post('/api/ride/:rideId/finish', async (req, res) => {
  try {
    const { rideId } = req.params;
    const { paidMethod } = req.body || {};
    const ride = await Ride.findById(rideId);

    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    // Stamp final coords from the driver's last known location
    if (ride.driverId) {
      const drv = await Driver.findById(ride.driverId).lean();
      if (
        drv?.location &&
        typeof drv.location.lat === 'number' &&
        typeof drv.location.lng === 'number'
      ) {
        try {
          await appendPathPoint(ride._id, drv.location.lat, drv.location.lng, 'FINISH');
        } catch (e) {
          console.warn('appendPathPoint failed:', e?.message || e);
        }
      }
    }

    // Compute final fare at finish time
    const {
      price,
      tripKm,
      actualDurationSec,
      trafficFactor,
      surge,
      // expectedDurationSec // (unused here)
    } = await computeFinalFare({
      pickup: ride.pickup,
      destination: ride.destination,
      vehicleType: ride.vehicleType || 'normal',
      path: ride.path || null,
      createdAt: ride.createdAt,
      pickedAt: ride.pickedAt || ride.startedAt || ride.createdAt,
      completedAt: new Date()
    });

    // Update ride
    const now = new Date();
    ride.status = 'completed';
    ride.completedAt = now;

    // Normalize payment method
    const normalizedMethod =
      paidMethod === 'cash' ? 'cash' : paidMethod === 'payfast' ? 'payfast' : (ride.paymentMethod || 'payfast');
    ride.paymentMethod = normalizedMethod;

    // If cash and not marked paid yet, mark now
    if (ride.paymentMethod === 'cash' && ride.paymentStatus !== 'paid') {
      ride.paymentStatus = 'paid';
      ride.paidAt = now;
    }

    ride.finalAmount = price;
    ride.finalDistanceKm = tripKm;
    ride.finalDurationSec = actualDurationSec;
    ride.finalTrafficFactor = trafficFactor;
    ride.finalSurge = surge;

    await ride.save();

    // Lookup rider email (from Telegram or WhatsApp profile)
    let riderEmail = '';
    if (ride.riderChatId != null) {
      const r = await Rider.findOne({ chatId: ride.riderChatId }).lean();
      riderEmail = r?.email || '';
    }
    if (!riderEmail && ride.riderWaJid) {
      const r = await Rider.findOne({ waJid: ride.riderWaJid }).lean();
      riderEmail = r?.email || '';
    }

    // Send email receipt (best-effort)
    if (riderEmail) {
      try {
        await sendPaymentReceiptEmail(riderEmail, {
          amount: price,
          paymentMethod: ride.paymentMethod,
          paidAt: ride.paidAt || now
        });
      } catch (e) {
        console.warn('Email receipt failed:', e?.message || e);
      }
    }

    // WhatsApp summary + rating prompt (if the rider used WhatsApp)
    try {
      if (ride.riderWaJid) {
        const km = (Number(ride.finalDistanceKm || 0)).toFixed(2);
        const mins = Math.max(1, Math.round(Number(ride.finalDurationSec || 0) / 60));
        const priceZAR = Math.round(Number(ride.finalAmount || 0));
        const method =
          ride.paymentMethod === 'cash' ? 'CASH' : ride.paymentMethod === 'payfast' ? 'CARD' : ride.paymentMethod;

        const summaryMsg =
          `🏁 *Trip Complete*\n` +
          `• Distance: *${km} km*\n` +
          `• Duration: *~${mins} min*\n` +
          `• Fare: *R${priceZAR}*\n` +
          (method ? `• Payment: *${method}*\n` : '') +
          `\nPlease rate your driver: reply with a number from *1* (worst) to *5* (best).`;

        await sendWhatsAppMessage(ride.riderWaJid, summaryMsg);
        await notifyWhatsAppRiderToRate(ride);
      }
    } catch (e) {
      console.warn('WA finish notify failed:', e?.message || e);
    }

    // Telegram compact receipt + rating buttons (if the rider used Telegram)
    try {
      if (ride.riderChatId) {
        // Show rating stars via rider bot helper (expects a rideId)
        await notifyRiderToRateDriver(String(ride._id));

        // Optional compact receipt message
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
          // swallow errors silently so rating still shows
        } catch {}
      }
    } catch (e) {
      console.warn('Telegram finish notify failed:', e?.message || e);
    }

    // Notify the driver (summary + prompt to rate rider)
    try {
      await notifyDriverRideFinished(String(ride._id));
    } catch (e) {
      console.warn('notifyDriverRideFinished failed:', e?.message || e);
    }

    // Socket.IO event for dashboards (best-effort)
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
      `🏁 FINISHED ride=${rideId} method=${ride.paymentMethod} amount=R${price} dist=${tripKm.toFixed(2)}km dur=${actualDurationSec}s`
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
    return res.status(500).json({ error: 'Failed to finish trip' });
  }
});

export default router;
