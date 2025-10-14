// src/routes/payfastGateway.js
import express from 'express';
import crypto from 'crypto';

const router = express.Router();

function toTwoDecimals(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid amount');
  return n.toFixed(2);
}

/** Build signature from the SAME ordered list the form will submit */
function generateSignatureFromPairs(pairs, passPhrase = '') {
  const filtered = pairs.filter(([, val]) => {
    const s = val == null ? '' : String(val).trim();
    return s !== '';
  });

  const paramString = filtered
    .map(([k, v]) => {
      const ek = encodeURIComponent(k).replace(/%20/g, '+');
      const ev = encodeURIComponent(String(v).trim()).replace(/%20/g, '+');
      return `${ek}=${ev}`;
    })
    .join('&');

  const input =
    passPhrase && passPhrase.trim()
      ? `${paramString}&passphrase=${encodeURIComponent(passPhrase.trim()).replace(/%20/g, '+')}`
      : paramString;

  return crypto.createHash('md5').update(input).digest('hex');
}

/**
 * GET /api/payfast/gateway
 * Required: partnerId, plan, amount, email
 * We DO NOT use custom_int1 (must be numeric on PayFast).
 * custom_str1 = plan
 * custom_str2 = internal paymentId
 * custom_str3 = partnerId (Mongo ObjectId/string)
 */
router.get('/gateway', (req, res) => {
  try {
    const {
      partnerId,
      plan,
      amount,
      email,
      companyName = 'VayaRide',
      contactName = 'Customer',
      m_payment_id = '',
    } = req.query;

    if (!partnerId || !plan || !amount || !email) {
      return res
        .status(400)
        .json({ error: 'Missing parameters (partnerId, plan, amount, email required)' });
    }

    const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID || '';
    const PAYFAST_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY || '';
    const PAYFAST_PASSPHRASE = process.env.PAYFAST_PASSPHRASE || '';
    const PAYFAST_URL = process.env.PAYFAST_URL || 'https://payment.payfast.io/eng/process';

    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(
      /\/+$/,
      '',
    );

    // 🔁 IMPORTANT: these now point to /api/partner/..., which you already mount.
    const return_url = `${base}/api/partner/upgrade/success`;
    const cancel_url = `${base}/api/partner/upgrade/cancel`;
    const notify_url = `${base}/api/payfast/notify`;

    const paymentId = m_payment_id || `upgrade_${partnerId}_${Date.now()}`;
    const amt = toTwoDecimals(amount);
    const itemName = `VayaRide ${String(plan).charAt(0).toUpperCase()}${String(plan).slice(1)} Plan`;

    // Ordered list used BOTH for signature + form fields
    const fieldPairs = [
      ['merchant_id', PAYFAST_MERCHANT_ID],
      ['merchant_key', PAYFAST_MERCHANT_KEY],
      ['return_url', `${return_url}?payment=${paymentId}&plan=${plan}`],
      ['cancel_url', `${cancel_url}?payment=${paymentId}&plan=${plan}`],
      ['notify_url', notify_url],
      ['name_first', contactName],
      ['name_last', companyName],
      ['email_address', email],
      ['m_payment_id', paymentId],
      ['amount', amt],
      ['item_name', itemName],
      ['item_description', `Upgrade to ${plan}`],
      // no custom_int1
      ['custom_str1', String(plan)], // plan
      ['custom_str2', paymentId],    // internal payment id
      ['custom_str3', String(partnerId)], // partnerId (ObjectId/string)
    ];

    for (const k of [
      'merchant_id',
      'merchant_key',
      'return_url',
      'cancel_url',
      'notify_url',
      'amount',
      'item_name',
    ]) {
      const found = fieldPairs.find(([fk]) => fk === k)?.[1];
      if (!found) return res.status(500).json({ error: `Missing PayFast field: ${k}` });
    }

    const signature = generateSignatureFromPairs(fieldPairs, PAYFAST_PASSPHRASE);

    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Redirecting…</title></head>
<body>
  <p>Redirecting to PayFast…</p>
  <form id="pf" action="${PAYFAST_URL}" method="post">
    ${fieldPairs
      .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v)}">`)
      .join('\n')}
    <input type="hidden" name="signature" value="${signature}">
  </form>
  <script>document.getElementById('pf').submit();</script>
</body>
</html>`;

    res.set('Content-Type', 'text/html').send(html);
  } catch (e) {
    console.error('payfastGateway error', e);
    res.status(500).json({ error: 'Payment setup failed' });
  }
});

export default router;
