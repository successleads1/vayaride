// src/routes/payfast.js
import express from 'express';
import Ride from '../models/Ride.js';
import Rider from '../models/Rider.js';

const router = express.Router();

/**
 * Redirects to your Next.js PayFast gateway:
 *   <NEXT_GATEWAY_BASE>/api/partner/upgrade/payfast
 * NEXT_GATEWAY_BASE is pulled from:
 *   - process.env.NEXT_GATEWAY_URL  (preferred)
 *   - process.env.PUBLIC_URL        (fallback, e.g., your ngrok)
 *   - inferred http(s)://host       (last resort)
 */
router.get('/:rideId', async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.rideId);
    if (!ride) return res.status(404).send('Ride not found');

    // Resolve rider email
    let riderEmail = '';
    if (ride.riderChatId) {
      const r = await Rider.findOne({ chatId: ride.riderChatId });
      riderEmail = r?.email || '';
    }
    if (!riderEmail && ride.riderWaJid) {
      const r = await Rider.findOne({ waJid: ride.riderWaJid });
      riderEmail = r?.email || '';
    }
    if (!riderEmail) riderEmail = 'user@mail.com'; // safe fallback

    const inferred = `${req.protocol}://${req.get('host')}`;
    const gatewayBase = (process.env.NEXT_GATEWAY_URL || process.env.PUBLIC_URL || inferred).replace(/\/+$/, '');
    const url = new URL(`${gatewayBase}/api/partner/upgrade/payfast`);

    // Forward required params to your Next.js route
    url.searchParams.set('m_payment_id', ride._id.toString()); // optional hint
    url.searchParams.set('partnerId', ride._id.toString());
    url.searchParams.set('plan', ride.vehicleType || 'basic');
    url.searchParams.set('amount', Number(ride.estimate || 0).toFixed(2));
    url.searchParams.set('email', riderEmail);
    url.searchParams.set('companyName', 'TelegramRider');
    url.searchParams.set('contactName', 'Telegram Rider');

    return res.redirect(url.toString());
  } catch (e) {
    console.error('payfast route error', e);
    return res.status(500).send('ERR');
  }
});

export default router;
