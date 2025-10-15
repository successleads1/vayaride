// src/routes/adminRiderComms.js
import express from 'express';
import Rider from '../models/Rider.js';
import { sendWhatsAppTo } from '../bots/whatsappBot.js';

// Replace with your real admin middleware if you have one
const ensureAdmin = (req, _res, next) => next();

const router = express.Router();

/* ---------- helpers ---------- */
function buildRiderFilter({ q }) {
  const filter = {};
  if (q && q.trim()) {
    const s = String(q).trim();
    const or = [
      { name:   { $regex: s, $options: 'i' } },
      { email:  { $regex: s, $options: 'i' } },
    ];
    if (/^\d+$/.test(s)) or.push({ chatId: Number(s) });
    if (s.startsWith('+') || /\d/.test(s)) {
      or.push({ phone: { $regex: s.replace(/[^\d+]/g, ''), $options: 'i' } });
      or.push({ msisdn:{ $regex: s.replace(/[^\d+]/g, ''), $options: 'i' } });
    }
    if (/^[A-F0-9]{4,12}$/i.test(s)) or.push({ referralCode: s.toUpperCase() });
    or.push({ _id: s }); // direct id
    filter.$or = or;
  }
  return filter;
}

function baseUrl(req) {
  return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function niceDiscountMessage({ name, pct, link }) {
  const pctTxt = Math.round(Number(pct || 0));
  return (
`Hey ${name || 'there'} 👋

Good news — there’s a *${pctTxt}%* discount on your next VayaRide trip.

Open your dashboard to view and apply it:
${link}

Need a hand? Just reply here.`
  );
}

async function getTargetsByMode({ mode, q, page, limit, selectedIds }) {
  if (mode === 'selected') {
    const ids = String(selectedIds || '')
      .split(',').map(x => x.trim()).filter(Boolean);
    if (!ids.length) return [];
    return Rider.find({ _id: { $in: ids } })
      .select({ _id:1, name:1, phone:1, msisdn:1, waJid:1, referralCode:1 })
      .lean();
  }

  const filter = buildRiderFilter({ q });
  const sort = { createdAt: -1 };
  const pageNum = Math.max(1, parseInt(String(page || '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(limit || '20'), 10) || 20));
  return Rider.find(filter).sort(sort).skip((pageNum-1)*pageSize).limit(pageSize)
    .select({ _id:1, name:1, phone:1, msisdn:1, waJid:1, referralCode:1 })
    .lean();
}

/* ---------- POST /admin/riders/wa (bulk) ---------- */
router.post('/admin/riders/wa', ensureAdmin, async (req, res) => {
  try {
    const { mode='selected', message, selectedIds, q, page, limit } = req.body || {};
    const discountPct = Number(req.body?.discountPct || 0);
    const discountExpireDays = Number(req.body?.discountExpireDays || 0);

    const riders = await getTargetsByMode({ mode, q, page, limit, selectedIds });
    if (!riders.length) return res.json({ ok:false, error:'No riders to message' });

    const sentTo = [];
    const failed = [];

    for (const r of riders) {
      try {
        // discount (optional)
        if (discountPct > 0) {
          const set = { nextDiscountPct: Math.min(0.9, Math.max(0.01, discountPct/100)) };
          if (Number.isFinite(discountExpireDays) && discountExpireDays > 0) {
            set.nextDiscountExpiresAt = new Date(Date.now() + discountExpireDays*24*3600*1000);
          }
          await Rider.updateOne({ _id: r._id }, { $set: set });
        }

        const base = baseUrl(req);
        const link = `${base}/rider-dashboard.html`;
        const text = (message && String(message).trim().length)
          ? String(message)
          : (discountPct > 0
              ? niceDiscountMessage({ name: r.name, pct: discountPct, link })
              : `Hi ${r.name || 'there'} 👋\n\nOpen your VayaRide dashboard:\n${link}`);

        const target = r.waJid || r.phone || r.msisdn;
        if (!target) { failed.push(String(r._id)); continue; }

        await sendWhatsAppTo(target, text);
        sentTo.push(String(r._id));
      } catch {
        failed.push(String(r._id));
      }
    }

    return res.json({ ok:true, sent: sentTo.length, failed: failed.length });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'Server error' });
  }
});

/* ---------- POST /admin/riders/wa/single ---------- */
router.post('/admin/riders/wa/single', ensureAdmin, async (req, res) => {
  try {
    const { riderId, message } = req.body || {};
    const discountPct = Number(req.body?.discountPct || 0);
    const discountExpireDays = Number(req.body?.discountExpireDays || 0);

    const rider = await Rider.findById(riderId).lean();
    if (!rider) return res.status(404).json({ ok:false, error:'Rider not found' });

    if (discountPct > 0) {
      const set = { nextDiscountPct: Math.min(0.9, Math.max(0.01, discountPct/100)) };
      if (Number.isFinite(discountExpireDays) && discountExpireDays > 0) {
        set.nextDiscountExpiresAt = new Date(Date.now() + discountExpireDays*24*3600*1000);
      }
      await Rider.updateOne({ _id: rider._id }, { $set: set });
    }

    const target = rider.waJid || rider.phone || rider.msisdn;
    if (!target) return res.json({ ok:false, error:'No WhatsApp target for rider' });

    const base = baseUrl(req);
    const text = (message && String(message).trim().length)
      ? String(message)
      : (discountPct > 0
          ? niceDiscountMessage({ name: rider.name, pct: discountPct, link: `${base}/rider-dashboard.html` })
          : `Hi ${rider.name || 'there'} 👋\n\nOpen your VayaRide dashboard:\n${base}/rider-dashboard.html`);

    await sendWhatsAppTo(target, text);
    return res.json({ ok:true, sent: 1 });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'Server error' });
  }
});

export default router;
