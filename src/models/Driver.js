// src/models/Driver.js
import mongoose from 'mongoose';
import Ride from './Ride.js'; // needed for stats aggregation / lastTrip

/* ---------------- stats subdocs ---------------- */
const DriverStatsLastTripSchema = new mongoose.Schema({
  rideId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Ride' },
  startedAt:      Date,
  pickedAt:       Date,
  finishedAt:     Date,
  durationSec:    { type: Number, default: 0 },
  distanceMeters: { type: Number, default: 0 },
  amount:         { type: Number, default: 0 },
  currency:       { type: String, default: 'ZAR' },
  method:         { type: String, enum: ['cash', 'payfast', 'app', null], default: null },
  pickup:         { lat: Number, lng: Number },
  drop:           { lat: Number, lng: Number }
}, { _id: false });

const DriverStatsSchema = new mongoose.Schema({
  totalTrips:      { type: Number, default: 0 },   // completed
  totalDistanceM:  { type: Number, default: 0 },   // meters
  totalEarnings:   { type: Number, default: 0 },   // ZAR
  cashCount:       { type: Number, default: 0 },
  payfastCount:    { type: Number, default: 0 },   // counts 'payfast' or 'app'
  currency:        { type: String, default: 'ZAR' },
  lastTrip:        { type: DriverStatsLastTripSchema, default: () => ({}) },
  // ⭐ NEW rating aggregates
  avgRating:       { type: Number, default: 0 },
  ratingsCount:    { type: Number, default: 0 }
}, { _id: false });

/* ---------------- main driver schema ---------------- */
const DriverSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, index: true, unique: true, sparse: true },
  passwordHash: { type: String },

  vehicleType: { type: String, enum: ['normal', 'comfort', 'luxury', 'xl'], default: 'normal' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },

  chatId: Number,
  location: { lat: Number, lng: Number },
  isAvailable: { type: Boolean, default: false },
  lastSeenAt: { type: Date },

  pricing: {
    baseFare:   { type: Number, default: 0 },
    perKm:      { type: Number },
    minCharge:  { type: Number },
    withinKm:   { type: Number }
  },

  botPin: { type: String },
  approvedAt: { type: Date },

  documents: {
    driverProfilePhoto: String,
    vehiclePhoto: String,
    idDocument: String,
    vehicleRegistration: String,
    driversLicense: String,
    insuranceCertificate: String,
    pdpOrPsv: String,
    dekraCertificate: String,
    policeClearance: String,
    licenseDisc: String
  },

  stats: { type: DriverStatsSchema, default: () => ({}) }
}, { timestamps: true });

/* ---------------- static: recompute stats from rides (with ratings) ---------------- */
DriverSchema.statics.computeAndUpdateStats = async function (driverId) {
  const driverIdObj = typeof driverId === 'string' ? new mongoose.Types.ObjectId(driverId) : driverId;

  // Aggregate totals & ratings from completed rides
  const [agg] = await Ride.aggregate([
    { $match: { driverId: driverIdObj, status: 'completed' } },
    {
      $group: {
        _id: null,
        trips: { $sum: 1 },
        // sum of finalDistanceKm (km) → convert to meters later
        distKm: { $sum: { $ifNull: ['$finalDistanceKm', 0] } },
        // sum of finalAmount (ZAR)
        earn:  { $sum: { $ifNull: ['$finalAmount', 0] } },
        cashCount:    { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, 1, 0] } },
        payfastCount: { $sum: { $cond: [{ $in: ['$paymentMethod', ['payfast', 'app']] }, 1, 0] } },
        ratingSum:    { $sum: { $ifNull: ['$driverRating', 0] } }, // rider → driver
        ratingCnt:    { $sum: { $cond: [{ $gt: ['$driverRating', 0] }, 1, 0] } },
        lastTripAt:   { $max: '$completedAt' }
      }
    }
  ]);

  // Find last completed ride details for lastTrip snapshot
  const last = await Ride.findOne({ driverId: driverIdObj, status: 'completed' })
    .sort({ completedAt: -1, updatedAt: -1 })
    .lean();

  const updates = {};
  if (agg) {
    updates['stats.totalTrips']     = agg.trips || 0;
    updates['stats.totalDistanceM'] = Math.round((agg.distKm || 0) * 1000); // km → m
    updates['stats.totalEarnings']  = Math.round(agg.earn || 0);
    updates['stats.cashCount']      = agg.cashCount || 0;
    updates['stats.payfastCount']   = agg.payfastCount || 0;
    updates['stats.avgRating']      = agg.ratingCnt ? +(agg.ratingSum / agg.ratingCnt).toFixed(2) : 0;
    updates['stats.ratingsCount']   = agg.ratingCnt || 0;
  } else {
    updates['stats.totalTrips']     = 0;
    updates['stats.totalDistanceM'] = 0;
    updates['stats.totalEarnings']  = 0;
    updates['stats.cashCount']      = 0;
    updates['stats.payfastCount']   = 0;
    updates['stats.avgRating']      = 0;
    updates['stats.ratingsCount']   = 0;
  }

  // Build lastTrip snapshot
  if (last) {
    const distM = Number.isFinite(last.finalDistanceKm)
      ? Math.round(Number(last.finalDistanceKm) * 1000)
      : 0;

    updates['stats.lastTrip'] = {
      rideId: last._id,
      startedAt: last.createdAt || null,
      pickedAt:  last.pickedAt || null,
      finishedAt: last.completedAt || last.updatedAt || null,
      durationSec: Number.isFinite(last.finalDurationSec) ? Math.round(last.finalDurationSec) : 0,
      distanceMeters: distM,
      amount: (last.finalAmount != null ? Number(last.finalAmount) : Number(last.estimate || 0)) || 0,
      currency: 'ZAR',
      method: (['cash', 'payfast', 'app'].includes(last.paymentMethod) ? last.paymentMethod : null),
      pickup: last.pickup || null,
      drop: last.destination || null
    };
  } else {
    updates['stats.lastTrip'] = {};
  }

  updates['stats.currency'] = 'ZAR';

  await this.updateOne({ _id: driverIdObj }, { $set: updates });
  return updates;
};

export default mongoose.model('Driver', DriverSchema);
