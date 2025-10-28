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
import { sendWhatsAppDriverMessage } from '../bots/whatsappDriverBot.js';
import { dispatchScheduledToDriver, broadcastScheduledRide } from '../services/prebook.js';

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

function escapeRegex(s = '') { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

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

function buildRiderFilter({ q }) {
  const filter = {};
  if (q && q.trim()) {
    const text = q.trim();
    const rx = new RegExp(escapeRegex(text), 'i');
    const maybeId = mongoose.isValidObjectId(text) ? new mongoose.Types.ObjectId(text) : null;
    filter.$or = [
      { name: rx }, { email: rx }, { phone: rx }, { msisdn: rx },
      { platform: rx }, { waJid: rx }, { referralCode: rx },
      ...(maybeId ? [{ _id: maybeId }] : []),
      ...(Number.isFinite(Number(text)) ? [{ chatId: Number(text) }] : [])
    ];
  }
  return filter;
}

const getPublicUrl = (req) =>
  (process.env.PUBLIC_URL && process.env.PUBLIC_URL.replace(/\/$/, '')) ||
  `${req.protocol}://${req.get('host')}`;

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

/* ------------ dashboard ------------ */
router.get('/', ensureAdmin, async (req, res) => {
  const [
    driverCounts,
    riderCount,
    drivers,
    rideCounts,
    recentTrips,
    recentCancels,
    recentActivity,
    upcomingCount
  ] = await Promise.all([
    Driver.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Rider.countDocuments(),
    Driver.find().sort({ createdAt: -1 }).limit(10).lean(),
    Ride.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Ride.find().sort({ createdAt: -1 }).limit(8).lean(),
    Ride.find({ status: 'cancelled' }).sort({ updatedAt: -1 }).limit(8).lean(),
    Activity.find().sort({ createdAt: -1 }).limit(15).lean(),
    Ride.countDocuments({ status: 'scheduled' })
  ]);

  const counts = { totalDrivers: 0, pending: 0, approved: 0, rejected: 0 };
  driverCounts.forEach(x => { counts.totalDrivers += x.count; counts[x._id] = x.count; });

  const rideStats = { total: 0, pending: 0, accepted: 0, enroute: 0, completed: 0, cancelled: 0, payment_pending: 0, scheduled: 0 };
  rideCounts.forEach(x => { rideStats.total += x.count; rideStats[x._id] = x.count; });
  rideStats.scheduled = upcomingCount || 0;

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
      publicUrl: getPublicUrl(req),
      pagination: { total, page: pageNum, limit: pageSize, totalPages, sort: String(sort) }
    });
  } catch (e) {
    console.error('admin/drivers error:', e);
    res.status(500).send('Server error');
  }
});

/* ------------ email drivers ------------ */
router.post('/drivers/email', ensureAdmin, async (req, res) => {
  try {
    const subject = String(req.body.subject || '').trim();
    const message = String(req.body.message || '').trim();
    const mode = String(req.body.mode || 'selected');

    if (!subject) return res.redirect('/admin/drivers?err=' + encodeURIComponent('Subject required'));
    if (!message) return res.redirect('/admin/drivers?err=' + encodeURIComponent('Message required'));

    let recipients = [];

    if (mode === 'selected') {
      const raw = String(req.body.selectedIds || '');
      const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length === 0) return res.redirect('/admin/drivers?err=' + encodeURIComponent('Select at least one driver'));
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
      const all = await Driver.find(filter).limit(1000).select({ email: 1 }).lean();
      recipients = all.map(d => d.email).filter(Boolean);
    } else {
      return res.redirect('/admin/drivers?err=' + encodeURIComponent('Invalid mode'));
    }

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

/* ------------ WA drivers ------------ */
router.post('/drivers/wa', ensureAdmin, async (req, res) => {
  try {
    const mode = String(req.body.mode || 'selected');
    const rawMessage = String(req.body.message || '').trim();
    const message = rawMessage.replace(/\r\n/g, '\n');
    if (!message) return res.status(400).json({ ok: false, error: 'Message required' });

    let recipients = []; // phones

    if (mode === 'selected') {
      const raw = String(req.body.selectedIds || '');
      const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length === 0) return res.status(400).json({ ok: false, error: 'Select at least one driver' });
      const list = await Driver.find({ _id: { $in: ids } }, { phone: 1 }).lean();
      recipients = list.map(d => d.phone).filter(Boolean);
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
        .select({ phone: 1 })
        .lean();
      recipients = pageList.map(d => d.phone).filter(Boolean);
    } else if (mode === 'search') {
      const q = typeof req.body.q === 'string' ? req.body.q : '';
      const status = typeof req.body.status === 'string' ? req.body.status : '';
      const filter = buildDriverFilter({ q, status });
      const all = await Driver.find(filter).limit(1000).select({ phone: 1 }).lean();
      recipients = all.map(d => d.phone).filter(Boolean);
    } else {
      return res.status(400).json({ ok: false, error: 'Invalid mode' });
    }

    recipients = Array.from(new Set(recipients.filter(Boolean)));
    if (recipients.length === 0) return res.status(400).json({ ok: false, error: 'No valid phone numbers in scope' });

    const results = await Promise.allSettled(
      recipients.map(p => sendWhatsAppDriverMessage(p, message))
    );

    const sent = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.length - sent;

    return res.json({ ok: true, sent, failed, total: recipients.length });
  } catch (e) {
    console.error('admin/drivers/wa error:', e);
    return res.status(500).json({ ok: false, error: 'Failed to send WhatsApp messages' });
  }
});

/* ------------ single driver ------------ */
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
    try { await sendApprovalNotice(d.chatId); } catch (e) { console.error('Failed to DM approval notice:', e?.message || e); }
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

    const io = req.app.get('io');
    io?.emit('admin:activity', {
      type: 'driver_deleted',
      message: `Deleted driver ${d.name || d.email || d._id}`,
      rideId: '',
      createdAt: new Date()
    });

    return res.redirect('/admin/drivers?ok=' + encodeURIComponent('Driver deleted'));
  } catch (e) {
    console.error('delete driver error:', e);
    return res.redirect('/admin/drivers?err=' + encodeURIComponent('Failed to delete driver'));
  }
});

/* ------------ bulk delete drivers ------------ */
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

/* ===================== RIDERS ADMIN ===================== */

/* Riders list + show upcoming prebooks */
router.get('/riders', ensureAdmin, async (req, res) => {
  try {
    const q     = typeof req.query.q === 'string' ? req.query.q : '';
    const sort  = typeof req.query.sort === 'string' ? req.query.sort : '-createdAt';
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const filter = buildRiderFilter({ q });

    const [total, riders] = await Promise.all([
      Rider.countDocuments(filter),
      Rider.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    // compute scheduled summary for current page by riderChatId
    const chatIds = riders.map(r => r.chatId).filter(v => Number.isFinite(Number(v)));
    const scheduled = chatIds.length
      ? await Ride.aggregate([
          { $match: { status: 'scheduled', riderChatId: { $in: chatIds } } },
          {
            $group: {
              _id: '$riderChatId',
              count: { $sum: 1 },
              next: { $min: '$scheduledFor' }
            }
          }
        ])
      : [];

    const scheduledSummaryByRider = {};
    for (const row of scheduled) {
      scheduledSummaryByRider[String(row._id)] = { count: row.count, next: row.next };
    }

    const totalPages = Math.max(1, Math.ceil(total / limit));

    res.render('admin/riders', {
      admin: req.user,
      riders,
      q,
      publicUrl: getPublicUrl(req),
      pagination: { total, page, limit, totalPages, sort },
      scheduledSummaryByRider
    });
  } catch (e) {
    console.error('admin/riders error:', e);
    res.status(500).send('Server error');
  }
});

/* Rider detail (+ recent trips) */
router.get('/riders/:id', ensureAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return res.redirect('/admin/riders');

    const rider = await Rider.findById(id).lean();
    if (!rider) return res.redirect('/admin/riders');

    // show recent + scheduled for this rider
    const [recentTrips, upcoming] = await Promise.all([
      Ride.find({ riderChatId: rider.chatId }).populate('driverId').sort({ createdAt: -1 }).limit(20).lean(),
      Ride.find({ riderChatId: rider.chatId, status: 'scheduled' }).sort({ scheduledFor: 1 }).lean()
    ]);

    res.render('admin/rider', {
      admin: req.user,
      rider,
      publicUrl: getPublicUrl(req),
      recentTrips,
      upcoming
    });
  } catch (e) {
    console.error('admin/riders/:id error:', e);
    res.status(500).send('Server error');
  }
});

/* ===================== PREBOOK MANAGEMENT (FIXED) ===================== */
router.get('/prebook', ensureAdmin, async (req, res) => {
  const parseDateOnly = (s, end = false) => {
    if (!s || typeof s !== 'string') return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    if (end) d.setHours(23,59,59,999); else d.setHours(0,0,0,0);
    return d;
  };
  const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  try {
    // ---- filters
    const qTxt     = typeof req.query.q === 'string' ? req.query.q : '';
    const assigned = typeof req.query.assigned === 'string' ? req.query.assigned : '';
    const fromStr  = typeof req.query.from === 'string' ? req.query.from : '';
    const toStr    = typeof req.query.to   === 'string' ? req.query.to   : '';
    const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit    = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const df = parseDateOnly(fromStr, false);
    const dt = parseDateOnly(toStr, true);

    const filter = { status: 'scheduled' };
    if (assigned === 'unassigned') filter.driverId = null;
    if (assigned === 'assigned')   filter.driverId = { $ne: null };
    if (df && dt) filter.scheduledFor = { $gte: df, $lte: dt };
    else if (df)  filter.scheduledFor = { $gte: df };
    else if (dt)  filter.scheduledFor = { $lte: dt };

    const total = await Ride.countDocuments(filter);

    // populate both possible field names (riderId/driverId or rider/driver)
    const pageItems = await Ride.find(filter)
      .populate({ path: 'riderId',  model: 'Rider',  strictPopulate: false })
      .populate({ path: 'driverId', model: 'Driver', strictPopulate: false })
      .populate({ path: 'rider',    model: 'Rider',  strictPopulate: false })
      .populate({ path: 'driver',   model: 'Driver', strictPopulate: false })
      .sort({ scheduledFor: 1, createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // in-memory text filter for current page
    const afterSearch = (() => {
      if (!qTxt || !qTxt.trim()) return pageItems;
      const rx = new RegExp(escapeRx(qTxt.trim()), 'i');
      return pageItems.filter(r => {
        const rd = r.riderId || r.rider || {};
        const dd = r.driverId || r.driver || {};
        return (
          (rd.name  && rx.test(rd.name))  ||
          (rd.email && rx.test(rd.email)) ||
          (rd.phone && rx.test(rd.phone)) ||
          (dd.name  && rx.test(dd.name))  ||
          (dd.email && rx.test(dd.email)) ||
          (dd.phone && rx.test(dd.phone)) ||
          (String(r._id) === qTxt.trim())
        );
      });
    })();

    // if some rides miss rider doc but have riderChatId, fetch riders by that
    const missingChatIds = Array.from(new Set(
      afterSearch
        .filter(r => !(r.riderId || r.rider) && Number.isFinite(Number(r.riderChatId)))
        .map(r => Number(r.riderChatId))
    ));
    let ridersByChat = {};
    if (missingChatIds.length) {
      const extraRiders = await Rider.find({ chatId: { $in: missingChatIds } })
        .select({ chatId: 1, name: 1, phone: 1, msisdn: 1 })
        .lean();
      ridersByChat = Object.fromEntries(extraRiders.map(rr => [String(rr.chatId), rr]));
    }

    // helper to build location label
    const placeLabel = (p) => {
      if (!p || typeof p !== 'object') return '';
      for (const k of [
        'label','name','placeName','address','description','vicinity',
        'text','display_name','formatted','title'
      ]) {
        if (p[k] && typeof p[k] === 'string') return p[k];
      }
      if (typeof p.lat === 'number' && typeof p.lng === 'number') {
        return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
      }
      return '';
    };

    // decorate for UI
    for (const r of afterSearch) {
      const riderDoc =
        (r.riderId || r.rider) ||
        (r.riderChatId != null ? ridersByChat[String(r.riderChatId)] : null) ||
        {};

      r._ui = {
        riderName:  riderDoc.name  || r.riderName  || '',
        riderPhone: riderDoc.phone || riderDoc.msisdn || r.riderPhone || '',

        pickupLabel:
          placeLabel(r.pickup) ||
          r.pickupName || r.pickupAddress || '',

        destLabel:
          placeLabel(r.destination) ||
          r.destinationName || r.destinationAddress || ''
      };
    }

    const drivers = await Driver.find({ status: 'approved' })
      .select({ _id: 1, name: 1, phone: 1, vehicleType: 1 })
      .sort({ name: 1 })
      .lean();

    res.render('admin/prebook', {
      admin: req.user,
      rides: afterSearch,
      drivers,
      q: qTxt,
      assigned,
      from: fromStr,
      to: toStr,
      pagination: { page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) }
    });
  } catch (err) {
    console.error('GET /admin/prebook failed:', err?.stack || err);
    return res.status(500).send('Server error');
  }
});

/* Assign a scheduled ride to a driver (keeps it 'pending' and DMs just that driver) */
router.post('/prebook/:id/assign', ensureAdmin, async (req, res) => {
  try {
    const rideId = req.params.id;
    const driverId = String(req.body.driverId || '').trim();
    if (!mongoose.isValidObjectId(rideId) || !mongoose.isValidObjectId(driverId)) {
      return res.redirect('/admin/prebook?err=' + encodeURIComponent('Invalid ids'));
    }
    await dispatchScheduledToDriver({ rideId, driverId });

    const io = req.app.get('io');
    io?.emit('admin:activity', {
      type: 'prebook_assigned',
      message: `Assigned prebook to driver ${driverId}`,
      rideId,
      createdAt: new Date()
    });

    return res.redirect('/admin/prebook?ok=' + encodeURIComponent('Assigned & notified driver'));
  } catch (e) {
    console.error('prebook assign error:', e);
    return res.redirect('/admin/prebook?err=' + encodeURIComponent('Failed to assign'));
  }
});

/* Broadcast a scheduled ride to many drivers (sets to pending) */
router.post('/prebook/:id/broadcast', ensureAdmin, async (req, res) => {
  try {
    const rideId = req.params.id;
    if (!mongoose.isValidObjectId(rideId)) {
      return res.redirect('/admin/prebook?err=' + encodeURIComponent('Invalid ride id'));
    }
    const drivers = await Driver.find({ status: 'approved', chatId: { $exists: true, $ne: null } })
      .select('chatId')
      .limit(300)
      .lean();

    await broadcastScheduledRide({ rideId, drivers });

    const io = req.app.get('io');
    io?.emit('admin:activity', {
      type: 'prebook_broadcast',
      message: `Broadcasted prebook to ${drivers.length} drivers`,
      rideId,
      createdAt: new Date()
    });

    return res.redirect('/admin/prebook?ok=' + encodeURIComponent('Broadcast sent'));
  } catch (e) {
    console.error('prebook broadcast error:', e);
    return res.redirect('/admin/prebook?err=' + encodeURIComponent('Failed to broadcast'));
  }
});

/* --- server-side reverse geocoder (Nominatim) --- */
router.get('/geocode', ensureAdmin, async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ ok: false, error: 'Bad lat/lng' });
    }

    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`;
    const r = await fetch(url, {
      headers: {
        // Nominatim prefers an identifying UA
        'User-Agent': 'VayaRide-Admin/1.0 (admin@vayaride.example)',
        'Accept': 'application/json'
      }
    });

    if (!r.ok) return res.status(502).json({ ok: false, error: 'Geocoder upstream error' });
    const j = await r.json();
    const name = j.display_name || j.name || j.address?.road || '';
    return res.json({ ok: true, name });
  } catch (e) {
    console.error('geocode error:', e);
    return res.status(500).json({ ok: false, error: 'Geocoder failed' });
  }
});

export default router;
