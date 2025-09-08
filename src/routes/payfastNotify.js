// src/routes/payfastNotify.js
import express from 'express';
import crypto from 'crypto';

import Ride from '../models/Ride.js';
import Rider from '../models/Rider.js';
import { riderEvents } from '../bots/riderBot.js';
import { riderBot as RB } from '../bots/riderBot.js';
import { sendWhatsAppMessage } from '../bots/whatsappBot.js';
import { sendPaymentReceiptEmail, sendPaymentFailedEmail } from '../services/mailer.js';

const router = express.Router();

const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID || '';
const PAYFAST_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY || '';
const PAYFAST_PASSPHRASE  = process.env.PAYFAST_PASSPHRASE  || '';
const ALLOW_PAYFAST_SIM   = (process.env.ALLOW_PAYFAST_SIM ?? '1') !== '0';

function buildSignature(body, passPhrase = '') {
  const filtered = Object.keys(body)
    .filter((k) => k !== 'signature' && body[k] !== undefined && body[k] !== null && String(body[k]).trim() !== '');
  filtered.sort();
  const paramString = filtered
    .map((k) => {
      const v = String(body[k]).trim();
      const ek = encodeURIComponent(k).replace(/%20/g, '+');
      const ev = encodeURIComponent(v).replace(/%20/g, '+');
      return `${ek}=${ev}`;
    })
    .join('&');
  const toHash = passPhrase && passPhrase.trim()
    ? `${paramString}&passphrase=${encodeURIComponent(passPhrase.trim()).replace(/%20/g, '+')}`
    : paramString;
  const hex = crypto.createHash('md5').update(toHash).digest('hex');
  return { hex, toHash };
}

// Dev helper — treat missing signature as simulate when enabled
function isSimulated(req, data) {
  const qSim = String(req.query?.simulate || '').trim();
  const bSim = String(req.body?.simulate || '').trim();
  const looksLikeSim = (!data?.signature || String(data.signature).trim() === '') && !data?.pf_payment_id;
  return ALLOW_PAYFAST_SIM && (qSim === '1' || bSim === '1' || looksLikeSim);
}

async function getRiderEmailForRide(ride) {
  try {
    if (ride?.riderEmail) return String(ride.riderEmail).trim();
    if (ride?.rider?.email) return String(ride.rider.email).trim();

    if (ride?.riderChatId) {
      const r = await Rider.findOne({ chatId: Number(ride.riderChatId) }).select('email').lean();
      if (r?.email) return String(r.email).trim();
    }
    if (ride?.riderWaJid) {
      const r = await Rider.findOne({ waJid: ride.riderWaJid }).select('email').lean();
      if (r?.email) return String(r.email).trim();
    }
  } catch {}
  return null;
}

router.post('/notify', async (req, res) => {
  try {
    const data = req.body || {};
    const sim  = isSimulated(req, data);

    console.log('📨 PayFast ITN received', {
      m_payment_id: data.m_payment_id,
      pf_payment_id: data.pf_payment_id,
      payment_status: data.payment_status,
      simulate: sim
    });

    // Signature check (skipped for simulation)
    if (!sim) {
      const calc = buildSignature(data, PAYFAST_PASSPHRASE);
      const ok = (String(data.signature || '').toLowerCase() === calc.hex.toLowerCase());
      console.log('🔎 Signature valid:', ok);
      if (!ok) return res.status(400).json({ error: 'invalid_signature' });
    } else {
      console.log('🧪 Simulation mode: signature bypassed.');
    }

    if (!sim && PAYFAST_MERCHANT_ID && data.merchant_id && data.merchant_id !== PAYFAST_MERCHANT_ID) {
      return res.status(400).json({ error: 'invalid_merchant' });
    }
    if (!sim && PAYFAST_MERCHANT_KEY && data.merchant_key && data.merchant_key !== PAYFAST_MERCHANT_KEY) {
      return res.status(400).json({ error: 'invalid_merchant_key' });
    }

    const rideId = String(data.m_payment_id || '').trim();
    if (!rideId) return res.json({ ok: true, note: 'no_m_payment_id' });

    const ride = await Ride.findById(rideId);
    if (!ride) return res.json({ ok: true, note: 'ride_not_found' });

    // Persist audit info
    try {
      ride.payfast = {
        ...(ride.payfast || {}),
        lastStatus: data.payment_status || null,
        pfPaymentId: data.pf_payment_id || null,
        signatureOk: true,
        lastItnAt: new Date(),
        lastItn: data
      };
    } catch {}

    const status = String(data.payment_status || '').toUpperCase();
    const amountGross = Number.parseFloat(data.amount_gross ?? '');
    const amount = Number.isFinite(amountGross)
      ? amountGross
      : Number(ride.finalAmount ?? ride.estimate ?? 0);

    if (status === 'COMPLETE') {
      // Mark paid + move into dispatch queue
      ride.paymentMethod = 'payfast';
      ride.paymentStatus = 'paid';
      ride.paidAt = new Date();
      if (!['pending','accepted','enroute','completed','cancelled'].includes(ride.status)) {
        ride.status = 'pending';
      }
      await ride.save();

      // Thank the rider (TG/WA)
      const thanks =
        `✅ Payment received${amount ? ` (R${amount.toFixed(2)})` : ''}. ` +
        `Requesting your driver now—thanks!`;
      try { if (ride.riderChatId) await RB.sendMessage(ride.riderChatId, thanks); } catch {}
      try { if (ride.riderWaJid)  await sendWhatsAppMessage(ride.riderWaJid, thanks); } catch {}

      // Email receipt (best-effort)
      try {
        const riderEmail = await getRiderEmailForRide(ride);
        if (riderEmail) {
          await sendPaymentReceiptEmail(riderEmail, {
            amount,
            paymentMethod: 'PayFast',
            paidAt: ride.paidAt
          });
        } else {
          console.log('📧 No rider email on file, skipping receipt.');
        }
      } catch (e) {
        console.warn('sendPaymentReceiptEmail failed:', e?.message || e);
      }

      // 🚀 Trigger the same pipeline Cash uses
      try { riderEvents.emit('booking:new', { rideId: String(ride._id) }); } catch {}

      console.log(`✅ PayFast COMPLETE → ride ${rideId} marked paid + driver dispatch started.`);
      return res.json({ ok: true });
    }

    if (status === 'FAILED') {
      try { ride.paymentStatus = 'failed'; } catch {}
      await ride.save();

      // Inform rider (TG/WA)
      const msg = '❌ Your card payment failed. You can try again or choose a different method.';
      try { if (ride.riderChatId) await RB.sendMessage(ride.riderChatId, msg); } catch {}
      try { if (ride.riderWaJid)  await sendWhatsAppMessage(ride.riderWaJid, msg); } catch {}

      // Email failure
      try {
        const riderEmail = await getRiderEmailForRide(ride);
        if (riderEmail) {
          await sendPaymentFailedEmail(riderEmail, {
            amount,
            reason: 'Your PayFast payment attempt did not complete.'
          });
        }
      } catch (e) {
        console.warn('sendPaymentFailedEmail failed:', e?.message || e);
      }

      console.log(`❌ PayFast FAILED for ride ${rideId}`);
      return res.json({ ok: true });
    }

    // PENDING or other
    await ride.save();
    console.log(`ℹ️ PayFast status "${status}" stored for ride ${rideId}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ /api/payfast/notify error:', err?.message || err);
    return res.status(500).json({ error: 'itn_error' });
  }
});

router.get('/notify', (_req, res) => {
  res.json({ status: 'PayFast notify endpoint', time: new Date().toISOString() });
});

export default router;
