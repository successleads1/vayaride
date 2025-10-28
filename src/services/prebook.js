// src/services/prebook.js
import Ride from '../models/Ride.js';
import Driver from '../models/Driver.js';
import { notifyDriverNewRequest } from '../bots/driverBot.js';

/**
 * Assign a scheduled ride to a specific driver (admin action).
 * - sets scheduledDispatched=true
 * - sets status='pending'
 * - notifies ONLY the chosen driver
 */
export async function dispatchScheduledToDriver({ rideId, driverId }) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw new Error('Ride not found');
  if (ride.status !== 'scheduled') throw new Error('Ride is not scheduled');

  const driver = await Driver.findById(driverId).lean();
  if (!driver) throw new Error('Driver not found');

  // set assignment and flip to 'pending' so driver can accept from the driver bot
  ride.driverId = driver._id;
  ride.scheduledDispatched = true;
  ride.status = 'pending';
  if (!ride.vehicleType && driver.vehicleType) ride.vehicleType = driver.vehicleType;
  await ride.save();

  try {
    if (driver.chatId) {
      await notifyDriverNewRequest({ chatId: Number(driver.chatId), ride });
    }
  } catch (e) {
    console.warn('notifyDriverNewRequest failed (dispatchScheduledToDriver):', e?.message || e);
  }

  return ride;
}

/**
 * Broadcast a scheduled ride to multiple approved drivers (admin action).
 * - clears driverId, marks scheduledDispatched=true, status='pending'
 * - you should have a “startup mode” fan-out in driverBot notify function
 */
export async function broadcastScheduledRide({ rideId, drivers }) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw new Error('Ride not found');
  if (ride.status !== 'scheduled') throw new Error('Ride is not scheduled');

  ride.driverId = undefined;
  ride.scheduledDispatched = true;
  ride.status = 'pending';
  await ride.save();

  for (const d of drivers) {
    try {
      if (d.chatId) await notifyDriverNewRequest({ chatId: Number(d.chatId), ride });
    } catch (e) {
      console.warn('fanout notify failed:', e?.message || e);
    }
  }
  return ride;
}
