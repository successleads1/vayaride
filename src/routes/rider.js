// src/routes/rider.js
import express from 'express';
import Rider from '../models/Rider.js';

const router = express.Router();

// ✅ Get profile
router.get('/:chatId', async (req, res) => {
  try {
    const rider = await Rider.findOne({ chatId: req.params.chatId });
    if (!rider) return res.status(403).json({ error: 'Unauthorized' });

    res.json({
      name: rider.name,
      email: rider.email,
      credit: rider.credit,
      trips: rider.trips
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ Update profile
router.post('/update-profile', async (req, res) => {
  const { chatId, name, email, credit } = req.body;

  try {
    const rider = await Rider.findOne({ chatId });
    if (!rider) return res.status(403).json({ error: 'Unauthorized' });

    rider.name = name;
    rider.email = email;
    rider.credit = credit;
    await rider.save();

    res.json({ message: 'Profile updated' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
