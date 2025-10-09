// src/routes/driverAuth.js
import express from 'express';
import bcrypt from 'bcrypt';
import passport from 'passport';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import stream from 'stream';
import sharp from 'sharp';
import Driver from '../models/Driver.js';
import { sendDriverWelcomeEmail, sendAdminNewDriverAlert } from '../services/mailer.js';

/* ---------- Cloudinary ---------- */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

/* ---------- Limits & Multer ---------- */
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') return cb(null, true);
    cb(new Error('Unsupported file type'));
  }
});

/* ---------- Guards ---------- */
const ensureAuth = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.redirect('/driver/login');
};
const ensureGuest = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) return res.redirect('/driver');
  return next();
};

/* ---------- Helpers ---------- */
const getPublicUrl = (req) =>
  (process.env.PUBLIC_URL && process.env.PUBLIC_URL.replace(/\/$/, '')) ||
  `${req.protocol}://${req.get('host')}`;

function renderError(res, view, msg, extras = {}) {
  const status = extras.statusCode || 400;
  const payload = { error: msg, ...extras };
  return res.status(status).render(view, payload);
}

/** Normalize SA numbers to E.164 (+27XXXXXXXXX). Returns null if invalid. */
function normalizePhoneZA(input = '') {
  const d = String(input).replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10 && d.startsWith('0')) return `+27${d.slice(1)}`;
  if (d.length === 11 && d.startsWith('27')) return `+${d}`;
  if (d.length === 9) return `+27${d}`;
  return null;
}

/** Match your front-end <input pattern> exactly */
function isStrongPassword(pw = '') {
  return /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])\S{8,}/.test(String(pw));
}

/** Compress only images before Cloudinary upload */
async function compressIfImage(file) {
  if (!file || !file.mimetype?.startsWith('image/')) return file.buffer;
  const out = await sharp(file.buffer)
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return out;
}
function uploadBufferToCloudinary(buffer, folder, filenameHint) {
  return new Promise((resolve, reject) => {
    const passthrough = new stream.PassThrough();
    passthrough.end(buffer);
    const options = {
      folder,
      resource_type: 'auto',
      public_id: filenameHint?.replace(/\W+/g, '_') || undefined
    };
    const cldStream = cloudinary.uploader.upload_stream(
      options,
      (err, result) => (err ? reject(err) : resolve(result))
    );
    passthrough.pipe(cldStream);
  });
}

/* ---------- Docs form fields ---------- */
const DOC_FIELDS = [
  { name: 'driverProfilePhoto',   maxCount: 1 },
  { name: 'vehiclePhoto',         maxCount: 1 },
  { name: 'idDocument',           maxCount: 1 },
  { name: 'vehicleRegistration',  maxCount: 1 },
  { name: 'driversLicense',       maxCount: 1 },
  // { name: 'insuranceCertificate', maxCount: 1 }, // hidden
  { name: 'pdpOrPsv',             maxCount: 1 },
  // { name: 'dekraCertificate',     maxCount: 1 }, // hidden
  { name: 'policeClearance',      maxCount: 1 },
  { name: 'licenseDisc',          maxCount: 1 }
];
const DOC_KEYS = [
  'driverProfilePhoto','vehiclePhoto','idDocument','vehicleRegistration',
  'driversLicense',/*'insuranceCertificate',*/'pdpOrPsv',/*'dekraCertificate',*/
  'policeClearance','licenseDisc'
];

/* ---------- Router ---------- */
const router = express.Router();

/* ---------------- Dashboard ---------------- */
router.get('/', ensureAuth, async (req, res) => {
  await Driver.ensureReferralCode(req.user._id);
  const fresh = await Driver.findById(req.user._id).lean();

  res.render('driver/dashboard', {
    user: fresh,
    ok: req.query.ok || '',
    err: req.query.err || ''
  });
});

/* ---------------- Register ---------------- */
router.get('/register', ensureGuest, (req, res) => {
  res.render('driver/register', {
    error: req.query.err || null,
    publicUrl: getPublicUrl(req),
    form: {},
    ref: (req.query.ref || '').trim()
  });
});

router.post('/register', ensureGuest, async (req, res) => {
  try {
    const nameRaw   = (req.body.name || '').trim();
    const emailRaw  = (req.body.email || '').trim().toLowerCase();
    const phoneRaw  = (req.body.phone || '').trim();
    const password  = String(req.body.password || '');
    const confirm   = String(req.body.confirm || '');
    const vehicleTypeRaw = String(req.body.vehicleType || '').toLowerCase();
    const publicUrl = getPublicUrl(req);

    const keep = { name: nameRaw, email: emailRaw, phone: phoneRaw, vehicleType: vehicleTypeRaw, ref: (req.body.ref || '').trim() };

    if (!nameRaw || !emailRaw || !phoneRaw || !password || !confirm || !vehicleTypeRaw) {
      return renderError(res, 'driver/register', 'Please fill in all fields.', { publicUrl, form: keep });
    }
    if (password !== confirm) {
      return renderError(res, 'driver/register', 'Passwords do not match', { publicUrl, form: keep });
    }
    if (!isStrongPassword(password)) {
      return renderError(
        res,
        'driver/register',
        'Password must be 8+ chars with upper, lower, number & special (no spaces).',
        { publicUrl, form: keep }
      );
    }

    const phoneE164 = normalizePhoneZA(phoneRaw);
    if (!phoneE164) {
      return renderError(res, 'driver/register', 'Enter a valid South African phone number', { publicUrl, form: keep });
    }

    const allowedVehicles = ['normal', 'comfort', 'luxury', 'xl'];
    if (!allowedVehicles.includes(vehicleTypeRaw)) {
      return renderError(res, 'driver/register', 'Invalid vehicle type', { publicUrl, form: keep });
    }

    const existing = await Driver.findOne({ $or: [{ email: emailRaw }, { phone: phoneE164 }] })
      .select('_id email phone')
      .lean();
    if (existing) {
      const msg = existing.email === emailRaw ? 'Email already in use' : 'Phone already in use';
      return renderError(res, 'driver/register', msg, { publicUrl, form: keep, statusCode: 409 });
    }

    const refCodeRaw = String(req.body.ref || req.query.ref || '').trim().toUpperCase();
    let referredById = null;
    if (refCodeRaw) {
      const ref = await Driver.findOne({ referralCode: refCodeRaw }).select('_id');
      if (ref?._id) referredById = ref._id;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const created = await Driver.create({
      name: nameRaw,
      email: emailRaw,
      phone: phoneE164,
      passwordHash,
      vehicleType: vehicleTypeRaw,
      status: 'pending',
      isAvailable: false,
      referredBy: referredById || undefined
    });

    try { await Driver.ensureReferralCode(created._id); } catch {}

    if (referredById) {
      try {
        await Driver.updateOne(
          { _id: referredById },
          { $inc: { 'referralStats.registrations': 1 } }
        );
      } catch (e) {
        console.warn('Failed to bump referrer registrations:', e?.message || e);
      }
    }

    // 🔎 explicit mail log before sending
    console.log('[MAIL] about to send driver welcome & admin alert for', emailRaw);

    try {
      await sendDriverWelcomeEmail(emailRaw, { name: nameRaw, vehicleType: vehicleTypeRaw });
    } catch (e) {
      console.error('Welcome email failed:', e?.message || e);
    }
    try {
      await sendAdminNewDriverAlert({
        name: nameRaw,
        email: emailRaw,
        phone: phoneE164,
        vehicleType: vehicleTypeRaw,
        createdAt: created?.createdAt || new Date(),
        dashboardUrl: `${publicUrl.replace(/\/$/, '')}/admin/drivers?highlight=${encodeURIComponent(created._id.toString())}`
      });
    } catch (e) {
      console.error('Admin alert failed:', e?.message || e);
    }

    return res.redirect(303, `/driver/login?justRegistered=1&email=${encodeURIComponent(emailRaw)}`);
  } catch (err) {
    if (err && err.code === 11000) {
      const publicUrl = getPublicUrl(req);
      const which = err.keyPattern?.email ? 'Email' : err.keyPattern?.phone ? 'Phone' : 'Account';
      return renderError(res, 'driver/register', `${which} already exists`, {
        publicUrl,
        form: {
          name: (req.body?.name || '').trim(),
          email: (req.body?.email || '').trim().toLowerCase(),
          phone: (req.body?.phone || '').trim(),
          vehicleType: (req.body?.vehicleType || '').trim().toLowerCase(),
          ref: (req.body?.ref || '').trim()
        },
        statusCode: 409
      });
    }
    console.error('Register error:', err?.message || err);
    return renderError(res, 'driver/register', 'Server error', {
      publicUrl: getPublicUrl(req),
      form: {
        name: (req.body?.name || '').trim(),
        email: (req.body?.email || '').trim().toLowerCase(),
        phone: (req.body?.phone || '').trim(),
        vehicleType: (req.body?.vehicleType || '').trim().toLowerCase(),
        ref: (req.body?.ref || '').trim()
      },
      statusCode: 500
    });
  }
});

/* ---------------- Login ---------------- */
router.get('/login', ensureGuest, (req, res) => {
  res.render('driver/login', {
    email: req.query.email || '',
    publicUrl: getPublicUrl(req)
  });
});

router.post(
  '/login',
  ensureGuest,
  passport.authenticate('local-driver', { failureRedirect: '/driver/login' }),
  (req, res) => res.redirect('/driver')
);

/* ---------------- Upload Docs ---------------- */
router.get('/upload-docs', ensureAuth, (req, res) => res.redirect('/driver#docsForm'));

router.post('/upload-docs', ensureAuth, upload.fields(DOC_FIELDS), async (req, res) => {
  try {
    const driver = await Driver.findById(req.user._id);
    if (!driver) return res.redirect('/driver?err=Driver%20not%20found');

    driver.documents = driver.documents || {};
    const folder = `drivers/${driver._id}`;

    for (const { name } of DOC_FIELDS) {
      const fileArr = req.files?.[name];
      if (!fileArr || !fileArr[0]) continue;

      const file = fileArr[0];
      let bufferToUpload = await compressIfImage(file);
      if (bufferToUpload.length > MAX_FILE_SIZE) {
        return res.redirect('/driver?err=One%20or%20more%20files%20exceed%2010MB%20even%20after%20compression#docs');
      }
      const uploaded = await uploadBufferToCloudinary(bufferToUpload, folder, name);
      driver.documents[name] = uploaded.secure_url;
    }

    driver.status = 'pending';
    await driver.save();
    return res.redirect('/driver?ok=' + encodeURIComponent('Documents submitted for review') + '#docs');
  } catch (err) {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.redirect('/driver?err=File%20too%20large%20(max%2010MB)#docs');
    }
    console.error('Upload docs error:', err);
    const msg = err?.message ? encodeURIComponent(err.message) : 'Upload%20failed';
    return res.redirect('/driver?err=' + msg + '#docs');
  }
});

/* ---------------- Delete a single doc ---------------- */
function extractCloudinaryInfo(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');

    const resourceType = parts[2] || 'image';
    const uploadIdx = parts.indexOf('upload');
    let after = parts.slice(uploadIdx + 1).join('/');

    if (after.startsWith('v') && /\dv\d*/.test(after.slice(0, 6))) {
      after = after.split('/').slice(1).join('/');
    }

    const last = after.split('/').pop() || '';
    const withoutExt = last.includes('.') ? last.substring(0, last.lastIndexOf('.')) : last;
    const before = after.split('/').slice(0, -1).join('/');
    const publicId = before ? `${before}/${withoutExt}` : withoutExt;
    const type = /\.pdf(\?|$)/i.test(url) ? 'raw' : (resourceType || 'image');
    return { publicId, resourceType: type };
  } catch {
    return { publicId: null, resourceType: 'image' };
  }
}

router.post('/delete-doc', ensureAuth, async (req, res) => {
  try {
    const key = String(req.body.key || '');
    if (!DOC_KEYS.includes(key)) {
      return res.redirect('/driver?err=Invalid%20document%20key#docs');
    }
    const driver = await Driver.findById(req.user._id);
    if (!driver) return res.redirect('/driver?err=Driver%20not%20found#docs');

    const url = driver.documents?.[key];
    if (!url) {
      return res.redirect('/driver?err=Document%20not%20found#docs');
    }

    const { publicId, resourceType } = extractCloudinaryInfo(url);
    if (publicId) {
      try { await cloudinary.uploader.destroy(publicId, { resource_type: resourceType }); }
      catch (e) { console.warn('Cloudinary destroy failed (continuing):', e?.message || e); }
    }

    if (driver.documents?.set) driver.documents.set(key, undefined);
    await Driver.updateOne({ _id: driver._id }, { $unset: { [`documents.${key}`]: "" } });

    return res.redirect('/driver?ok=' + encodeURIComponent(`${key} deleted`) + '#docs');
  } catch (err) {
    console.error('Delete doc error:', err);
    return res.redirect('/driver?err=Failed%20to%20delete%20document#docs');
  }
});

/* ---------------- Vehicle quick setup ---------------- */
router.post('/vehicle', ensureAuth, async (req, res) => {
  try {
    const allowed = ['normal', 'comfort', 'luxury', 'xl'];
    const vehicleType = String(req.body.vehicleType || '').toLowerCase();
    if (!allowed.includes(vehicleType)) {
      return res.redirect('/driver?err=Invalid%20vehicle%20type');
    }
    await Driver.findByIdAndUpdate(req.user._id, { vehicleType });
    return res.redirect('/driver?ok=Vehicle%20updated');
  } catch (err) {
    console.error('Vehicle update error:', err);
    return res.redirect('/driver?err=Server%20error');
  }
});

/* ---------------- Banking: save ---------------- */
router.post('/banking', ensureAuth, async (req, res) => {
  try {
    const fields = {
      accountHolder: String(req.body.accountHolder || '').trim(),
      bankName:      String(req.body.bankName || '').trim(),
      accountType:   String(req.body.accountType || '').trim(),
      accountNumber: String(req.body.accountNumber || '').replace(/\D/g, ''),
      branchCode:    String(req.body.branchCode || '').replace(/\D/g, ''),
      swift:         String(req.body.swift || '').trim().toUpperCase()
    };

    // Basic validation
    if (!fields.accountHolder || !fields.bankName || !fields.accountType || !fields.accountNumber || !fields.branchCode) {
      return res.redirect('/driver?err=' + encodeURIComponent('Please complete all required banking fields.'));
    }
    if (!/^\d{6,17}$/.test(fields.accountNumber)) {
      return res.redirect('/driver?err=' + encodeURIComponent('Invalid account number format.'));
    }
    if (!/^\d{6}$/.test(fields.branchCode)) {
      return res.redirect('/driver?err=' + encodeURIComponent('Branch code must be 6 digits.'));
    }
    if (fields.swift && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(fields.swift)) {
      return res.redirect('/driver?err=' + encodeURIComponent('SWIFT/BIC must be 8 or 11 characters.'));
    }

    await Driver.updateOne(
      { _id: req.user._id },
      { $set: { banking: { ...fields, updatedAt: new Date() } } }
    );

    return res.redirect('/driver?ok=' + encodeURIComponent('Thank you for submitting your banking details.'));
  } catch (e) {
    console.error('Banking save error:', e);
    return res.redirect('/driver?err=' + encodeURIComponent('Failed to save banking details.'));
  }
});

/* ---------------- Logout ---------------- */
router.post('/logout', ensureAuth, (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session?.destroy(() => res.redirect('/driver/login'));
  });
});

export default router;
