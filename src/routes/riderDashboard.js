// src/routes/riderDashboard.js
import express from 'express';
import QR from 'qrcode';
import Rider from '../models/Rider.js';
import Ride from '../models/Ride.js';

const router = express.Router();

// GET /api/rider-by-token/:token?pin=1234
// → verifies token+pin, returns profile & summary used by the dashboard modal unlock
router.get('/rider-by-token/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const pin = String(req.query.pin || '').trim();

    if (!token || !pin) return res.status(400).json({ error: 'Missing token or PIN' });

    const rider = await Rider.findOne({ dashboardToken: token }).lean();
    if (!rider) return res.status(403).json({ error: 'Access denied' });

    if (!rider.dashboardTokenExpiry || new Date(rider.dashboardTokenExpiry) < new Date()) {
      return res.status(403).json({ error: 'Token expired' });
    }
    if (String(rider.dashboardPin) !== pin) {
      return res.status(403).json({ error: 'Invalid PIN' });
    }

    // Basic summary
    const chatId = rider.chatId ?? null;

    // Trips completed
    const trips = await Ride.countDocuments({ riderChatId: chatId, status: 'completed' });

    // Last payment (best-effort from rides)
    const lastPaidRide =
      await Ride.findOne({ riderChatId: chatId, $or: [{ paidAt: { $exists: true } }, { status: 'completed' }] })
        .sort({ paidAt: -1, completedAt: -1, createdAt: -1 })
        .lean();

    const lastPayment = lastPaidRide ? {
      amount: Number(lastPaidRide.totalFare || lastPaidRide.estimate || 0),
      method: lastPaidRide.paymentMethod || null,
      at: lastPaidRide.paidAt || lastPaidRide.completedAt || lastPaidRide.createdAt
    } : null;

    // Rider rating (driver → rider). If you store differently, adapt here.
    const riderStars = {
      avg: Number(rider?.riderStars?.avg || 0),
      count: Number(rider?.riderStars?.count || 0)
    };

    res.json({
      chatId,
      name: rider.name || '',
      email: rider.email || '',
      trips,
      lastPayment,
      riderStars
    });
  } catch (e) {
    console.error('rider-by-token error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/rider/:chatId
// → referral stats + discount banner info for the dashboard
router.get('/rider/:chatId', async (req, res) => {
  try {
    const chatId = req.params.chatId;
    const rider = await Rider.findOne({ chatId }).lean();
    if (!rider) return res.json({ referral: {}, discount: {} });

    const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
    const code = rider.referralCode || ''; // make sure you generate/store this somewhere at registration
    const link = code ? `${PUBLIC_URL}/i/r/${encodeURIComponent(code)}` : null;

    const clicks = rider?.referralStats?.clicks || 0;
    const registrations = rider?.referralStats?.registrations || 0;

    const pct = rider?.nextDiscountPct || 0;
    const expiresAt = rider?.nextDiscountExpiresAt || null;

    res.json({
      referral: { link, clicks, registrations, code },
      discount: { pct, expiresAt }
    });
  } catch (e) {
    console.error('get rider referral error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/update-profile (form-urlencoded: chatId, name, email)
router.post('/update-profile', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { chatId, name, email } = req.body;
    if (!chatId || !name || !email) return res.status(400).send('Bad request');

    await Rider.updateOne(
      { chatId },
      { $set: { name: String(name).trim(), email: String(email).trim() } }
    );

    res.status(200).send('ok');
  } catch (e) {
    console.error('update-profile error', e);
    res.status(500).send('error');
  }
});

// GET /qr.png?u=/i/r/ABC123
// → simple QR proxy for the dashboard "Show QR" button
router.get('/qr.png', async (req, res) => {
  try {
    const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
    const u = String(req.query.u || '/').trim();
    const url = PUBLIC_URL ? `${PUBLIC_URL}${u.startsWith('/') ? '' : '/'}${u}` : u;
    const png = await QR.toBuffer(url, { type: 'png', margin: 1, scale: 6 });
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (e) {
    res.status(400).send('bad qr');
  }
});

export default router;
