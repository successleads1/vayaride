// src/routes/admin.js
import express from 'express';
import passport from 'passport';
import Driver from '../models/Driver.js';
import Rider from '../models/Rider.js';
import Ride from '../models/Ride.js';           // ✨ NEW
import Activity from '../models/Activity.js';   // ✨ NEW
import { sendApprovalNotice } from '../bots/driverBot.js';

const router = express.Router();

/* ------------ helpers ------------ */
const ensureAdmin = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    if (req.user?.constructor?.modelName === 'Admin') return next();
  }
  return res.redirect('/admin/login');
};
const ensureGuest = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    if (req.user?.constructor?.modelName === 'Admin') return res.redirect('/admin');
  }
  return next();
};

/* ------------ auth screens ------------ */
router.get('/login', ensureGuest, (req, res) => {
  res.render('admin/login', { err: req.query.err || '' });
});
router.post(
  '/login',
  ensureGuest,
  passport.authenticate('local-admin', { failureRedirect: '/admin/login?err=Invalid%20credentials' }),
  (req, res) => res.redirect('/admin')
);
router.post('/logout', ensureAdmin, (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session?.destroy(() => res.redirect('/admin/login'));
  });
});

/* ------------ dashboard (richer) ------------ */
router.get('/', ensureAdmin, async (req, res) => {
  const [
    driverCounts,
    riderCount,
    drivers,
    rideCounts,
    recentTrips,
    recentCancels,
    recentActivity
  ] = await Promise.all([
    Driver.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Rider.countDocuments(),
    Driver.find().sort({ createdAt: -1 }).limit(10).lean(),
    Ride.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Ride.find().sort({ createdAt: -1 }).limit(8).lean(),
    Ride.find({ status: 'cancelled' }).sort({ updatedAt: -1 }).limit(8).lean(),
    Activity.find().sort({ createdAt: -1 }).limit(15).lean()
  ]);

  const counts = { totalDrivers: 0, pending: 0, approved: 0, rejected: 0 };
  driverCounts.forEach(x => { counts.totalDrivers += x.count; counts[x._id] = x.count; });

  const rideStats = { total: 0, pending: 0, accepted: 0, enroute: 0, completed: 0, cancelled: 0, payment_pending: 0 };
  rideCounts.forEach(x => { rideStats.total += x.count; rideStats[x._id] = x.count; });

  res.render('admin/dashboard', {
    admin: req.user,
    counts,
    riderCount,
    recentDrivers: drivers,
    rideStats,
    recentTrips,
    recentCancels,
    recentActivity
  });
});

/* ------------ drivers list ------------ */
router.get('/drivers', ensureAdmin, async (req, res) => {
  const q = {};
  if (req.query.status) q.status = req.query.status;
  const drivers = await Driver.find(q).sort({ createdAt: -1 }).lean();
  res.render('admin/drivers', { admin: req.user, drivers });
});

/* ------------ single driver (recompute stats before render) ------------ */
router.get('/drivers/:id', ensureAdmin, async (req, res) => {
  try {
    const id = req.params.id;

    // 🔁 Recompute rating + totals from rides first so avgRating/ratingsCount are fresh
    await Driver.computeAndUpdateStats(id);

    // Fetch latest driver doc for the view
    const d = await Driver.findById(id).lean();
    if (!d) return res.redirect('/admin/drivers');

    res.render('admin/driver', { admin: req.user, d });
  } catch (e) {
    console.error('driver detail error:', e);
    res.status(500).send('Server error');
  }
});

/* ------------ approve / reject ------------ */
router.post('/drivers/:id/approve', ensureAdmin, async (req, res) => {
  const d = await Driver.findById(req.params.id);
  if (!d) return res.redirect('/admin/drivers');

  d.status = 'approved';
  d.approvedAt = new Date();
  await d.save();

  const io = req.app.get('io');
  io?.emit('driver:approved', {
    driverId: String(d._id),
    chatId: d.chatId ?? null,
    name: d.name || ''
  });

  if (typeof d.chatId === 'number') {
    try {
      await sendApprovalNotice(d.chatId);
    } catch (e) {
      console.error('Failed to DM approval notice:', e?.message || e);
    }
  } else {
    console.warn(`⚠️ Approved driver ${d._id} has no chatId; cannot DM approval notice`);
  }

  return res.redirect(`/admin/drivers/${d._id}?ok=Approved`);
});

router.post('/drivers/:id/reject', ensureAdmin, async (req, res) => {
  const d = await Driver.findById(req.params.id);
  if (!d) return res.redirect('/admin/drivers');

  d.status = 'rejected';
  await d.save();

  const io = req.app.get('io');
  io?.emit('driver:rejected', { driverId: String(d._id), name: d.name || '' });

  return res.redirect(`/admin/drivers/${d._id}?ok=Rejected`);
});

/* ------------ trips list ------------ */
router.get('/trips', ensureAdmin, async (req, res) => {
  const q = {};
  if (req.query.status) q.status = req.query.status;

  const trips = await Ride.find(q)
    .populate('driverId')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  res.render('admin/trips', { admin: req.user, trips, status: req.query.status || '' });
});

/* ------------ single trip ------------ */
router.get('/trips/:id', ensureAdmin, async (req, res) => {
  const trip = await Ride.findById(req.params.id).populate('driverId').lean();
  if (!trip) return res.redirect('/admin/trips');

  const activity = await Activity.find({ rideId: trip._id }).sort({ createdAt: 1 }).lean();
  const tripName = `Trip ${String(trip._id).slice(-6).toUpperCase()}`;

  res.render('admin/trip', { admin: req.user, trip, activity, tripName });
});

export default router;
