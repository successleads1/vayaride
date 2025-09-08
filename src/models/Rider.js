// src/models/Rider.js
import mongoose from 'mongoose';

const RiderSchema = new mongoose.Schema({
  // Telegram rider (legacy)
  chatId: { type: Number, index: true },     // keep as Number for Telegram

  // WhatsApp rider (new, never cast to Number)
  waJid: { type: String, index: true },      // e.g. "2779xxxxxxx@s.whatsapp.net"

  name: String,
  email: String,
  credit: Number,

  dashboardToken: String,
  dashboardPin: String,
  dashboardTokenExpiry: Date,

  trips: { type: Number, default: 0 },

  // optional metadata
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
