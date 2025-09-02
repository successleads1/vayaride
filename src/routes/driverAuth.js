// src/routes/driverAuth.js
import express from 'express';
import bcrypt from 'bcrypt';
import passport from 'passport';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import stream from 'stream';
import sharp from 'sharp';
import Driver from '../models/Driver.js';
import { sendDriverWelcomeEmail } from '../services/mailer.js'; // ← ⭐ makes the email

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

/* ---------- Helpers ---------- */
const ensureAuth = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.redirect('/driver/login');
};

const ensureGuest = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) return res.redirect('/driver');
  return next();
};

const getPublicUrl = (req) =>
  (process.env.PUBLIC_URL && process.env.PUBLIC_URL.replace(/\/$/, '')) ||
  `${req.protocol}://${req.get('host')}`;

function uploadBufferToCloudinary(buffer, folder, filenameHint) {
  return new Promise((resolve, reject) => {
    const passthrough = new stream.PassThrough();
    passthrough.end(buffer);

    const options = {
      folder,
      resource_type: 'auto',
      public_id: filenameHint?.replace(/\W+/g, '_') || undefined
    };

    const cldStream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });

    passthrough.pipe(cldStream);
  });
}

async function compressIfImage(file) {
  if (!file || !file.mimetype?.startsWith('image/')) return file.buffer;
  const out = await sharp(file.buffer)
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return out;
}

// Same keys used by the dashboard
const DOC_FIELDS = [
  { name: 'driverProfilePhoto',   maxCount: 1 },
  { name: 'vehiclePhoto',         maxCount: 1 },
  { name: 'idDocument',           maxCount: 1 },
  { name: 'vehicleRegistration',  maxCount: 1 },
  { name: 'driversLicense',       maxCount: 1 },
  { name: 'insuranceCertificate', maxCount: 1 },
  { name: 'pdpOrPsv',             maxCount: 1 },
  { name: 'dekraCertificate',     maxCount: 1 },
  { name: 'policeClearance',      maxCount: 1 },
  { name: 'licenseDisc',          maxCount: 1 }
];
const DOC_KEYS = DOC_FIELDS.map(f => f.name);

const router = express.Router();

/* ---------------- Register ---------------- */
router.get('/register', ensureGuest, (req, res) => {
  res.render('driver/register', {
    error: req.query.err || null,     // normalize to "error" for the EJS
    publicUrl: getPublicUrl(req),
    form: {}                          // optional initial form state
  });
});

router.post('/register', ensureGuest, async (req, res) => {
  try {
    // normalize/trim inputs
    const nameRaw = (req.body.name || '').trim();
    const emailRaw = (req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const confirm  = String(req.body.confirm || '');
    const vehicleTypeRaw = String(req.body.vehicleType || '').toLowerCase();

    const publicUrl = getPublicUrl(req);
    const keep = { name: nameRaw, email: emailRaw, vehicleType: vehicleTypeRaw };

    // basic validation
    if (!nameRaw || !emailRaw || !password || !confirm || !vehicleTypeRaw) {
      return res.status(200).render('driver/register', {
        error: 'Missing fields',
        publicUrl,
        form: keep
      });
    }
    if (password !== confirm) {
      return res.status(200).render('driver/register', {
        error: 'Passwords do not match',
        publicUrl,
        form: keep
      });
    }

    // allowlisted vehicle types
    const allowedVehicles = ['normal', 'comfort', 'luxury', 'xl'];
    if (!allowedVehicles.includes(vehicleTypeRaw)) {
      return res.status(200).render('driver/register', {
        error: 'Invalid vehicle type',
        publicUrl,
        form: keep
      });
    }

    // unique email
    const existing = await Driver.findOne({ email: emailRaw });
    if (existing) {
      return res.status(200).render('driver/register', {
        error: 'Email already in use',
        publicUrl,
        form: keep
      });
    }

    // hash + create
    const passwordHash = await bcrypt.hash(password, 10);
    const created = await Driver.create({
      name: nameRaw,
      email: emailRaw,
      passwordHash,
      vehicleType: vehicleTypeRaw,
      status: 'pending',
      isAvailable: false
    });

    // send welcome email (non-fatal if it fails)
    try {
      await sendDriverWelcomeEmail(emailRaw, { name: nameRaw, vehicleType: vehicleTypeRaw });
    } catch (e) {
      console.error('Welcome email failed:', e?.message || e);
    }

    // redirect to login with email prefilled
    return res.redirect(`/driver/login?email=${encodeURIComponent(emailRaw)}`);
  } catch (err) {
    console.error('Register error:', err?.message || err);
    return res.status(500).render('driver/register', {
      error: 'Server error',
      publicUrl: getPublicUrl(req),
      form: {
        name: (req.body?.name || '').trim(),
        email: (req.body?.email || '').trim().toLowerCase()
      }
    });
  }
});

/* ---------------- Login ---------------- */
router.get('/login', ensureGuest, (req, res) => {
  res.render('driver/login', {
    email: req.query.email || '',
    publicUrl: getPublicUrl(req)   // not strictly needed, but harmless
  });
});

router.post(
  '/login',
  ensureGuest,
  passport.authenticate('local-driver', { failureRedirect: '/driver/login' }),
  (req, res) => res.redirect('/driver')
);

/* ---------------- Dashboard ---------------- */
router.get('/', ensureAuth, async (req, res) => {
  const fresh = await Driver.findById(req.user._id).lean();
  res.render('driver/dashboard', {
    user: fresh,
    ok: req.query.ok || '',
    err: req.query.err || ''
  });
});

// “Upload Docs” link jumps to the form
router.get('/upload-docs', ensureAuth, (req, res) => res.redirect('/driver#docsForm'));

/* ---------------- Upload Docs ---------------- */
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
    // pathname like: /<cloud>/image/upload/v123/dir1/dir2/filename.ext
    const parts = u.pathname.split('/'); // ['', '<cloud>', 'image', 'upload', 'v123', 'dir', 'file.jpg']
    const resourceType = parts[2] || 'image'; // 'image' or 'raw'
    const uploadIdx = parts.indexOf('upload');
    let after = parts.slice(uploadIdx + 1).join('/'); // v123/dir/file.jpg
    if (after.startsWith('v') && after[1] >= '0' && after[1] <= '9') {
      after = after.split('/').slice(1).join('/'); // drop version
    }
    // strip query and extension
    const last = after.split('/').pop() || '';
    const withoutExt = last.includes('.') ? last.substring(0, last.lastIndexOf('.')) : last;
    const before = after.split('/').slice(0, -1).join('/');
    const publicId = before ? `${before}/${withoutExt}` : withoutExt;

    // PDFs are usually resource_type=raw; images are 'image'
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
      try {
        await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
      } catch (e) {
        // Not fatal—still remove pointer from DB
        console.warn('Cloudinary destroy failed (continuing):', e?.message || e);
      }
    }

    // Unset from Mongo
    driver.documents.set
      ? driver.documents.set(key, undefined)
      : delete driver.documents[key];
    // Make sure undefined keys don’t linger as null-ish
    await Driver.updateOne(
      { _id: driver._id },
      { $unset: { [`documents.${key}`]: "" } }
    );

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

/* ---------------- Logout ---------------- */
router.post('/logout', ensureAuth, (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session?.destroy(() => res.redirect('/driver/login'));
  });
});

export default router;
