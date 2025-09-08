// src/routes/admin.js
import express from 'express';
import passport from 'passport';
import mongoose from 'mongoose';
import Driver from '../models/Driver.js';
import Rider from '../models/Rider.js';
import Ride from '../models/Ride.js';
import Activity from '../models/Activity.js';
import { sendApprovalNotice } from '../bots/driverBot.js';
import { sendAdminEmailToDrivers } from '../services/mailer.js';

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

function escapeRegex(s = '') {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function buildDriverFilter({ q, status }) {
  const filter = {};
  if (status && ['pending', 'approved', 'rejected'].includes(String(status))) {
    filter.status = status;
  }
  if (q && q.trim()) {
    const text = q.trim();
    const rx = new RegExp(escapeRegex(text), 'i');
    const maybeId = mongoose.isValidObjectId(text) ? new mongoose.Types.ObjectId(text) : null;
    filter.$or = [
      { name: rx },
      { email: rx },
      { phone: rx },
      { vehicleType: rx },
      ...(maybeId ? [{ _id: maybeId }] : []),
    ];
  }
  return filter;
}

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

/* ------------ drivers list (search + pagination) ------------ */
router.get('/drivers', ensureAdmin, async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const sort = typeof req.query.sort === 'string' ? req.query.sort : '-createdAt';

    const page = typeof req.query.page === 'string' ? req.query.page : '1';
    const limit = typeof req.query.limit === 'string' ? req.query.limit : '20';

    const pageNum = Math.max(1, Number.parseInt(String(page), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(limit), 10) || 20));

    const filter = buildDriverFilter({ q, status });

    const [total, drivers] = await Promise.all([
      Driver.countDocuments(filter),
      Driver.find(filter)
        .sort(String(sort))
        .skip((pageNum - 1) * pageSize)
        .limit(pageSize)
        .lean(),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    res.render('admin/drivers', {
      admin: req.user,
      drivers,
      q,
      status,
      pagination: { total, page: pageNum, limit: pageSize, totalPages, sort: String(sort) }
    });
  } catch (e) {
    console.error('admin/drivers error:', e);
    res.status(500).send('Server error');
  }
});

/* ------------ email selected / page / all-matching-search ------------ */
router.post('/drivers/email', ensureAdmin, async (req, res) => {
  try {
    // expected body:
    // subject, message, mode: 'selected' | 'page' | 'search'
    // selectedIds: comma-separated ObjectIds (when mode=selected)
    // q, status, page, limit — to reconstruct scope when mode=page or search
    const subject = String(req.body.subject || '').trim();
    const message = String(req.body.message || '').trim();
    const mode = String(req.body.mode || 'selected');

    if (!subject) return res.redirect('/admin/drivers?err=' + encodeURIComponent('Subject required'));
    if (!message) return res.redirect('/admin/drivers?err=' + encodeURIComponent('Message required'));

    let recipients = [];

    if (mode === 'selected') {
      const raw = String(req.body.selectedIds || '');
      const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length === 0) {
        return res.redirect('/admin/drivers?err=' + encodeURIComponent('Select at least one driver'));
      }
      const list = await Driver.find({ _id: { $in: ids } }, { email: 1 }).lean();
      recipients = list.map(d => d.email).filter(Boolean);
    } else if (mode === 'page') {
      const q = typeof req.body.q === 'string' ? req.body.q : '';
      const status = typeof req.body.status === 'string' ? req.body.status : '';
      const page = typeof req.body.page === 'string' ? req.body.page : '1';
      const limit = typeof req.body.limit === 'string' ? req.body.limit : '20';
      const pageNum = Math.max(1, Number.parseInt(String(page), 10) || 1);
      const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(limit), 10) || 20));

      const filter = buildDriverFilter({ q, status });
      const pageList = await Driver.find(filter)
        .sort('-createdAt')
        .skip((pageNum - 1) * pageSize)
        .limit(pageSize)
        .select({ email: 1 })
        .lean();
      recipients = pageList.map(d => d.email).filter(Boolean);
    } else if (mode === 'search') {
      const q = typeof req.body.q === 'string' ? req.body.q : '';
      const status = typeof req.body.status === 'string' ? req.body.status : '';
      const filter = buildDriverFilter({ q, status });
      // cap to 1000 to avoid abuse
      const all = await Driver.find(filter).limit(1000).select({ email: 1 }).lean();
      recipients = all.map(d => d.email).filter(Boolean);
    } else {
      return res.redirect('/admin/drivers?err=' + encodeURIComponent('Invalid mode'));
    }

    // dedupe + validate
    recipients = Array.from(new Set(recipients.filter(Boolean)));
    if (recipients.length === 0) {
      return res.redirect('/admin/drivers?err=' + encodeURIComponent('No valid recipients in scope'));
    }

    const html = `
      <!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;line-height:1.5">
        <p>${message.replace(/\n/g, '<br/>')}</p>
        <hr/>
        <p style="color:#666;font-size:12px">Sent by VayaRide Admin</p>
      </body></html>
    `;

    const { sent } = await sendAdminEmailToDrivers({ to: recipients, subject, html });

    return res.redirect('/admin/drivers?ok=' + encodeURIComponent(`Email sent to ${sent} driver(s)`));
  } catch (e) {
    console.error('admin/drivers/email error:', e);
    return res.redirect('/admin/drivers?err=' + encodeURIComponent('Failed to send emails'));
  }
});

/* ------------ single driver (recompute stats before render) ------------ */
router.get('/drivers/:id', ensureAdmin, async (req, res) => {
  try {
    const id = req.params.id;

    await Driver.computeAndUpdateStats(id);

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

/* ------------ delete a single driver ------------ */
router.post('/drivers/:id/delete', ensureAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.redirect('/admin/drivers?err=' + encodeURIComponent('Invalid driver id'));
    }

    const d = await Driver.findById(id);
    if (!d) {
      return res.redirect('/admin/drivers?err=' + encodeURIComponent('Driver not found'));
    }

    await Driver.deleteOne({ _id: d._id });

    // Optional: broadcast admin activity feed
    const io = req.app.get('io');
    io?.emit('admin:activity', {
      type: 'driver_deleted',
      message: `Deleted driver ${d.name || d.email || d._id}`,
      rideId: '', // none
      createdAt: new Date()
    });

    return res.redirect('/admin/drivers?ok=' + encodeURIComponent('Driver deleted'));
  } catch (e) {
    console.error('delete driver error:', e);
    return res.redirect('/admin/drivers?err=' + encodeURIComponent('Failed to delete driver'));
  }
});

/* ------------ bulk delete selected drivers ------------ */
router.post('/drivers/bulk-delete', ensureAdmin, async (req, res) => {
  try {
    const raw = String(req.body.selectedIds || '');
    const ids = raw
      .split(',')
      .map(s => s.trim())
      .filter(s => mongoose.isValidObjectId(s));

    if (ids.length === 0) {
      return res.redirect('/admin/drivers?err=' + encodeURIComponent('No valid drivers selected'));
    }

    const result = await Driver.deleteMany({ _id: { $in: ids } });

    const io = req.app.get('io');
    io?.emit('admin:activity', {
      type: 'drivers_deleted',
      message: `Deleted ${result.deletedCount || 0} driver(s)`,
      rideId: '',
      createdAt: new Date()
    });

    return res.redirect('/admin/drivers?ok=' + encodeURIComponent(`Deleted ${result.deletedCount || 0} driver(s)`));
  } catch (e) {
    console.error('bulk delete drivers error:', e);
    return res.redirect('/admin/drivers?err=' + encodeURIComponent('Bulk delete failed'));
  }
});


export default router;
