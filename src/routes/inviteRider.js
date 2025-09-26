// 🆕 NEW FILE: src/routes/inviteRider.js
import express from 'express';
import Rider from '../models/Rider.js';

const router = express.Router();

function baseUrl(req) {
  return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

router.get('/invite/r/:code', async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const TG_USER = process.env.TELEGRAM_RIDER_BOT_USERNAME || '';
  const WA_NUM  = (process.env.WHATSAPP_ENTRY_NUMBER || '').replace(/^\+/, '');

  // bump clicks (ignore errors)
  try { await Rider.updateOne({ referralCode: code }, { $inc: { 'referralStats.clicks': 1 } }); } catch {}

  const tgDeep = TG_USER ? `https://t.me/${TG_USER}?start=ref_${encodeURIComponent(code)}` : '#';
  const waMsg  = encodeURIComponent(`Hi VayaRide, I want to register. Referral ${code}`);
  const waLink = WA_NUM ? `https://wa.me/${WA_NUM}?text=${waMsg}` : '#';

  const contWeb = `${baseUrl(req)}/register?ref=${encodeURIComponent(code)}`;

  res.type('html').send(`
    <!doctype html>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Invite — VayaRide</title>
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;background:#0b0b0b;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}
      .card{background:#161616;border:1px solid #2a2a2a;border-radius:12px;max-width:520px;width:92%;padding:22px;box-shadow:0 10px 30px rgba(0,0,0,.45)}
      h1{margin:0 0 8px;font-size:22px}
      p{opacity:.85}
      a.btn{display:block;text-decoration:none;background:#fff;color:#000;padding:12px 14px;border-radius:10px;text-align:center;font-weight:700;margin:8px 0}
      a.alt{display:block;text-decoration:none;color:#bbb;text-align:center;margin-top:12px}
      .muted{color:#aaa;font-size:14px;margin-top:10px}
    </style>
    <div class="card">
      <h1>🎁 Join VayaRide</h1>
      <p>Use any option below. Your friend's referral code <b>${code}</b> will be applied when you register.</p>

      <a class="btn" href="${waLink}">💬 Open in WhatsApp</a>
      <a class="btn" href="${tgDeep}">📲 Open in Telegram</a>
      <a class="btn" href="${contWeb}">🧭 Continue on Web</a>

      <div class="muted">After you finish registration, your friend gets 20% off their next trip.</div>
    </div>
  `);
});

// (optional) If you have a web registration form, you can read ?ref=CODE here
router.get('/register', async (req, res) => {
  const ref = String(req.query.ref || '').trim().toUpperCase();
  res.type('html').send(`
    <!doctype html>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Register — VayaRide</title>
    <style>
      body{font-family:system-ui;background:#0b0b0b;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}
      .card{background:#161616;border:1px solid #2a2a2a;border-radius:12px;max-width:520px;width:92%;padding:22px}
      a.btn{display:block;text-decoration:none;background:#fff;color:#000;padding:12px 14px;border-radius:10px;text-align:center;font-weight:700;margin:8px 0}
      .muted{color:#aaa}
    </style>
    <div class="card">
      <h2>Register</h2>
      ${ref ? `<p class="muted">Referral code detected: <b>${ref}</b> — it will be applied when you complete registration in the bot.</p>` : ''}
      <p>Finish registration in one of the bots:</p>
      <a class="btn" href="/invite/r/${encodeURIComponent(ref || '')}">Open Invite Options</a>
      <a class="btn" href="https://t.me/${process.env.TELEGRAM_RIDER_BOT_USERNAME || '#'}">Open Telegram</a>
      ${process.env.WHATSAPP_ENTRY_NUMBER ? `<a class="btn" href="${`https://wa.me/${(process.env.WHATSAPP_ENTRY_NUMBER || '').replace(/^\+/, '')}?text=${encodeURIComponent('Hi VayaRide, I want to register.' + (ref ? ' Referral ' + ref : ''))}`}">Open WhatsApp</a>` : ''}
    </div>
  `);
});

export default router;
