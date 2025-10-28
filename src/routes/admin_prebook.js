// src/routes/admin_prebook.js
import express from 'express';
import mongoose from 'mongoose';
import Ride from '../models/Ride.js';
import Driver from '../models/Driver.js';
import Rider from '../models/Rider.js';
import Activity from '../models/Activity.js';

const router = express.Router();

/* ------------ helpers ------------ */
const ensureAdmin = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    if (req.user?.constructor?.modelName === 'Admin') return next();
  }
  return res.redirect('/admin/login');
};

function escapeRegex(s = '') { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function parseDateOnly(s, endOfDay = false) {
  if (!s || typeof s !== 'string') return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  if (!endOfDay) d.setHours(0,0,0,0); else d.setHours(23,59,59,999);
  return d;
}

/** Try to extract a readable place name/address from a location-ish object */
function placeLabel(obj = {}) {
  if (!obj || typeof obj !== 'object') return '—';

  // Obvious string fields
  const direct = [
    'name','placeName','place_name','label','title','text','description',
    'formatted','formattedAddress','display_name','vicinity','addressLine'
  ];
  for (const k of direct) {
    if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim();
  }

  // Nested address containers
  const addr = obj.address || obj.location || obj.properties || {};
  const addrKeys = [
    'name','label','formatted','formattedAddress','freeformAddress','road',
    'suburb','city','town','village','state','county','country'
  ];
  for (const k of addrKeys) {
    if (typeof addr[k] === 'string' && addr[k].trim()) return addr[k].trim();
  }

  // Array shapes (mapbox / google)
  if (Array.isArray(obj.context)) {
    const c = obj.context.find(x => x && (x.text || x.name || x.label));
    if (c) return (c.text || c.name || c.label).trim();
  }
  if (Array.isArray(obj.terms)) {
    const s = obj.terms.map(t => (t.value || t.text || '').trim()).filter(Boolean).join(', ');
    if (s) return s;
  }

  // Generic “string that looks addressy”
  for (const [k,v] of Object.entries(obj)) {
    if (typeof v === 'string' && /[A-Za-z].*\d|\d.*[A-Za-z]/.test(v)) return v.trim();
  }

  // Final fallback: coordinates
  if (typeof obj.lat === 'number' && typeof obj.lng === 'number') {
    return `${obj.lat.toFixed(5)}, ${obj.lng.toFixed(5)}`;
  }
  return '—';
}

/** Build a rider display block from populated rider or ride fields */
function riderBlock(ride, riderDoc) {
  const r = riderDoc || {};
  const name =
    r.name ||
    ride.riderName ||
    ride?.rider?.name ||
    ride?.rider?.fullName ||
    ride?.meta?.rider?.name ||
    ride?.meta?.rider?.fullName ||
    ride?.riderInfo?.name ||
    ride?.riderInfo?.fullName ||
    '—';

  const phone =
    r.phone || r.msisdn ||
    ride.riderPhone ||
    ride?.rider?.phone || ride?.rider?.msisdn ||
    ride?.meta?.rider?.phone || ride?.meta?.rider?.msisdn ||
    ride?.riderInfo?.phone || ride?.riderInfo?.msisdn ||
    r.email || ride.riderEmail || '—';

  return { name, phone };
}

/* ------------ list prebook (scheduled) ------------ */
router.get('/prebook', ensureAdmin, async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const assigned = typeof req.query.assigned === 'string' ? req.query.assigned : '';
    const from = typeof req.query.from === 'string' ? req.query.from : '';
    const to   = typeof req.query.to === 'string' ? req.query.to : '';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    // base filter
    const filter = { status: 'scheduled' };
    if (assigned === 'unassigned') filter.driverId = null;
    else if (assigned === 'assigned') filter.driverId = { $ne: null };

    const df = parseDateOnly(from, false);
    const dt = parseDateOnly(to, true);
    if (df && dt) filter.scheduledFor = { $gte: df, $lte: dt };
    else if (df)  filter.scheduledFor = { $gte: df };
    else if (dt)  filter.scheduledFor = { $lte: dt };

    // query rides + populate driver & riderId (if present)
    const [total, rawRides] = await Promise.all([
      Ride.countDocuments(filter),
      Ride.find(filter)
        .populate('driverId')
        .populate('riderId')
        .sort({ scheduledFor: 1, createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
    ]);

    // If riderId is missing but we have riderChatId, try to load rider and attach
    const chatIdsMissingRider = rawRides
      .filter(r => !r.riderId && typeof r.riderChatId === 'number')
      .map(r => r.riderChatId);

    let ridersByChatId = {};
    if (chatIdsMissingRider.length) {
      const loaded = await Rider.find({ chatId: { $in: chatIdsMissingRider } })
        .select({ chatId: 1, name: 1, phone: 1, msisdn: 1, email: 1 })
        .lean();
      ridersByChatId = Object.fromEntries(loaded.map(x => [x.chatId, x]));
    }

    // Build UI helpers for each ride
    const rides = rawRides.map(r => {
      const riderDoc = r.riderId || ridersByChatId[r.riderChatId] || null;

      const { name: riderName, phone: riderPhone } = riderBlock(r, riderDoc);

      const pickupLabel =
        r.pickupName || r.pickupLabel || r.pickupText || placeLabel(r.pickup || {});
      const destLabel =
        r.destinationName || r.destinationLabel || r.destinationText || placeLabel(r.destination || {});

      return {
        ...r,
        _ui: {
          riderName,
          riderPhone,
          pickupLabel,
          destLabel
        }
      };
    });

    // Optional text search over UI fields (in-memory for page)
    let filtered = rides;
    if (q && q.trim()) {
      const rx = new RegExp(escapeRegex(q.trim()), 'i');
      filtered = rides.filter(r => {
        const d = r.driverId || {};
        return (
          rx.test(r._ui.riderName) ||
          rx.test(r._ui.riderPhone) ||
          rx.test(r._ui.pickupLabel) ||
          rx.test(r._ui.destLabel) ||
          (d.name && rx.test(d.name)) ||
          (d.phone && rx.test(d.phone)) ||
          String(r._id) === q.trim()
        );
      });
    }

    // Drivers for assign dropdown
    const drivers = await Driver.find({ status: 'approved' })
      .sort({ name: 1 })
      .select({ _id: 1, name: 1, phone: 1, vehicleType: 1 })
      .lean();

    res.render('admin/prebook', {
      admin: req.user,
      rides: filtered,
      drivers,
      total,
      pagination: {
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit))
      },
      q, assigned, from, to
    });
  } catch (e) {
    console.error('GET /admin/prebook error:', e);
    res.status(500).send('Server error');
  }
});

/* ------------ assign a driver to a scheduled ride ------------ */
router.post('/prebook/:id/assign', ensureAdmin, async (req, res) => {
  try {
    const rideId = String(req.params.id || '').trim();
    const driverId = String(req.body.driverId || '').trim();
    if (!mongoose.isValidObjectId(rideId) || !mongoose.isValidObjectId(driverId)) {
      return res.status(400).json({ ok: false, error: 'Invalid IDs' });
    }

    const [ride, driver] = await Promise.all([
      Ride.findById(rideId),
      Driver.findById(driverId)
    ]);

    if (!ride || ride.status !== 'scheduled') {
      return res.status(404).json({ ok: false, error: 'Scheduled ride not found' });
    }
    if (!driver || driver.status !== 'approved') {
      return res.status(400).json({ ok: false, error: 'Driver not approved' });
    }

    ride.driverId = driver._id;
    ride.scheduledAssignedAt = new Date();
    ride.scheduledAssignedBy = req.user?._id || null;
    await ride.save();

    await Activity.create({
      type: 'scheduled_assigned',
      message: `Assigned driver ${driver.name || driver._id} to scheduled ride`,
      rideId: ride._id
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error('POST /admin/prebook/:id/assign error:', e);
    return res.status(500).json({ ok: false, error: 'Failed to assign' });
  }
});

/* ------------ unassign driver ------------ */
router.post('/prebook/:id/unassign', ensureAdmin, async (req, res) => {
  try {
    const rideId = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(rideId)) {
      return res.status(400).json({ ok: false, error: 'Invalid ride id' });
    }
    const ride = await Ride.findById(rideId);
    if (!ride || ride.status !== 'scheduled') {
      return res.status(404).json({ ok: false, error: 'Scheduled ride not found' });
    }

    ride.driverId = null;
    await ride.save();

    await Activity.create({
      type: 'scheduled_unassigned',
      message: `Unassigned driver from scheduled ride`,
      rideId: ride._id
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error('POST /admin/prebook/:id/unassign error:', e);
    return res.status(500).json({ ok: false, error: 'Failed to unassign' });
  }
});

export default router;
