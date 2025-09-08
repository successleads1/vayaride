// src/services/assignment.js
import Driver from '../models/Driver.js';
import Ride from '../models/Ride.js';
import { kmBetween, estimatePrice } from './pricing.js';

/** Ensure driver has a numeric chatId so Telegram can DM them */
function hasNumericChatId(driver) {
  return driver && typeof driver.chatId !== 'undefined' && !Number.isNaN(Number(driver.chatId));
}

/**
 * Choose the nearest driver who is:
 *  - approved
 *  - ONLINE (isAvailable: true)
 *  - has numeric chatId (linked to Telegram)
 *  - has a last known location
 * Optionally filter by vehicleType and/or exclude driver IDs.
 */
export async function assignNearestDriver(
  pickup,
  { vehicleType = null, exclude = [], radiusKm = null } = {}
) {
  const q = {
    status: 'approved',
    isAvailable: true,
    chatId: { $type: 'number' },
    'location.lat': { $exists: true },
    'location.lng': { $exists: true }
  };

  if (vehicleType) q.vehicleType = vehicleType;
  if (exclude?.length) q._id = { $nin: exclude };

  const drivers = await Driver.find(q).lean();
  if (!drivers.length) {
    console.log('❌ No eligible (online + linked) drivers with location');
    return null;
  }

  const enriched = drivers.map((d) => ({
    ...d,
    distance: kmBetween(d.location, pickup)
  }));

  const filtered = radiusKm ? enriched.filter(d => d.distance <= radiusKm) : enriched;
  if (!filtered.length) {
    console.log('❌ No eligible drivers within radius');
    return null;
  }

  filtered.sort((a, b) => a.distance - b.distance);
  const chosen = filtered[0];
  console.log(`✅ Nearest driver: ${chosen.name || chosen.email || chosen._id} (${chosen.distance.toFixed(2)} km away)`);

  return await Driver.findById(chosen._id);
}

/**
 * Update a ride's estimate using dynamic pricing (traffic + pickup + surge).
 * If a driver location is known, include pickup distance cost.
 */
export async function setEstimateOnRide(rideId, driverLocation = null) {
  const ride = await Ride.findById(rideId);
  if (!ride) return null;

  const vehicleType = ride.vehicleType || 'normal';
  const { price } = await estimatePrice({
    pickup: ride.pickup,
    destination: ride.destination,
    vehicleType,
    driverLocation
  });

  ride.estimate = price;
  await ride.save();
  return price;
}

export { hasNumericChatId };
