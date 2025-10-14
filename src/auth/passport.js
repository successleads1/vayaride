import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import bcrypt from 'bcrypt';
import Driver from '../models/Driver.js';
import Admin from '../models/Admin.js';

// ---- serialize BOTH kinds of users ----
passport.serializeUser((user, done) => {
  try {
    const type = user.constructor?.modelName; // "Driver" or "Admin"
    done(null, { type, id: user._id.toString() });
  } catch (err) {
    done(err);
  }
});

passport.deserializeUser(async (payload, done) => {
  try {
    if (!payload?.type || !payload?.id) return done(null, false);
    if (payload.type === 'Driver') {
      const user = await Driver.findById(payload.id);
      return done(null, user || false);
    }
    if (payload.type === 'Admin') {
      const user = await Admin.findById(payload.id);
      return done(null, user || false);
    }
    return done(null, false);
  } catch (err) {
    done(err);
  }
});

// ---- DRIVER strategy ----
passport.use('local-driver', new LocalStrategy(
  { usernameField: 'email', passwordField: 'password' },
  async (email, password, done) => {
    try {
      const driver = await Driver.findOne({ email });
      if (!driver) return done(null, false, { message: 'Invalid credentials' });
      const ok = await bcrypt.compare(password, driver.passwordHash || '');
      if (!ok) return done(null, false, { message: 'Invalid credentials' });
      return done(null, driver);
    } catch (e) {
      return done(e);
    }
  }
));

// ---- ADMIN strategy ----
passport.use('local-admin', new LocalStrategy(
  { usernameField: 'email', passwordField: 'password' },
  async (email, password, done) => {
    try {
      const admin = await Admin.findOne({ email });
      if (!admin) return done(null, false, { message: 'Invalid credentials' });
      const ok = await bcrypt.compare(password, admin.passwordHash || '');
      if (!ok) return done(null, false, { message: 'Invalid credentials' });
      return done(null, admin);
    } catch (e) {
      return done(e);
    }
  }
));

export default passport;
