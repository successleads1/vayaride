// src/routes/payfastNotify.js
import express from 'express';
import Ride from '../models/Ride.js';
import Rider from '../models/Rider.js';
import { riderEvents } from '../bots/riderBot.js';
import { sendPaymentReceiptEmail } from '../services/mailer.js';

/**
 * IMPORTANT (in your main server file):
 * app.use(express.urlencoded({ extended: true }));
 * so PayFast/x-www-form-urlencoded bodies populate req.body
 */
const router = express.Router();

router.post('/notify', async (req, res) => {
  try {
    const body = req.body || {};

    // PayFast sends m_payment_id — we also accept partnerId/rideId for safety
    const rideId = body.m_payment_id || body.partnerId || body.rideId || null;
    if (!rideId) return res.status(400).send('Missing ride ID');

    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).send('Ride not found');

    // Minimal status check (PayFast: "COMPLETE")
    const status = String(body.payment_status || '').toUpperCase();
    if (!['COMPLETE', 'COMPLETE_PAYMENT', 'PAID'].includes(status)) {
      // Still OK to return 200 so PayFast doesn't retry excessively
      return res.status(200).send('IGNORED');
    }

    // Payer email (PayFast payload uses 'email_address')
    let payerEmail =
      (body.email_address && String(body.email_address).trim()) ||
      (body.email && String(body.email).trim()) ||
      '';

    // If we're missing an email (e.g., mocked payload), look up rider
    if (!payerEmail) {
      let riderDoc = null;
      if (ride.riderChatId) {
        riderDoc = await Rider.findOne({ chatId: ride.riderChatId });
      }
      if (!riderDoc && ride.riderWaJid) {
        riderDoc = await Rider.findOne({ waJid: ride.riderWaJid });
      }
      payerEmail = riderDoc?.email || '';
    }

    const wasPendingPayment = ride.status === 'payment_pending';

    ride.paymentStatus = 'paid';
    ride.paidAt = new Date();
    ride.paymentMethod = 'payfast';
    if (wasPendingPayment) ride.status = 'pending';
    await ride.save();

    console.log(`✅ PayFast PAID: ride=${ride._id} email=${payerEmail || 'unknown'}`);

    // Fire-and-forget receipt email
    try {
      await sendPaymentReceiptEmail(payerEmail, {
        amount: ride.estimate,
        paymentMethod: 'PayFast',
        paidAt: ride.paidAt,
      });
    } catch (mailErr) {
      console.error('✉️ Receipt email failed:', mailErr?.message || mailErr);
    }

    // Kick off driver request only if this ride was waiting on payment
    if (wasPendingPayment) {
      riderEvents.emit('booking:new', {
        chatId: ride.riderChatId || null,
        rideId: String(ride._id),
        vehicleType: ride.vehicleType || 'normal',
      });
    }

    return res.status(200).send('OK');
  } catch (e) {
    console.error('payfast notify error', e);
    return res.status(500).send('ERR');
  }
});

/* Dev helper to simulate success locally (no email in this one) */
router.get('/mock-complete/:rideId', async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.rideId);
    if (!ride) return res.status(404).send('Ride not found');

    const wasPendingPayment = ride.status === 'payment_pending';
    ride.paymentStatus = 'paid';
    ride.paidAt = new Date();
    ride.paymentMethod = 'payfast';
    if (wasPendingPayment) ride.status = 'pending';
    await ride.save();

    if (wasPendingPayment) {
      riderEvents.emit('booking:new', {
        chatId: ride.riderChatId || null,
        rideId: String(ride._id),
        vehicleType: ride.vehicleType || 'normal',
      });
    }

    return res.send('✅ Mocked PayFast complete. Driver request triggered.');
  } catch (e) {
    console.error(e);
    return res.status(500).send('ERR');
  }
});

export default router;