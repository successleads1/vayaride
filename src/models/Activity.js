// src/models/Activity.js
import mongoose from 'mongoose';

const ActivitySchema = new mongoose.Schema({
  rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', index: true },
  type: {
    type: String,
    enum: [
      'request',      // rider requested (cash / pay)
      'assigned',     // system assigned a driver
      'accepted',     // driver accepted
      'ignored',      // driver ignored
      'cancelled',    // driver cancelled (with reason)
      'arrived',      // driver arrived
      'started',      // trip started
      'completed',    // trip completed
      'picked',       // trip picked up (new status)
      'finished',     // trip finished (new status)
      'payment',      // payment updates
      'system'        // any misc/system notice
    ],
    required: true
  },
  actorType: { type: String, enum: ['driver', 'rider', 'system'], default: 'system' },
  actorId: { type: String }, // driver chatId, rider chatId, or null
  message: { type: String },
  meta: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

export default mongoose.model('Activity', ActivitySchema);
