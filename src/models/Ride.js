// src/models/Ride.js
import mongoose from 'mongoose';

const PointSchema = new mongoose.Schema(
  {
    lat: Number,
    lng: Number,
    ts: { type: Date, default: Date.now }
  },
  { _id: false }
);

const RideSchema = new mongoose.Schema(
  {
    /* ---------- Rider identities ---------- */
    riderChatId: Number,          // Telegram (legacy)
    riderWaJid: { type: String }, // WhatsApp JID

    /* ---------- Driver ---------- */
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
    driverChatId: { type: Number }, // quick access for bot/sockets

    /* ---------- Route ---------- */
    pickup: { lat: Number, lng: Number },
    destination: { lat: Number, lng: Number },

    /* ---------- Quoting / vehicle ---------- */
    estimate: Number,
    vehicleType: { type: String },

    /* ✅ Promo (optional; for referral discounts, etc.) */
    promoDiscountPct:   { type: Number, default: 0 },      // e.g. 0.2 for 20%
    promoDiscountReason:{ type: String, default: null },   // e.g. 'referral'

    /* ---------- Payment ---------- */
    paymentMethod: { type: String, enum: ['cash', 'payfast', 'app', 'paypal'], default: 'cash' },

    /* ---------- Payment tracking ---------- */
    paymentStatus: { type: String, enum: ['unpaid', 'paid'], default: 'unpaid' },
    paidAt: { type: Date },

    /* ---------- Lifecycle ---------- */
    status: {
      type: String,
      enum: ['pending', 'accepted', 'enroute', 'completed', 'cancelled', 'payment_pending'],
      default: 'pending'
    },

    /* ---------- Cancel details (compat names) ---------- */
    cancelReason: { type: String },       // legacy name
    cancellationReason: { type: String }, // new, matches server code
    cancellationNote: { type: String },
    cancelledAt: { type: Date },
    cancelledBy: { type: String, enum: ['driver', 'rider', 'system'], default: undefined },

    /* NEW: capture where & how far when cancelled */
    cancelDriverLoc: { lat: Number, lng: Number }, // last driver coords when cancelled
    cancelDistanceKm: { type: Number },            // ~km from pickup to cancel point

    /* ---------- Time markers ---------- */
    startedAt: { type: Date },
    pickedAt: { type: Date },
    completedAt: { type: Date },

    /* ---------- Final fare snapshot (set on finish) ---------- */
    finalAmount: { type: Number },        // R amount actually charged
    finalDistanceKm: { type: Number },    // computed trip km
    finalDurationSec: { type: Number },   // actual duration sec
    finalTrafficFactor: { type: Number }, // ratio actual/expected
    finalSurge: { type: Number },         // surge used at finish

    /* ---------- Breadcrumbs ---------- */
    path: [PointSchema],        // driver breadcrumb (we append final/cancel stamp here)
    viewerPath: [PointSchema],  // optional breadcrumb from viewers

    /* ---------- Source platform (for notifications) ---------- */
    platform: { type: String, enum: ['telegram', 'whatsapp', null], default: null },

    /* ---------- RATINGS ---------- */
    // rider → driver
    driverRating: { type: Number, min: 1, max: 5, default: null },
    driverRatedAt: { type: Date, default: null },
    // driver → rider
    riderRating: { type: Number, min: 1, max: 5, default: null },
    riderRatedAt: { type: Date, default: null },

    /* ⭐ Arrival dedupe (durable, survives restarts) */
    arrivedNotified: { type: Boolean, default: false }, // one-shot flag
    arrivedAt: { type: Date, default: null },           // when first marked arrived
    _lastArriveEmitAt: { type: Date, default: null }    // small cooldown to avoid bursts
  },
  { timestamps: true }
);

const Ride = mongoose.model('Ride', RideSchema);
export default Ride;
