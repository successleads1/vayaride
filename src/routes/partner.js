// src/routes/partner.js
import express from 'express';

const router = express.Router();

/**
 * Local “landing” for upgrades.
 * Lets you:
 *  - Simulate a success (posts to /api/payfast/notify)
 *  - Or redirect to your real PayFast redirect route (/pay/:id)
 *
 * Real redirect base is taken from env/local, NOT hard-coded:
 *   - process.env.PUBLIC_URL        (preferred)
 *   - inferred http(s)://host       (last resort)
 */
router.get('/upgrade/payfast', (req, res) => {
  const {
    m_payment_id = '',
    partnerId = '',
    plan = 'basic',
    amount = '0.00',
    email = '',
    companyName = '',
    contactName = '',
  } = req.query;

  // Local notify (for simulated success)
  const inferred = `${req.protocol}://${req.get('host')}`;
  const base = (process.env.PUBLIC_URL || inferred).replace(/\/+$/, '');
  const notifyUrl = `${base}/api/payfast/notify`;

  // Telegram deep link (optional)
  const tgUser = process.env.TELEGRAM_RIDER_BOT_USERNAME || '';

  res
    .set('Content-Type', 'text/html')
    .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>PayFast Upgrade · VayaRide</title>
  <style>
    :root { --pri:#635bff; --ok:#2e7d32; --err:#c62828; --bg:#f7f7fb; }
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:var(--bg);padding:24px}
    .card{max-width:680px;margin:0 auto;background:#fff;border-radius:14px;box-shadow:0 14px 38px rgba(0,0,0,.08);padding:24px}
    h1{margin:0 0 10px;font-size:22px}
    .row{margin:6px 0;color:#444}
    .muted{color:#777;font-size:13px;margin-top:10px}
    .actions{display:flex;gap:12px;margin-top:18px;flex-wrap:wrap}
    button{background:var(--ok);color:#fff;border:none;border-radius:10px;padding:12px 16px;font-size:16px;cursor:pointer}
    button.secondary{background:#e0e0e6;color:#222}
    button.payfast{background:var(--pri)}
    button:disabled{opacity:.6;cursor:not-allowed}
    .ok{color:var(--ok)}
    .err{color:var(--err)}
    .debug{margin-top:14px;padding:10px;background:#f2f2f5;border-radius:8px;font-size:12px;color:#333;word-break:break-all}
    .grid{display:grid;grid-template-columns: 1fr 1fr; gap: 16px}
    @media (max-width: 560px){ .grid{grid-template-columns:1fr} }
  </style>
</head>
<body>
  <div class="card">
    <h1>🚀 Upgrade via PayFast</h1>
    <div class="grid">
      <div class="row"><b>Ride / Payment ID:</b> ${m_payment_id || partnerId || '-'}</div>
      <div class="row"><b>Plan:</b> ${plan}</div>
      <div class="row"><b>Amount:</b> R${amount}</div>
      <div class="row"><b>Email:</b> ${email || '-'}</div>
      <div class="row"><b>Company:</b> ${companyName || '-'}</div>
      <div class="row"><b>Contact:</b> ${contactName || '-'}</div>
    </div>

    <p class="muted">Choose either the real PayFast flow or simulate a success locally for development.</p>

    <div class="actions">
      <button id="btn-payfast" class="payfast">💳 Pay with PayFast (Real)</button>
      <button id="btn-ok">✅ Simulate PayFast SUCCESS</button>
      <button id="btn-cancel" class="secondary">❌ Cancel (no notify)</button>
    </div>

    <div id="msg" class="muted"></div>

    <div class="debug">
      <div><b>Local Notify URL (mock):</b> ${notifyUrl}</div>
      <div><b>Real Redirect Builder:</b> /pay/:id</div>
      <div><b>Telegram bot:</b> ${tgUser || '—'}</div>
    </div>
  </div>

  <script>
    const msg = document.getElementById('msg');
    const btnOk = document.getElementById('btn-ok');
    const btnCancel = document.getElementById('btn-cancel');
    const btnPayfast = document.getElementById('btn-payfast');

    const m_payment_id = ${JSON.stringify(m_payment_id || partnerId || '')};
    const notifyUrl    = ${JSON.stringify(notifyUrl)};
    const tgUser       = ${JSON.stringify(tgUser)};
    const email        = ${JSON.stringify(email || '')};

    // 👉 REAL PayFast flow: call /pay/:id which does the redirect server-side
    function buildRealRedirectUrl() {
      if (!m_payment_id) throw new Error('missing ride/payment id');
      return \`${base}/pay/\${encodeURIComponent(m_payment_id)}\`;
    }

    function goBackToTelegram() {
      if (!tgUser) return;
      try { window.location.href = 'tg://resolve?domain=' + tgUser; } catch(e) {}
      setTimeout(() => { try { window.location.href = 'https://t.me/' + tgUser; } catch(e) {} }, 600);
      setTimeout(() => { try { window.close(); } catch(e) {} }, 1200);
    }

    btnPayfast.onclick = () => {
      try {
        const url = buildRealRedirectUrl();
        console.log('[PayFast redirect]', url);
        window.location.href = url;
      } catch (e) {
        console.error(e);
        msg.innerHTML = '<span class="err">❌ Failed to build redirect URL</span>';
      }
    };

    btnOk.onclick = async () => {
      btnOk.disabled = true;
      msg.textContent = 'Notifying server…';
      try {
        const body = new URLSearchParams({
          m_payment_id: m_payment_id || '',
          payment_status: 'COMPLETE',
          email_address: email
        });
        const r = await fetch(notifyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        if (!r.ok) throw new Error('Notify failed with status ' + r.status);
        msg.innerHTML = '<span class="ok">✅ Payment complete. You can return to Telegram.</span>';
        setTimeout(goBackToTelegram, 800);
      } catch (e) {
        msg.innerHTML = '<span class="err">❌ ' + (e && e.message ? e.message : 'Failed to notify') + '</span>';
        btnOk.disabled = false;
      }
    };

    btnCancel.onclick = () => {
      msg.textContent = 'Cancelled. This page will close.';
      setTimeout(() => { try { window.close(); } catch(e) {} }, 500);
    };
  </script>
</body>
</html>`);
});

export default router;
