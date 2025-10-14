// src/routes/admin-wa.js
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

/* ---- Rider WhatsApp bot helpers ---- */
import {
  waitForQrDataUrl,
  isWhatsAppConnected,
  getConnectionStatus,
  sendWhatsAppMessage,
  resetWhatsAppSession,
} from '../bots/whatsappBot.js';

/* ---- Models ---- */
import Rider from '../models/Rider.js';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ---------------- Small helpers ---------------- */
function jidToPhone(jid) {
  if (!jid) return null;
  const core = String(jid).split('@')[0] || '';
  const digits = core.replace(/[^\d+]/g, '');
  if (!digits) return null;
  return digits.startsWith('+') ? digits : `+${digits}`;
}
function normalizePhone(x) {
  if (!x) return null;
  const d = String(x).replace(/[^\d+]/g, '');
  if (!d) return null;
  return d.startsWith('+') ? d : `+${d}`;
}
function pickPhoneLike(obj = {}) {
  return (
    obj.phone ||
    obj.phoneNumber ||
    obj.mobile ||
    obj.msisdn ||
    (obj.waJid ? jidToPhone(obj.waJid) : null) ||
    null
  );
}

/* =========================================================
   Rider WA: QR & status
   ======================================================= */

/** GET /qrcode — show WA QR for the rider bot */
router.get('/qrcode', async (req, res) => {
  if (isWhatsAppConnected()) {
    return res.send('<h2>✅ WhatsApp is connected.</h2>');
  }
  try {
    const dataUrl = await waitForQrDataUrl(25000); // 25s wait
    return res.send(`
      <div style="font-family:system-ui;display:grid;place-items:center;gap:12px">
        <h3>Scan to connect WhatsApp</h3>
        <img src="${dataUrl}" style="width:320px;height:320px;image-rendering:pixelated;border:8px solid #eee;border-radius:12px" />
        <p>If it stalls, refresh or try <code>/wa/reset</code>.</p>
      </div>
    `);
  } catch {
    // show fallback image if exists
    const pngPath = path.join(__dirname, '../../public/wa-qr.png');
    const fallback = fs.existsSync(pngPath)
      ? `<img src="/wa-qr.png" style="width:320px;height:320px;image-rendering:pixelated;border:8px solid #eee;border-radius:12px" />`
      : '<em>No QR yet. Try again shortly.</em>';
    return res.send(`
      <div style="font-family:system-ui;display:grid;place-items:center;gap:12px">
        <h3>QR not ready</h3>${fallback}
        <p>Or call <a href="/wa/reset">/wa/reset</a> then refresh.</p>
      </div>
    `);
  }
});

/** GET /api/whatsapp/status — simple status JSON */
router.get('/api/whatsapp/status', (req, res) => {
  const status = getConnectionStatus();
  res.json({ status, connected: isWhatsAppConnected() });
});

/** POST /wa/reset — reset rider WA session */
router.post('/wa/reset', async (req, res) => {
  try {
    await resetWhatsAppSession();
    res.json({ ok: true, message: 'WhatsApp session reset. Open /qrcode to scan again.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'reset failed' });
  }
});

/** GET /wa/reset — convenient alias while testing */
router.get('/wa/reset', async (req, res) => {
  try {
    await resetWhatsAppSession();
    res.type('html').send(`
      <div style="font-family:system-ui;padding:20px">
        <h3>Rider WhatsApp session reset.</h3>
        <p><a href="/qrcode">Open /qrcode</a> to scan again.</p>
      </div>
    `);
  } catch (e) {
    res.status(500).type('text').send('reset failed: ' + (e?.message || e));
  }
});

/* =========================================================
   Broadcast to Riders from Admin
   Form/JSON → POST /admin/riders/wa
   Body fields supported:
     - scope: "selected" | "page" | "all"  (we implement "selected" + "page")
     - ids: CSV of rider _id's (for "selected")
     - message: required text
   ======================================================= */

router.post('/admin/riders/wa', async (req, res) => {
  try {
    if (!isWhatsAppConnected()) {
      return res.status(400).json({ ok: false, error: 'WhatsApp not connected' });
    }

    const scope = String(req.body.scope || 'selected').toLowerCase();
    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).json({ ok: false, error: 'message required' });

    let riders = [];

    if (scope === 'selected') {
      // ids can be JSON array or CSV string
      let ids = req.body.ids;
      if (typeof ids === 'string') {
        ids = ids.split(',').map(s => s.trim()).filter(Boolean);
      }
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ ok: false, error: 'riderIds required for scope=selected' });
      }
      riders = await Rider.find({ _id: { $in: ids } }).lean();
    } else if (scope === 'page') {
      // optional: accept a query from the admin page; fallback: last 50 riders
      const limit = Math.min(200, Number(req.body.limit || 50));
      riders = await Rider.find({}).sort({ createdAt: -1 }).limit(limit).lean();
    } else if (scope === 'all') {
      // be careful with rate limits in production; here we just fetch all
      riders = await Rider.find({}).lean();
    } else {
      return res.status(400).json({ ok: false, error: 'invalid scope' });
    }

    if (!riders.length) {
      return res.status(400).json({ ok: false, error: 'no riders to message' });
    }

    // Build recipient list from phone/msisdn/jid fallbacks
    const targets = [];
    for (const r of riders) {
      let phone = pickPhoneLike(r);
      if (!phone && r.waJid) phone = jidToPhone(r.waJid);
      if (!phone && r.phone) phone = normalizePhone(r.phone);
      if (phone) targets.push({ riderId: String(r._id), phone });
    }

    if (!targets.length) {
      return res.status(400).json({ ok: false, error: 'no WhatsApp numbers found for selected riders' });
    }

    // Send sequentially (Baileys is okay with modest concurrency; keep simple)
    let sent = 0;
    for (const t of targets) {
      try {
        await sendWhatsAppMessage(t.phone, message);
        sent++;
      } catch (e) {
        // swallow single failures to let others continue
        // you can log per-number errors if you want:
        // console.warn('WA send failed', t.phone, e?.message || e);
      }
    }

    return res.json({ ok: true, total: targets.length, sent });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'send failed' });
  }
});

export default router;
