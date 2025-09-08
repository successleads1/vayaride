// src/services/pricing.js
import fetch from 'node-fetch';
import Driver from '../models/Driver.js';
import Ride from '../models/Ride.js';

/** Great-circle distance (Haversine) in KM */
export function kmBetween(a, b) {
  if (
    !a || !b ||
    typeof a.lat !== 'number' || typeof a.lng !== 'number' ||
    typeof b.lat !== 'number' || typeof b.lng !== 'number'
  ) return 0;

  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(Math.max(0, s)));
}

/* ---------- Local helpers used by appendPathPoint ---------- */
const lastPathByRide = new Map(); // rideId -> { lat, lng, ts }

/** Haversine in meters (for movement threshold in appendPathPoint) */
function haversineMeters(a, b) {
  if (
    !a || !b ||
    typeof a.lat !== 'number' || typeof a.lng !== 'number' ||
    typeof b.lat !== 'number' || typeof b.lng !== 'number'
  ) return 0;

  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371000; // meters
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(Math.max(0, s)));
}

/* ---------- ENV + Constants (tunable guard-rails) ---------- */
const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const GMAPS_REGION = process.env.GOOGLE_MAPS_REGION || ''; // e.g. 'za'
const GMAPS_COMPONENTS = process.env.GOOGLE_MAPS_COMPONENTS || ''; // e.g. 'country:za|country:na'

const PICKUP_PER_KM_ENV = Number(process.env.PICKUP_PER_KM || 0);

const SURGE_MAX = Number(process.env.SURGE_MAX || 2.0);
const SURGE_MIN = Number(process.env.SURGE_MIN || 1.0);
const SURGE_DEMAND_WINDOW_MIN = Number(process.env.SURGE_DEMAND_WINDOW_MIN || 15);
const SURGE_RADIUS_KM = Number(process.env.SURGE_RADIUS_KM || 8);

const WAIT_PER_MIN = Number(process.env.WAIT_PER_MIN || 0);

/* 🔧 New safety rails */
const MAX_PICKUP_KM_CHARGED = Number(process.env.MAX_PICKUP_KM_CHARGED || 8);   // cap pickup fee distance
const MAX_TRAFFIC_FACTOR    = Number(process.env.MAX_TRAFFIC_FACTOR || 1.7);   // cap traffic multiplier
const MAX_TRIP_KM_ALLOWED   = Number(process.env.MAX_TRIP_KM_ALLOWED || 120);  // distrust insane routes
const MAX_TRIP_KM_CHARGED   = Number(process.env.MAX_TRIP_KM_CHARGED || 200);  // absolute max we’ll bill

const DEBUG_PRICING = String(process.env.DEBUG_PRICING || '').toLowerCase() === 'true';

/* ---------- Default tables ----------
 * No "free km"; minCharge = minimum fare floor.
 */
const DEFAULT_RATE_TABLE = {
  normal:  { baseFare: 0, perKm: 7,  minCharge: 30, withinKm: 0, pickupPerKm: PICKUP_PER_KM_ENV },
  comfort: { baseFare: 0, perKm: 8,  minCharge: 30, withinKm: 0, pickupPerKm: PICKUP_PER_KM_ENV },
  luxury:  { baseFare: 0, perKm: 12, minCharge: 45, withinKm: 0, pickupPerKm: PICKUP_PER_KM_ENV },
  xl:      { baseFare: 0, perKm: 10, minCharge: 39, withinKm: 0, pickupPerKm: PICKUP_PER_KM_ENV }
};

/** Merge driver.pricing with defaults + sanitize */
function resolveRate(vehicleType, driverPricing = {}) {
  const key = (vehicleType || 'normal').toLowerCase();
  const def = DEFAULT_RATE_TABLE[key] || DEFAULT_RATE_TABLE.normal;

  const sanitize = (v, fallback, { min = 0, allowZero = true } = {}) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    if (allowZero ? n < min : n <= min) return fallback;
    return n;
  };

  return {
    baseFare:    sanitize(driverPricing.baseFare,    def.baseFare,    { min: 0, allowZero: true }),
    perKm:       sanitize(driverPricing.perKm,       def.perKm,       { min: 0, allowZero: false }),
    minCharge:   sanitize(driverPricing.minCharge,   def.minCharge,   { min: 0, allowZero: true }),
    withinKm:    sanitize(driverPricing.withinKm,    def.withinKm,    { min: 0, allowZero: true }),
    pickupPerKm: sanitize(driverPricing.pickupPerKm, def.pickupPerKm, { min: 0, allowZero: true }),
  };
}

/* ---------- Google Distance Matrix (live traffic) with sanity checks ---------- */
async function roadMetrics(pickup, destination) {
  // fast haversine fallback / baseline
  const havKm = kmBetween(pickup, destination);

  // No key? Use haversine + avg speed
  if (!GMAPS_KEY) {
    return {
      km: clampTripKm(havKm),
      durationSec: Math.round((havKm / 35) * 3600), // ~35 km/h
      trafficFactor: 1
    };
  }

  const u = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
  u.searchParams.set('origins', `${pickup.lat},${pickup.lng}`);
  u.searchParams.set('destinations', `${destination.lat},${destination.lng}`);
  u.searchParams.set('key', GMAPS_KEY);
  u.searchParams.set('departure_time', 'now');
  u.searchParams.set('traffic_model', 'best_guess');
  u.searchParams.set('mode', 'driving');
  if (GMAPS_REGION) u.searchParams.set('region', GMAPS_REGION);
  if (GMAPS_COMPONENTS) u.searchParams.set('components', GMAPS_COMPONENTS);

  try {
    const r = await fetch(u.toString());
    const j = await r.json();

    const elem = j?.rows?.[0]?.elements?.[0];
    if (!elem || elem.status !== 'OK') {
      // fallback
      const km = clampTripKm(havKm);
      return { km, durationSec: Math.round((km / 35) * 3600), trafficFactor: 1 };
    }

    const distMeters = elem.distance?.value ?? 0;
    const durSec = elem.duration?.value ?? 0;
    const durTrafficSec = Math.max(1, (elem.duration_in_traffic?.value ?? durSec));
    let km = distMeters / 1000;

    // sanity checks: distrust crazy google routes
    if (!Number.isFinite(km) || km <= 0) km = havKm;
    const ratioToHav = havKm > 0 ? km / havKm : 1;
    if (km > MAX_TRIP_KM_ALLOWED || ratioToHav > 1.8) {
      if (DEBUG_PRICING) {
        console.warn(`[pricing] roadMetrics clamp: gmapsKm=${km.toFixed(2)} hav=${havKm.toFixed(2)} ratio=${ratioToHav.toFixed(2)} -> using haversine`);
      }
      km = havKm;
    }

    km = clampTripKm(km);

    let trafficFactor = Math.max(1, durTrafficSec / Math.max(1, durSec || 1));
    if (!Number.isFinite(trafficFactor) || trafficFactor < 1) trafficFactor = 1;
    trafficFactor = Math.min(MAX_TRAFFIC_FACTOR, Math.max(1, trafficFactor));

    // derive a duration consistent with clamped traffic factor
    const durationSec = Math.max(60, Math.round((km / Math.max(15, km > 30 ? 35 : 25)) * 3600 * trafficFactor));

    return { km, durationSec, trafficFactor };
  } catch (e) {
    const km = clampTripKm(havKm);
    return { km, durationSec: Math.round((km / 35) * 3600), trafficFactor: 1 };
  }
}

function clampTripKm(km) {
  let k = Number(km);
  if (!Number.isFinite(k) || k < 0) k = 0;
  if (MAX_TRIP_KM_CHARGED > 0) k = Math.min(k, MAX_TRIP_KM_CHARGED);
  return k;
}

/* ---------- Surge calculation (demand vs supply) ---------- */
async function surgeNear(pickup) {
  try {
    // supply
    const drivers = await Driver.find({
      status: 'approved',
      isAvailable: true,
      chatId: { $type: 'number' },
      'location.lat': { $exists: true },
      'location.lng': { $exists: true }
    }).select('location').lean();

    const nearbyDrivers = drivers.filter(d => d.location && kmBetween(d.location, pickup) <= SURGE_RADIUS_KM).length;

    // demand
    const since = new Date(Date.now() - SURGE_DEMAND_WINDOW_MIN * 60 * 1000);
    const pending = await Ride.find({
      status: { $in: ['pending', 'payment_pending'] },
      createdAt: { $gte: since },
      'pickup.lat': { $exists: true },
      'pickup.lng': { $exists: true }
    }).select('pickup').lean();

    const nearbyDemand = pending.filter(r => r.pickup && kmBetween(r.pickup, pickup) <= SURGE_RADIUS_KM).length;

    // simple ladder
    let surge = 1.0;
    if (nearbyDrivers <= 0 && nearbyDemand > 0) surge = 1.5;
    else {
      const ratio = nearbyDemand / Math.max(1, nearbyDrivers);
      if (ratio >= 3) surge = 1.8;
      else if (ratio >= 2) surge = 1.5;
      else if (ratio >= 1.2) surge = 1.2;
      else surge = 1.0;
    }

    return Math.min(SURGE_MAX, Math.max(SURGE_MIN, surge));
  } catch {
    return 1.0;
  }
}

/* ---------- Core fare math ---------- */
export function priceWithRate(tripKm, rate, { pickupKm = 0, trafficFactor = 1, surge = 1 } = {}) {
  const perKm = Math.max(0, Number(rate.perKm ?? 0));
  const min = Math.max(0, Number(rate.minCharge ?? 0));
  const base = Math.max(0, Number(rate.baseFare ?? 0));
  const pickupPerKm = Math.max(0, Number(rate.pickupPerKm ?? 0));

  const safeTripKm = clampTripKm(Math.max(0, Number(tripKm || 0)));
  const safePickupKm = Math.min(MAX_PICKUP_KM_CHARGED, Math.max(0, Number(pickupKm || 0)));

  const distanceCost = perKm * safeTripKm;
  const pickupFee = pickupPerKm * safePickupKm;

  const raw = base + distanceCost + pickupFee;
  const withMin = Math.max(min, raw);

  const tf = Math.min(MAX_TRAFFIC_FACTOR, Math.max(1, Number(trafficFactor || 1)));
  const sg = Math.min(SURGE_MAX, Math.max(SURGE_MIN, Number(surge || 1)));

  const adjusted = withMin * tf * sg;

  // Round to the nearest 1
  const rounded = Math.round(adjusted);
  return Math.max(0, rounded);
}

/* ---------- Simple default estimator ---------- */
export function priceForDistanceKm(distanceKm, vehicleType = 'normal') {
  const key = (vehicleType || 'normal').toLowerCase();
  const rate = DEFAULT_RATE_TABLE[key] || DEFAULT_RATE_TABLE.normal;
  return priceWithRate(distanceKm, rate, { pickupKm: 0, trafficFactor: 1, surge: 1 });
}

/* ---------- High-level estimators ---------- */
export async function estimatePrice({ pickup, destination, vehicleType = 'normal', driverLocation = null }) {
  const { km: tripKm, trafficFactor } = await roadMetrics(pickup, destination);
  const pickupKm = driverLocation ? kmBetween(driverLocation, pickup) : 0;

  const key = (vehicleType || 'normal').toLowerCase();
  const rate = DEFAULT_RATE_TABLE[key] || DEFAULT_RATE_TABLE.normal;

  const surge = await surgeNear(pickup);
  const price = priceWithRate(tripKm, rate, { pickupKm, trafficFactor, surge });

  if (DEBUG_PRICING) {
    console.log(`[pricing] vt=${key} tripKm=${tripKm.toFixed(2)} pickupKm=${Math.min(pickupKm, MAX_PICKUP_KM_CHARGED).toFixed(2)} traffic=${trafficFactor.toFixed(2)} surge=${surge.toFixed(2)} => R${price}`);
  }

  return { price, km: tripKm, pickupKm: Math.min(pickupKm, MAX_PICKUP_KM_CHARGED), trafficFactor, surge };
}

/**
 * Dynamic quotes based on available drivers near the pickup.
 * Returns the CHEAPEST price per vehicleType.
 */
export async function getAvailableVehicleQuotes({ pickup, destination, radiusKm = 30 }) {
  const { km: tripKm, trafficFactor } = await roadMetrics(pickup, destination);
  const surge = await surgeNear(pickup);

  const drivers = await Driver.find({
    status: 'approved',
    isAvailable: true,
    chatId: { $type: 'number' },
    'location.lat': { $exists: true },
    'location.lng': { $exists: true }
  }).lean();

  const nearby = drivers.filter(d => d.location && kmBetween(d.location, pickup) <= radiusKm);

  const byType = nearby.reduce((acc, d) => {
    const vt = (d.vehicleType || 'normal').toLowerCase();
    (acc[vt] ||= []).push(d);
    return acc;
  }, {});

  const quotes = Object.entries(byType).map(([vehicleType, ds]) => {
    let bestPrice = Number.POSITIVE_INFINITY;
    let bestDrivers = [];

    for (const d of ds) {
      const rate = resolveRate(vehicleType, (d.pricing || {}));
      if (!rate.perKm || rate.perKm <= 0) continue;

      const pickupKm = d.location ? kmBetween(d.location, pickup) : 0;
      const p = priceWithRate(tripKm, rate, {
        pickupKm,
        trafficFactor,
        surge
      });

      if (p < bestPrice) {
        bestPrice = p;
        bestDrivers = [String(d._id)];
      } else if (p === bestPrice) {
        bestDrivers.push(String(d._id));
      }
    }

    if (!Number.isFinite(bestPrice)) return null;

    if (DEBUG_PRICING) {
      console.log(`[quotes] vt=${vehicleType} drivers=${ds.length} tripKm=${tripKm.toFixed(2)} traffic=${trafficFactor.toFixed(2)} surge=${surge.toFixed(2)} -> best=R${bestPrice}`);
    }

    return {
      vehicleType,
      price: bestPrice,
      km: tripKm,
      driverIds: bestDrivers,
      driverCount: ds.length
    };
  }).filter(Boolean);

  quotes.sort((a, b) => a.price - b.price);
  return quotes;
}

/* ---------- Final dynamic fare (with optional waiting fee) ---------- */
export async function computeFinalFare({
  pickup,
  destination,
  vehicleType = 'normal',
  path = null,
  createdAt = null,
  pickedAt = null,
  completedAt = null,
  driverStartLocation = null,
  arrivedAt = null
}) {
  // derive trip distance (km)
  let tripKm = 0;
  if (Array.isArray(path) && path.length > 1) {
    // polyline distance
    const toRad = (x) => (x * Math.PI) / 180;
    const R = 6371000; // meters
    let meters = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      if (!a || !b) continue;
      const dLat = toRad(b.lat - a.lat);
      const dLon = toRad(b.lng - a.lng);
      const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
      meters += 2 * R * Math.asin(Math.sqrt(Math.max(0, s)));
    }
    tripKm = meters / 1000;
  } else {
    tripKm = kmBetween(pickup, destination);
  }
  tripKm = clampTripKm(tripKm);

  // actual duration
  const startTs = pickedAt ? new Date(pickedAt).getTime()
                           : (createdAt ? new Date(createdAt).getTime() : null);
  const endTs   = completedAt ? new Date(completedAt).getTime() : Date.now();
  const fallbackSec = Math.round((tripKm / 30) * 3600); // fallback ~30km/h
  const actualDurationSec = (startTs && endTs && endTs >= startTs)
    ? Math.max(1, Math.round((endTs - startTs) / 1000))
    : Math.max(1, fallbackSec);

  // expected duration + traffic snapshot
  const { durationSec: expectedDurationSec } = await roadMetrics(pickup, destination);
  const expected = Math.max(60, expectedDurationSec || Math.round((tripKm / 35) * 3600));

  // dynamic traffic/delay multiplier (capped)
  let dynamicTrafficFactor = Math.max(1, actualDurationSec / expected);
  dynamicTrafficFactor = Math.min(MAX_TRAFFIC_FACTOR, dynamicTrafficFactor);

  const surge = await surgeNear(pickup);
  const pickupKm = driverStartLocation ? kmBetween(driverStartLocation, pickup) : 0;

  const key  = (vehicleType || 'normal').toLowerCase();
  const rate = DEFAULT_RATE_TABLE[key] || DEFAULT_RATE_TABLE.normal;

  let finalPrice = priceWithRate(tripKm, rate, {
    pickupKm,
    trafficFactor: dynamicTrafficFactor,
    surge
  });

  // optional WAITING FEE
  if (WAIT_PER_MIN > 0 && arrivedAt && pickedAt) {
    const arrivedTs = new Date(arrivedAt).getTime();
    const pickedTs  = new Date(pickedAt).getTime();
    const waitedSec = Math.max(0, Math.round((pickedTs - arrivedTs) / 1000));
    const waitFee   = Math.max(0, Math.round((waitedSec / 60) * WAIT_PER_MIN));
    finalPrice += waitFee;
  }

  if (DEBUG_PRICING) {
    console.log(
      `[finalFare] vt=${key} tripKm=${tripKm.toFixed(2)} actualSec=${actualDurationSec} expectedSec=${expected} ` +
      `traffic=${dynamicTrafficFactor.toFixed(2)} surge=${surge.toFixed(2)} waitPerMin=${WAIT_PER_MIN} => R${finalPrice}`
    );
  }

  return {
    price: finalPrice,
    tripKm,
    actualDurationSec,
    expectedDurationSec: expected,
    trafficFactor: dynamicTrafficFactor,
    surge
  };
}

/* ---------- Path appending (self-contained & safe) ---------- */
export async function appendPathPoint(rideId, lat, lng, label = '') {
  try {
    if (!rideId || typeof lat !== 'number' || typeof lng !== 'number') return;

    const key = String(rideId);
    const now = Date.now();
    const prev = lastPathByRide.get(key);

    // Only write if moved far enough or enough time passed
    const fastEnough = !prev || (now - prev.ts) >= 2500; // 2.5s min
    const farEnough  = !prev || haversineMeters(prev, { lat, lng }) >= 8; // 8m min
    if (!fastEnough && !farEnough) return;

    await Ride.updateOne(
      { _id: rideId },
      { $push: { path: { lat, lng, ts: new Date() } } }
    );

    lastPathByRide.set(key, { lat, lng, ts: now });

    if (label) {
      console.log(`🧭 PATH ${label} ride=${key} lat=${lat.toFixed(6)} lng=${lng.toFixed(6)}`);
    }
  } catch (e) {
    console.warn('appendPathPoint failed:', e?.message || e);
  }
}
