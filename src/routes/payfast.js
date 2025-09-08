// src/routes/payfast.js
import express from 'express';
import Ride from '../models/Ride.js';
import Rider from '../models/Rider.js';

const router = express.Router();

/**
 * GET /pay/:rideId
 * Resolves ride & rider, then redirects to the landing page with all params
 * Landing page base prefers:
 *   1) process.env.NEXT_GATEWAY_URL  (use this to point to your Next app if desired)
 *   2) process.env.PUBLIC_URL
 *   3) inferred request origin
 */
router.get('/:rideId', async (req, res) => {
  try {
    const rideId = req.params.rideId;
    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).send('Ride not found');

    // Resolve rider email (Telegram or WhatsApp)
    let riderEmail = '';
    if (ride.riderChatId) {
      const r = await Rider.findOne({ chatId: ride.riderChatId });
      riderEmail = r?.email || '';
    }
    if (!riderEmail && ride.riderWaJid) {
      const r = await Rider.findOne({ waJid: ride.riderWaJid });
      riderEmail = r?.email || '';
    }
    if (!riderEmail) riderEmail = 'user@mail.com';

    // Amount: prefer finalAmount, fallback to estimate
    const amount = Number(ride.finalAmount ?? ride.estimate ?? 0).toFixed(2);

    const inferred = `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
    const baseLanding = (process.env.NEXT_GATEWAY_URL || process.env.PUBLIC_URL || inferred).replace(/\/+$/, '');
    const url = new URL('/api/partner/upgrade/payfast', baseLanding);

    // Forward params
    url.searchParams.set('m_payment_id', ride._id.toString());
    url.searchParams.set('partnerId', ride._id.toString());
    url.searchParams.set('plan', ride.vehicleType || 'basic');
    url.searchParams.set('amount', amount);
    url.searchParams.set('email', riderEmail);
    url.searchParams.set('companyName', 'TelegramRider');
    url.searchParams.set('contactName', 'Telegram Rider');

    return res.redirect(url.toString());
  } catch (e) {
    console.error('payfast entry error', e);
    return res.status(500).send('ERR');
  }
});

export default router;
