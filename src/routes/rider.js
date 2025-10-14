// src/routes/rider.js
import express from 'express';
import Rider from '../models/Rider.js';

const router = express.Router();

function baseUrl(req) {
  return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

/* ✅ GET profile (+referral link + discount info) */
router.get('/:chatId', async (req, res) => {
  try {
    const rider = await Rider.findOne({ chatId: req.params.chatId });
    if (!rider) return res.status(403).json({ error: 'Unauthorized' });

    // Ensure referral code exists
    let code = rider.referralCode;
    if (!code) {
      code = await Rider.ensureReferralCode(rider._id);
      try { await Rider.updateOne({ _id: rider._id }, { $set: { referralCode: code } }); } catch {}
    }

    const publicUrl = baseUrl(req);
    const shareLink = `${publicUrl}/i/r/${encodeURIComponent(code)}`;

    const discountActive =
      (rider.nextDiscountPct || 0) > 0 &&
      (!rider.nextDiscountExpiresAt || new Date() < new Date(rider.nextDiscountExpiresAt));

    res.json({
      name: rider.name || '',
      email: rider.email || '',
      phone: rider.phone || rider.msisdn || '',
      credit: rider.credit ?? 0,
      trips: rider.trips ?? 0,
      referral: {
        code,
        link: shareLink,
        clicks: rider?.referralStats?.clicks || 0,
        registrations: rider?.referralStats?.registrations || 0,
        lastSharedAt: rider?.referralStats?.lastSharedAt || null
      },
      discount: discountActive
        ? {
            pct: rider.nextDiscountPct,
            expiresAt: rider.nextDiscountExpiresAt || null,
            lockedRide: rider.nextDiscountLockedRide || null
          }
        : { pct: 0 }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/* ✅ POST update profile  */
router.post('/update-profile', async (req, res) => {
  const { chatId, name, email, credit } = req.body;
  try {
    const rider = await Rider.findOne({ chatId });
    if (!rider) return res.status(403).json({ error: 'Unauthorized' });

    if (typeof name === 'string')  rider.name = name;
    if (typeof email === 'string') rider.email = email;
    if (typeof credit !== 'undefined' && credit !== null && !Number.isNaN(Number(credit))) {
      rider.credit = Number(credit);
    }
    await rider.save();

    res.json({ message: 'Profile updated' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
