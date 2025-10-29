// src/models/Driver.js
import mongoose from "mongoose";
import Ride from "./Ride.js";

/* ---------------- stats subdocs ---------------- */
const DriverStatsLastTripSchema = new mongoose.Schema(
  {
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: "Ride" },
    startedAt: Date,
    pickedAt: Date,
    finishedAt: Date,
    durationSec: { type: Number, default: 0 },
    distanceMeters: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    currency: { type: String, default: "ZAR" },
    method: { type: String, enum: ["cash", "payfast", "app", null], default: null },
    pickup: { lat: Number, lng: Number },
    drop: { lat: Number, lng: Number },
  },
  { _id: false }
);

const DriverStatsSchema = new mongoose.Schema(
  {
    totalTrips: { type: Number, default: 0 },
    totalDistanceM: { type: Number, default: 0 },
    totalEarnings: { type: Number, default: 0 },
    cashCount: { type: Number, default: 0 },
    payfastCount: { type: Number, default: 0 },
    currency: { type: String, default: "ZAR" },
    lastTrip: { type: DriverStatsLastTripSchema, default: () => ({}) },
    avgRating: { type: Number, default: 0 },
    ratingsCount: { type: Number, default: 0 },
  },
  { _id: false }
);

/* ---------------- banking subdoc ---------------- */
const BankingSchema = new mongoose.Schema(
  {
    accountHolder: { type: String, trim: true },
    bankName: { type: String, trim: true },
    accountType: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    branchCode: { type: String, trim: true },
    swift: { type: String, trim: true },
    updatedAt: { type: Date },
  },
  { _id: false }
);

/* ---------------- main driver schema ---------------- */
const DriverSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },

    email: { type: String, index: true, unique: true, sparse: true },
    passwordHash: { type: String },

    phone: { type: String, index: true, unique: true, sparse: true },

    vehicleType: {
      type: String,
      enum: ["normal", "comfort", "luxury", "xl"],
      default: "normal",
    },

    vehicleMake: { type: String },
    vehicleModel: { type: String },
    vehicleColor: { type: String },
    vehicleName: { type: String },
    vehiclePlate: { type: String, index: true, sparse: true },

    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },

    chatId: Number,
    location: { lat: Number, lng: Number },
    isAvailable: { type: Boolean, default: false },
    lastSeenAt: { type: Date },

    pricing: {
      baseFare: { type: Number, default: 0 },
      perKm: { type: Number },
      minCharge: { type: Number },
      withinKm: { type: Number },
    },

    botPin: { type: String },
    approvedAt: { type: Date },

    documents: {
      driverProfilePhoto: String,
      vehiclePhoto: String,
      idDocument: String,
      vehicleRegistration: String,
      driversLicense: String,
      insuranceCertificate: String, // backward-compat
      pdpOrPsv: String,
      dekraCertificate: String, // backward-compat
      policeClearance: String,
      licenseDisc: String,
    },

    /* ---------- Banking ---------- */
    banking: { type: BankingSchema, default: () => ({}) },

    /* ---------- Referrals ---------- */
    referralCode: { type: String, index: true, unique: true, sparse: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: "Driver", index: true },
    referralStats: {
      clicks: { type: Number, default: 0 },
      registrations: { type: Number, default: 0 },
      lastSharedAt: { type: Date },
    },

    /* ---------- Trip limit controls ---------- */
    cashTripLimit: { type: Number, default: 3 },
    payfastTripLimit: { type: Number, default: 3 },
    cashTripOffset: { type: Number, default: 0 },
    payfastTripOffset: { type: Number, default: 0 },
    tripOverride: { type: Boolean, default: false },
    tripOverrideExpiresAt: { type: Date, default: null },

    /* ---------- Password reset (NEW) ---------- */
    resetPasswordTokenHash: { type: String, index: true, sparse: true },
    resetPasswordExpiresAt: { type: Date },

    stats: { type: DriverStatsSchema, default: () => ({}) },
  },
  { timestamps: true }
);

/* ---------------- static: recompute stats (with ratings) ---------------- */
DriverSchema.statics.computeAndUpdateStats = async function (driverId) {
  const driverIdObj =
    typeof driverId === "string" ? new mongoose.Types.ObjectId(driverId) : driverId;

  const [agg] = await Ride.aggregate([
    { $match: { driverId: driverIdObj, status: "completed" } },
    {
      $group: {
        _id: null,
        trips: { $sum: 1 },
        distKm: { $sum: { $ifNull: ["$finalDistanceKm", 0] } },
        earn: { $sum: { $ifNull: ["$finalAmount", 0] } },
        cashCount: { $sum: { $cond: [{ $eq: ["$paymentMethod", "cash"] }, 1, 0] } },
        payfastCount: {
          $sum: { $cond: [{ $in: ["$paymentMethod", ["payfast", "app"]] }, 1, 0] },
        },
        ratingSum: { $sum: { $ifNull: ["$driverRating", 0] } },
        ratingCnt: { $sum: { $cond: [{ $gt: ["$driverRating", 0] }, 1, 0] } },
        lastTripAt: { $max: "$completedAt" },
      },
    },
  ]);

  const last = await Ride.findOne({ driverId: driverIdObj, status: "completed" })
    .sort({ completedAt: -1, updatedAt: -1 })
    .lean();

  const updates = {};
  if (agg) {
    updates["stats.totalTrips"] = agg.trips || 0;
    updates["stats.totalDistanceM"] = Math.round((agg.distKm || 0) * 1000);
    updates["stats.totalEarnings"] = Math.round(agg.earn || 0);
    updates["stats.cashCount"] = agg.cashCount || 0;
    updates["stats.payfastCount"] = agg.payfastCount || 0;
    updates["stats.avgRating"] = agg.ratingCnt ? +(agg.ratingSum / agg.ratingCnt).toFixed(2) : 0;
    updates["stats.ratingsCount"] = agg.ratingCnt || 0;
  } else {
    updates["stats.totalTrips"] = 0;
    updates["stats.totalDistanceM"] = 0;
    updates["stats.totalEarnings"] = 0;
    updates["stats.cashCount"] = 0;
    updates["stats.payfastCount"] = 0;
    updates["stats.avgRating"] = 0;
    updates["stats.ratingsCount"] = 0;
  }

  if (last) {
    const distM = Number.isFinite(last.finalDistanceKm)
      ? Math.round(Number(last.finalDistanceKm) * 1000)
      : 0;

    updates["stats.lastTrip"] = {
      rideId: last._id,
      startedAt: last.createdAt || null,
      pickedAt: last.pickedAt || null,
      finishedAt: last.completedAt || last.updatedAt || null,
      durationSec: Number.isFinite(last.finalDurationSec) ? Math.round(last.finalDurationSec) : 0,
      distanceMeters: distM,
      amount:
        (last.finalAmount != null ? Number(last.finalAmount) : Number(last.estimate || 0)) || 0,
      currency: "ZAR",
      method: ["cash", "payfast", "app"].includes(last.paymentMethod)
        ? last.paymentMethod
        : null,
      pickup: last.pickup || null,
      drop: last.destination || null,
    };
  } else {
    updates["stats.lastTrip"] = {};
  }

  updates["stats.currency"] = "ZAR";

  await this.updateOne({ _id: driverIdObj }, { $set: updates });
  return updates;
};

/* ---------------- static: ensure referral code ---------------- */
DriverSchema.statics.ensureReferralCode = async function (driverId) {
  const id =
    typeof driverId === "string" ? new mongoose.Types.ObjectId(driverId) : driverId;
  const doc = await this.findById(id).select("_id referralCode name").lean();
  if (!doc) return null;
  if (doc.referralCode) return doc.referralCode;

  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  const tail = String(doc._id).slice(-4).toUpperCase();
  const code = `${rand}${tail}`;

  try {
    await this.updateOne({ _id: doc._id }, { $set: { referralCode: code } });
    return code;
  } catch (e) {
    const alt =
      Math.random().toString(36).slice(2, 8).toUpperCase() +
      Date.now().toString(36).slice(-2).toUpperCase();
    await this.updateOne({ _id: doc._id }, { $set: { referralCode: alt } });
    return alt;
  }
};

/* ---------------- helpers: effective counts & allow/limit checks ---------------- */
function effectiveCountFrom(doc, method) {
  const raw = Number(
    method === "cash" ? doc?.stats?.cashCount || 0 : doc?.stats?.payfastCount || 0
  );
  const off = Number(
    method === "cash" ? doc?.cashTripOffset || 0 : doc?.payfastTripOffset || 0
  );
  return Math.max(0, raw - off);
}

DriverSchema.methods.getEffectiveCashCount = function () {
  return effectiveCountFrom(this, "cash");
};
DriverSchema.methods.getEffectivePayfastCount = function () {
  return effectiveCountFrom(this, "payfast");
};
DriverSchema.methods.isMethodAllowedNow = function (method /* 'cash'|'payfast' */) {
  const now = new Date();
  const overrideActive =
    !!this.tripOverride && (!this.tripOverrideExpiresAt || this.tripOverrideExpiresAt > now);
  if (overrideActive) return true;

  const eff = effectiveCountFrom(this, method);
  const limit = Number(
    method === "cash" ? this.cashTripLimit ?? 3 : this.payfastTripLimit ?? 3
  );
  return eff < limit;
};

export default mongoose.model("Driver", DriverSchema);
