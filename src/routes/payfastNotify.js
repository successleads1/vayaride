// src/routes/payfastNotify.js
import express from 'express';
import crypto from 'crypto';

const router = express.Router();

/**
 * NOTE on body parsing & signature:
 * PayFast ITN asks that you rebuild the signature input from the POSTed fields,
 * excluding "signature" and empty values, in the order received.
 *
 * Express' urlencoded parser gives us an object (order not guaranteed).
 * In practice, hashing keys in alphabetical order also works reliably with ITN.
 * If you want to be extra strict about order, capture req.rawBody with custom middleware.
 */
function buildSignatureFromBody(body, passPhrase = '') {
  // Exclude signature and empty values, sort keys for deterministic hashing
  const pairs = Object.keys(body)
    .filter((k) => k !== 'signature' && body[k] != null && String(body[k]).trim() !== '')
    .sort()
    .map((k) => {
      const ek = encodeURIComponent(k).replace(/%20/g, '+');
      const ev = encodeURIComponent(String(body[k]).trim()).replace(/%20/g, '+');
      return `${ek}=${ev}`;
    });

  const paramString = pairs.join('&');
  const input = passPhrase && passPhrase.trim()
    ? `${paramString}&passphrase=${encodeURIComponent(passPhrase.trim()).replace(/%20/g, '+')}`
    : paramString;

  const hash = crypto.createHash('md5').update(input).digest('hex');
  return { hash, input };
}

router.post('/notify', async (req, res) => {
  try {
    const PAYFAST_MERCHANT_ID  = process.env.PAYFAST_MERCHANT_ID || '';
    const PAYFAST_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY || '';
    const PAYFAST_PASSPHRASE   = process.env.PAYFAST_PASSPHRASE || '';

    const data = req.body || {};
    // Debug safely (no secrets)
    console.log('📨 PayFast ITN received:', data);

    // 1) Signature check
    const receivedSig = data.signature || '';
    const { hash: calcSig /*, input*/ } = buildSignatureFromBody(data, PAYFAST_PASSPHRASE);

    const sigOk = (receivedSig === calcSig);
    console.log('🔎 Signature valid:', sigOk);

    if (!sigOk) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // 2) Merchant check (ID required; key often included too)
    if (data.merchant_id && data.merchant_id !== PAYFAST_MERCHANT_ID) {
      console.error('❌ Invalid merchant_id:', data.merchant_id);
      return res.status(400).json({ error: 'Invalid merchant' });
    }
    if (data.merchant_key && data.merchant_key !== PAYFAST_MERCHANT_KEY) {
      console.error('❌ Invalid merchant_key:', data.merchant_key);
      return res.status(400).json({ error: 'Invalid merchant key' });
    }

    // 3) Extract our custom fields
    const plan       = data.custom_str1 || null;       // plan
    const paymentId  = data.custom_str2 || null;       // internal id
    const partnerId  = data.custom_str3 || null;       // Mongo ObjectId as string (IMPORTANT)

    // 4) Status handling
    const status = data.payment_status || 'PENDING';
    const gross  = data.amount_gross || data.amount || null;

    if (status === 'COMPLETE') {
      // 👉 Update your DBs here. Example shown for Mongoose Ride/Partner style apps:
      try {
        // Example pseudo-updates (replace with your actual models/logic)
        // - Look up the "partner" by partnerId (string)
        // - Upgrade their tier based on "plan"
        // - Record the PayFast transaction

        console.log(`✅ Payment COMPLETE: partnerId=${partnerId}, plan=${plan}, amount=${gross}, pf_payment_id=${data.pf_payment_id}, m_payment_id=${data.m_payment_id}, internal=${paymentId}`);

        // TODO: your DB logic here (examples):
        // await Partner.updateOne({ _id: new ObjectId(partnerId) }, { $set: { tier: plan.toUpperCase(), ... }});
        // await Payments.create({ partnerId, pfPaymentId: data.pf_payment_id, ...data });

      } catch (dbErr) {
        console.error('DB update error:', dbErr?.message || dbErr);
        // continue; we'll still 200 so PayFast doesn’t retry forever if our side hiccups
      }
    } else {
      console.log(`ℹ️ ITN status: ${status} (pf_payment_id=${data.pf_payment_id})`);
    }

    // Always 200 OK back to PayFast if we processed the message (even if our downstream failed)
    res.json({ ok: true });
  } catch (e) {
    console.error('notify error:', e);
    // 500 will make PayFast retry; only use if you need them to resend
    res.status(500).json({ error: 'Notify processing failed' });
  }
});

/**
 * Optional helper to hit from a browser when testing wiring
 */
router.get('/notify', (req, res) => {
  res.json({ status: 'PayFast notify endpoint alive', ts: new Date().toISOString() });
});

export default router;
