// 🆕 NEW CODE: referral-ready Rider model
import mongoose from 'mongoose';

const ReferralStatsSchema = new mongoose.Schema(
  {
    clicks:        { type: Number, default: 0 },
    registrations: { type: Number, default: 0 },
    lastSharedAt:  { type: Date, default: null },
  },
  { _id: false }
);

const RiderSchema = new mongoose.Schema(
  {
    /* ---------- Identities ---------- */
    chatId: { type: Number, index: true }, // Telegram
    waJid:  { type: String, index: true }, // WhatsApp JID

    /* ---------- Profile ---------- */
    name:  { type: String },
    email: { type: String, index: true, sparse: true },

    /* Phones (E.164) */
    phone: { type: String, index: true, sparse: true },
    msisdn:{ type: String, index: true, sparse: true },

    /* ---------- Dashboard ---------- */
    credit:               { type: Number, default: 0 },
    dashboardToken:       { type: String },
    dashboardPin:         { type: String },
    dashboardTokenExpiry: { type: Date },

    /* ---------- Stats / Misc ---------- */
    trips:    { type: Number, default: 0 },
    platform: { type: String, enum: ['telegram', 'whatsapp', null], default: null },

    lastLocation: { lat: Number, lng: Number, ts: Date },
    lastSeenAt:   { type: Date },

    /* ---------- Referrals ---------- */
    referralCode:  { type: String, index: true, unique: true, sparse: true, uppercase: true, trim: true },
    referredBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'Rider', index: true },
    referralStats: { type: ReferralStatsSchema, default: () => ({}) },

    /* ---------- One-time discount from referrals ---------- */
    nextDiscountPct:        { type: Number, default: 0 },   // e.g. 0.2 = 20%
    nextDiscountExpiresAt:  { type: Date, default: null },
    nextDiscountLockedRide: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', default: null },

    /* (optional) Rider rating (driver→rider) if you use it on dashboard */
    riderStars: {
      avg:   { type: Number, default: 0 },
      count: { type: Number, default: 0 }
    }
  },
  { timestamps: true }
);

/* 🆕 Generate/ensure a rider referral code */
RiderSchema.statics.ensureReferralCode = async function ensureReferralCode(riderId) {
  const Rider = this;

  const id = typeof riderId === 'string' ? new mongoose.Types.ObjectId(riderId) : riderId;
  const existing = await Rider.findById(id).select('_id referralCode').lean();
  if (!existing) return null;
  if (existing.referralCode) return existing.referralCode;

  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1
  const make = () => Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');

  let code = make();
  for (let i = 0; i < 6; i++) {
    const dup = await Rider.findOne({ referralCode: code }).select('_id').lean();
    if (!dup) break;
    code = make();
  }

  await Rider.updateOne({ _id: id }, { $set: { referralCode: code } });
  return code;
};

export default mongoose.model('Rider', RiderSchema);
