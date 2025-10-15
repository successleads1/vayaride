// src/routes/partner.js
import express from 'express';
import Ride from '../models/Ride.js';
import { riderBot as RB } from '../bots/riderBot.js';
import { sendWhatsAppMessage } from '../bots/whatsappBot.js';

const router = express.Router();

/* ---------- Simple landing-style page scaffold (same vibe as your landing page) ---------- */
function pageHTML({ title, lead, ref = '', plan = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title} • VayaRide</title>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <style>
    :root{
      --bg:#000; --text:#fff; --muted:#cfcfcf; --border:#222; --accent:#fff;
      --radius:14px;
      --whatsapp:#25D366; --telegram:#0088cc;
    }
    *{box-sizing:border-box}
    html,body{height:100%}
    body{
      margin:0;
      background:var(--bg); color:var(--text);
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
      display:flex; min-height:100vh; align-items:center; justify-content:center;
      -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
      padding:24px;
    }
    .wrap{
      width:100%;
      max-width:960px;
      text-align:center;
    }
    img.logo{
      width:120px;height:120px;border-radius:50%;
      border:3px solid var(--text); object-fit:cover;
      display:block; margin:0 auto 16px;
    }
    h1{
      margin:8px 0 6px; font-weight:800; letter-spacing:.5px;
      font-size:clamp(22px, 3.5vw, 34px);
      line-height:1.15;
    }
    p.lead{
      margin:0 auto 14px; max-width:720px; opacity:.9;
      font-size:clamp(14px, 2.4vw, 18px);
    }
    .card{
      margin:18px auto 10px;
      border:1px solid var(--border);
      border-radius:var(--radius);
      background:#0c0c0c;
      padding:clamp(12px,1.6vw,16px);
      box-shadow:0 0 0 3px rgba(255,255,255,0.04) inset;
    }
    .info{color:var(--muted); font-size:13px; margin-top:8px}
    .links{
      margin-top:18px; display:flex; gap:12px; justify-content:center; flex-wrap:wrap;
    }
    a.btn{
      padding:clamp(12px,1.8vw,14px) clamp(18px,2.4vw,22px);
      border-radius:12px;
      text-decoration:none;
      font-weight:800;
      font-size:clamp(15px,2.4vw,16px);
      line-height:1.1;
      display:inline-block;
      border:1px solid transparent;
      min-width:clamp(140px,20vw,180px);
      box-shadow:0 4px 0 rgba(255,255,255,0.08);
      transition:transform .06s ease, filter .15s ease;
      will-change:transform;
    }
    a.btn:active{ transform:translateY(1px) }
    a.btn:hover{ filter:brightness(0.92) }
    a.btn.whatsapp{ background:var(--whatsapp); color:#000; border-color:var(--whatsapp) }
    a.btn.telegram{ background:var(--telegram); color:#fff; border-color:var(--telegram) }
    a.btn.home{ background:var(--accent); color:#000; border-color:var(--accent) }
    @media (max-width: 480px){
      .links{ flex-direction:column; align-items:stretch; gap:10px }
      a.btn{ width:100% }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <img class="logo" src="https://res.cloudinary.com/darf17drw/image/upload/v1752064092/Untitled_design_2_wilxrl.png" alt="VayaRide" />
    <h1>${title}</h1>
    <p class="lead">${lead}</p>

    <div class="card">
      <div class="links">
        <a class="btn whatsapp" href="https://wa.me/27750348047?text=Hi%20VayaRide%2C%20I%20want%20to%20book%20a%20ride" target="_blank" rel="noopener">📱 Book Now (WhatsApp)</a>
        <a class="btn telegram" href="https://t.me/vayarider_bot" target="_blank" rel="noopener">🚖 Book Now (Telegram)</a>
        <a class="btn home" href="/" rel="noopener">🏠 Home</a>
      </div>
      ${
        ref || plan
          ? `<div class="info">Ref: <code>${String(ref)}</code>${plan ? ` • Plan: <code>${String(plan)}</code>` : ''}</div>`
          : ''
      }
    </div>
  </div>
</body>
</html>`;
}

/* ----------------------------------------------
 * Start page to launch PayFast (and simulate)
 * GET /api/partner/upgrade/payfast
 * ---------------------------------------------- */
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

  const inferred = `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
  const base = (process.env.PUBLIC_URL || inferred).replace(/\/+$/, '');
  const notifyUrl = `${base}/api/payfast/notify`;
  const payfastRedirect = new URL(`${base}/api/payfast/gateway`).toString();

  res.set('Content-Type', 'text/html').send(`<!doctype html>
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
    .grid{display:grid;grid-template-columns:1fr 1fr; gap: 16px}
    @media (max-width: 560px){ .grid{grid-template-columns:1fr} }
  </style>
</head>
<body>
  <div class="card">
    <h1>🚀 Upgrade via PayFast</h1>
    <div class="grid">
      <div class="row"><b>Payment ID:</b> ${m_payment_id || partnerId || '-'}</div>
      <div class="row"><b>Plan:</b> ${plan}</div>
      <div class="row"><b>Amount:</b> R${amount}</div>
      <div class="row"><b>Email:</b> ${email || '-'}</div>
      <div class="row"><b>Company:</b> ${companyName || '-'}</div>
      <div class="row"><b>Contact:</b> ${contactName || '-'}</div>
    </div>

    <p class="muted">Choose either the real PayFast flow or simulate success locally.</p>

    <div class="actions">
      <button id="btn-payfast" class="payfast">💳 Pay with PayFast</button>
   
      <button id="btn-cancel" class="secondary">❌ Cancel</button>
    </div>

    <div id="msg" class="muted"></div>

    <div class="debug">
      <div><b>Notify URL:</b> ${notifyUrl}</div>
      <div><b>Gateway Redirect:</b> ${payfastRedirect}</div>
    </div>
  </div>

  <script>
    // Injected constants (safe JSON)
    const M_PAYMENT_ID = ${JSON.stringify(m_payment_id || partnerId || '')};
    const NOTIFY_URL    = ${JSON.stringify(notifyUrl)};
    const EMAIL         = ${JSON.stringify(email || '')};
    const PARTNER_ID    = ${JSON.stringify(partnerId || '')};
    const PLAN          = ${JSON.stringify(plan || 'basic')};
    const AMOUNT        = ${JSON.stringify(amount || '0.00')};
    const COMPANY       = ${JSON.stringify(companyName || '')};
    const CONTACT       = ${JSON.stringify(contactName || '')};
    const PAYFAST_REDIRECT = ${JSON.stringify(payfastRedirect)};

    const msg = document.getElementById('msg');
    const btnOk = document.getElementById('btn-ok');
    const btnCancel = document.getElementById('btn-cancel');
    const btnPayfast = document.getElementById('btn-payfast');

    function buildRealRedirectUrl() {
      const u = new URL(PAYFAST_REDIRECT);
      if (PARTNER_ID)   u.searchParams.set('partnerId', PARTNER_ID);
      if (PLAN)         u.searchParams.set('plan', PLAN);
      if (AMOUNT)       u.searchParams.set('amount', AMOUNT);
      if (EMAIL)        u.searchParams.set('email', EMAIL);
      if (COMPANY)      u.searchParams.set('companyName', COMPANY);
      if (CONTACT)      u.searchParams.set('contactName', CONTACT);
      if (M_PAYMENT_ID) u.searchParams.set('m_payment_id', M_PAYMENT_ID);
      return u.toString();
    }

    btnPayfast.onclick = () => {
      window.location.href = buildRealRedirectUrl();
    };

    // Simulate success (your /api/payfast/notify should accept this in dev)
    btnOk.onclick = async () => {
      btnOk.disabled = true;
      msg.textContent = 'Notifying server…';
      try {
        const body = new URLSearchParams({
          m_payment_id: M_PAYMENT_ID,
          payment_status: 'COMPLETE',
          email_address: EMAIL,
          // Optional toggles your notify route might check:
          _simulate: '1'
        });
        const r = await fetch(NOTIFY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        if (!r.ok) throw new Error('Notify failed (' + r.status + ')');
        msg.innerHTML = '<span class="ok">✅ Payment complete.</span>';
      } catch (e) {
        msg.innerHTML = '<span class="err">❌ Failed: ' + e.message + '</span>';
        btnOk.disabled = false;
      }
    };

    // Cancel → our cancel page (then user can jump to WhatsApp/Telegram)
    btnCancel.onclick = () => {
      const u = new URL('/api/partner/upgrade/cancel', window.location.origin);
      if (M_PAYMENT_ID) u.searchParams.set('payment', M_PAYMENT_ID);
      if (PLAN) u.searchParams.set('plan', PLAN);
      window.location.href = u.toString();
    };
  </script>
</body>
</html>`);
});

/* ----------------------------------------------
 * SUCCESS — landing-style buttons back to apps
 * GET /api/partner/upgrade/success?payment=&plan=
 * ---------------------------------------------- */
router.get('/upgrade/success', (req, res) => {
  const { payment = '', plan = '' } = req.query;
  res.status(200).send(
    pageHTML({
      title: '✅ Payment successful',
      lead: 'Thank you! Your payment was completed. Use WhatsApp or Telegram to continue your booking.',
      ref: payment,
      plan
    })
  );
});

/* ----------------------------------------------
 * CANCEL — landing-style buttons + best-effort rollback
 * GET /api/partner/upgrade/cancel?payment=&plan=
 * ---------------------------------------------- */
router.get('/upgrade/cancel', async (req, res) => {
  const { payment = '', plan = '' } = req.query;

  console.log(`❌ Rider cancelled PayFast: payment=${payment} plan=${plan}`);

  // Best-effort: roll back ride state + notify rider
  try {
    const rideId = String(payment || '').trim();
    if (rideId) {
      const ride = await Ride.findById(rideId);
      if (ride) {
        const prev = { status: ride.status, paymentStatus: ride.paymentStatus };
        if (ride.status === 'payment_pending') ride.status = 'pending';
        // normalize to your schema enum: unpaid/pending/paid
        ride.paymentStatus = 'unpaid';
        ride.updatedAt = new Date();
        await ride.save();

        const msg = '❌ Payment was cancelled. You can try again anytime.';
        try { if (ride.riderChatId && RB?.sendMessage) await RB.sendMessage(ride.riderChatId, msg); } catch {}
        try { if (ride.riderWaJid) await sendWhatsAppMessage(ride.riderWaJid, msg); } catch {}

        console.log(`ℹ️ Ride ${rideId}: rolled back payment (${prev.status}/${prev.paymentStatus} → ${ride.status}/${ride.paymentStatus}); rider notified.`);
      }
    }
  } catch (e) {
    console.warn('Cancel handler post-actions failed:', e?.message || e);
  }

  res.status(200).send(
    pageHTML({
      title: '❌ Payment cancelled',
      lead: 'No charge was made. Use WhatsApp or Telegram to go back and book again.',
      ref: payment,
      plan
    })
  );
});

export default router;
