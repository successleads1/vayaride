// src/models/Rider.js
import mongoose from 'mongoose';

const RiderSchema = new mongoose.Schema({
  // Telegram rider (legacy)
  chatId: { type: Number, index: true },

  // WhatsApp rider
  waJid: { type: String, index: true }, // e.g. "2779xxxxxxx@s.whatsapp.net"

  // Profile
  name: String,
  email: String,

  // ✅ Phone fields (persist numbers properly)
  phone: { type: String, index: true },  // normalized E.164, e.g. +27821234567
  msisdn: { type: String, index: true }, // alias/dup (handy for backfills)

  // Credits & dashboard
  credit: Number,
  dashboardToken: String,
  dashboardPin: String,
  dashboardTokenExpiry: Date,

  // Stats / misc
  trips: { type: Number, default: 0 },
  platform: { type: String, enum: ['telegram', 'whatsapp', null], default: null },

  lastLocation: {
    lat: Number,
    lng: Number,
    ts: { type: Date }
  },
  lastSeenAt: Date
});

const Rider = mongoose.model('Rider', RiderSchema);
export default Rider;
