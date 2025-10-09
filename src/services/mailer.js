// src/services/mailer.js
import nodemailer from 'nodemailer';
import 'dotenv/config';

/* -------------------------------- constants -------------------------------- */
const LOGO_URL =
  'https://res.cloudinary.com/darf17drw/image/upload/v1752064092/Untitled_design_2_wilxrl.png';

const SMTP = {
  host: (process.env.EMAIL_HOST || 'mail.vayaride.co.za').trim(),
  port: Number(process.env.EMAIL_PORT || 465),
  user: (process.env.EMAIL_USER || '').trim(),
  pass: (process.env.EMAIL_PASS || '').trim(),
};
const SECURE = SMTP.port === 465; // SSL on 465
const FROM_NAME = (process.env.EMAIL_FROM_NAME || 'VayaRide').trim();
const PUBLIC_URL = ((process.env.PUBLIC_URL || 'https://www.vayaride.co.za').trim()).replace(/\/$/, '');
const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || 'admin@vayaride.co.za').trim();

/* --------------------------------- helpers --------------------------------- */
const maskEmail = (e = '') =>
  typeof e === 'string' && e.includes('@')
    ? e.replace(/^(.).+(@.+)$/, (_, a, b) => `${a}***${b}`)
    : e;

const stripHtml = (html = '') =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const fromHeader = () => `"${FROM_NAME}" <${SMTP.user}>`;

/* ------------------------------ transporter init --------------------------- */
console.log('📧 Mailer:', {
  host: SMTP.host,
  port: SMTP.port,
  user: maskEmail(SMTP.user),
  secure: SECURE,
});

const transporter = nodemailer.createTransport({
  host: SMTP.host,
  port: SMTP.port,
  secure: SECURE,
  requireTLS: !SECURE, // for 587 STARTTLS
  auth: { user: SMTP.user, pass: SMTP.pass },
  tls: { minVersion: 'TLSv1.2', servername: SMTP.host },
  logger: true,  // extra transport logs (useful during setup)
  debug: true,   // verbose output
});

(async () => {
  try {
    console.log('🔌 Verifying SMTP transport…');
    const ok = await transporter.verify();
    console.log('✅ SMTP transport ready:', ok === true ? true : ok);
  } catch (err) {
    console.error('❌ SMTP verify failed:', {
      message: err?.message,
      code: err?.code,
      command: err?.command,
      responseCode: err?.responseCode,
    });
  }
})();

/* ------------------------------ base template ------------------------------ */
function wrapEmail({
  title = 'VayaRide',
  preheader = '',
  heading = '',
  subheading = '',
  bodyHtml = '',
  pillHtml = '',
  ctaText,
  ctaHref,
  footerNote = '',
}) {
  const cta = ctaText && ctaHref
    ? `<p><a class="cta" href="${ctaHref}" target="_blank" rel="noopener">${ctaText}</a></p>`
    : '';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
  <span style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;color:#fff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    ${preheader}
  </span>
  <style>
    /* Reset-ish */
    body { margin:0;background:#f6f7fb;font-family:Arial,Helvetica,sans-serif; }
    img { border:0; outline:none; text-decoration:none; }
    table { border-collapse:collapse; }
    /* Colors & typography */
    body, h1, p, li, a { color:#111; }
    a, a:link, a:visited, a:hover, a:active { color:#111 !important; text-decoration:none; }
    .wrap { padding:24px; }
    .card { max-width:640px;margin:0 auto;background:#fff;border:2px solid #000;border-radius:14px; }
    .inner { padding:24px 28px; }
    .logo { width:90px;height:90px;border-radius:50%;border:2px solid #000;display:block;margin:18px auto 12px; }
    h1 { margin:8px 0 6px;font-size:22px;text-align:center; }
    .sub { margin:0 0 14px;text-align:center;color:#333;font-size:14px; }
    hr.rule { border:none;border-top:2px solid #000;margin:14px 0; }
    .pill { display:inline-block;border:2px solid #000;border-radius:999px;padding:8px 12px;font-weight:700;margin:8px 0; }
    .blk { background:#000;color:#fff;border-radius:12px;margin:18px 0;padding:18px; }
    .blk h2 { margin:0 0 10px;font-size:16px;color:#fff; }
    .blk, .blk p, .blk li, .blk a, .blk a:visited { color:#fff !important; }
    ul { margin:0;padding-left:18px; }
    .cta { display:inline-block;margin-top:12px;padding:12px 16px;background:#000;color:#fff !important;text-decoration:none;border-radius:10px;border:2px solid #000;font-weight:700 }
    .footer { padding:12px 18px 18px;text-align:center;color:#555;font-size:12px }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <img class="logo" src="${LOGO_URL}" alt="VayaRide"/>
      <div class="inner">
        ${heading ? `<h1>${heading}</h1>` : ''}
        ${subheading ? `<p class="sub">${subheading}</p>` : ''}
        ${heading || subheading ? '<hr class="rule"/>' : ''}
        ${pillHtml || ''}
        ${bodyHtml}
        ${cta}
        <div class="footer">
          © ${new Date().getFullYear()} VayaRide — Let’s move the city together.
          ${footerNote ? `<br>${footerNote}` : ''}
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/* ================================= EMAILS ================================== */

/** Driver Welcome (signup) */
export async function sendDriverWelcomeEmail(
  driverEmail,
  { name = 'Driver', vehicleType } = {}
) {
  if (!driverEmail) return;

  const vt =
    vehicleType === 'comfort' ? 'VayaRide • Comfort' :
    vehicleType === 'luxury'  ? 'VayaRide • Luxury'  :
    vehicleType === 'xl'      ? 'VayaRide • XL'      : 'VayaRide • Normal';

  const dashboardUrl = `${PUBLIC_URL}/driver`;

  const html = wrapEmail({
    title: 'Welcome to VayaRide',
    preheader: 'Welcome aboard — let’s get you approved.',
    heading: `Welcome aboard, ${name}!`,
    subheading: 'Your journey with VayaRide starts now.',
    pillHtml: `<p class="pill"><strong>Selected vehicle type:</strong> ${vt}</p>`,
    bodyHtml: `
      <div class="blk">
        <h2>Next steps to get approved</h2>
        <ul>
          <li>Log in to your dashboard</li>
          <li>Upload required documents (ID, driver’s licence, vehicle docs)</li>
          <li>Set your availability</li>
        </ul>
      </div>
    `,
    ctaText: 'Open Driver Dashboard',
    ctaHref: dashboardUrl,
  });

  const text = stripHtml(
    `Welcome aboard, ${name}! Your journey with VayaRide starts now.
Selected vehicle type: ${vt}
Next steps: 1) Log in to your dashboard 2) Upload documents 3) Set your availability
Open Driver Dashboard: ${dashboardUrl}`
  );

  try {
    const info = await transporter.sendMail({
      from: fromHeader(),
      to: driverEmail,
      subject: 'Welcome to VayaRide — Your Driver Account',
      html,
      text,
    });
    console.log('✅ Welcome email sent:', { messageId: info?.messageId, to: maskEmail(driverEmail) });
  } catch (err) {
    console.error('❌ Error sending driver welcome email:', err?.message || err);
  }
}

/** Admin alert when a new driver registers (includes phone + admin link) */
export async function sendAdminNewDriverAlert({
  name = '',
  email = '',
  phone = '',
  vehicleType = '',
  createdAt = new Date(),
  dashboardUrl = '',
} = {}) {
  const toAdmin = (process.env.ADMIN_EMAIL || '').trim() || SMTP.user || SUPPORT_EMAIL;
  if (!toAdmin) return;

  const adminDriversUrl = dashboardUrl || `${PUBLIC_URL}/admin/drivers`;

  const html = wrapEmail({
    title: 'New Driver Registration',
    preheader: `New driver: ${name}`,
    heading: 'New Driver Registration',
    subheading: '<strong>VayaRide</strong>',
    bodyHtml: `
      <div class="blk">
        <h2>Details</h2>
        <ul>
          <li><strong>Name:</strong> ${name}</li>
          <li><strong>Email:</strong> ${email}</li>
          <li><strong>Phone:</strong> ${phone || '—'}</li>
          <li><strong>Vehicle Type:</strong> ${vehicleType || '—'}</li>
          <li><strong>Created:</strong> ${new Date(createdAt).toLocaleString()}</li>
          <li><strong>Status:</strong> pending</li>
        </ul>
      </div>
    `,
    ctaText: 'Open Driver Admin',
    ctaHref: adminDriversUrl,
  });

  const text = stripHtml(
    `New Driver Registration
Name: ${name}
Email: ${email}
Phone: ${phone || '—'}
Vehicle Type: ${vehicleType || '—'}
Created: ${new Date(createdAt).toLocaleString()}
Open Driver Admin: ${adminDriversUrl}`
  );

  try {
    const info = await transporter.sendMail({
      from: fromHeader(),
      to: toAdmin,
      subject: 'VayaRide: New Driver Registration',
      html,
      text,
    });
    console.log('✅ Admin alert sent:', { messageId: info?.messageId, to: maskEmail(toAdmin) });
  } catch (err) {
    console.error('❌ Error sending admin alert:', err?.message || err);
  }
}

/** Rider Welcome (first-time registration) */
export async function sendRiderWelcomeEmail(riderEmail, { name = 'Rider' } = {}) {
  if (!riderEmail) return;

  const dashboardUrl = `${PUBLIC_URL}/rider-dashboard.html`;

  const html = wrapEmail({
    title: 'Welcome to VayaRide',
    preheader: 'Thanks for registering — let’s get you moving.',
    heading: `Welcome, ${name}!`,
    subheading: 'Thanks for registering with VayaRide.',
    bodyHtml: `
      <p>We’re excited to have you onboard. You can view your profile and manage payment from your dashboard.</p>
      <div class="blk">
        <h2>What’s next?</h2>
        <ul>
          <li>Open your rider dashboard</li>
          <li>Add payment details (optional)</li>
          <li>Book your first ride anytime</li>
        </ul>
      </div>
    `,
    ctaText: 'Open Rider Dashboard',
    ctaHref: dashboardUrl,
  });

  const text = stripHtml(
    `Welcome, ${name}! Thanks for registering with VayaRide.
Open Rider Dashboard: ${dashboardUrl}`
  );

  try {
    const info = await transporter.sendMail({
      from: fromHeader(),
      to: riderEmail,
      subject: 'Welcome to VayaRide — Your Rider Account',
      html,
      text,
    });
    console.log('✅ Rider welcome email sent:', { messageId: info?.messageId, to: maskEmail(riderEmail) });
  } catch (err) {
    console.error('❌ Error sending rider welcome email:', err?.message || err);
  }
}

/** Admin alert when a new rider registers */
export async function sendAdminNewRiderAlert({
  name = '',
  email = '',
  phone = '',
  platform = 'unknown',
  createdAt = new Date(),
  dashboardUrl = '',
} = {}) {
  const toAdmin = (process.env.ADMIN_EMAIL || '').trim() || SMTP.user || SUPPORT_EMAIL;
  if (!toAdmin) return;

  const adminRidersUrl = dashboardUrl || `${PUBLIC_URL}/admin/riders`;

  const html = wrapEmail({
    title: 'New Rider Registration',
    preheader: `New rider: ${name}`,
    heading: 'New Rider Registration',
    subheading: '<strong>VayaRide</strong>',
    bodyHtml: `
      <div class="blk">
        <h2>Details</h2>
        <ul>
          <li><strong>Name:</strong> ${name}</li>
          <li><strong>Email:</strong> ${email}</li>
          <li><strong>Phone:</strong> ${phone || '—'}</li>
          <li><strong>Platform:</strong> ${platform}</li>
          <li><strong>Created:</strong> ${new Date(createdAt).toLocaleString()}</li>
          <li><strong>Status:</strong> active</li>
        </ul>
      </div>
    `,
    ctaText: 'Open Rider Admin',
    ctaHref: adminRidersUrl,
  });

  const text = stripHtml(
    `New Rider Registration
Name: ${name}
Email: ${email}
Phone: ${phone || '—'}
Platform: ${platform}
Created: ${new Date(createdAt).toLocaleString()}
Open Rider Admin: ${adminRidersUrl}`
  );

  try {
    const info = await transporter.sendMail({
      from: fromHeader(),
      to: toAdmin,
      subject: 'VayaRide: New Rider Registration',
      html,
      text,
    });
    console.log('✅ Admin rider alert sent:', { messageId: info?.messageId, to: maskEmail(toAdmin) });
  } catch (err) {
    console.error('❌ Error sending admin rider alert:', err?.message || err);
  }
}

/** Rider payment receipt */
export async function sendPaymentReceiptEmail(riderEmail, paymentDetails) {
  if (!riderEmail) return;
  const { amount = 0, paymentMethod = '—', paidAt } = paymentDetails || {};

  const html = wrapEmail({
    title: 'Payment Receipt',
    preheader: 'Your VayaRide payment receipt.',
    heading: 'Payment Receipt',
    subheading: '<strong>VayaRide</strong>',
    bodyHtml: `
      <p>Thank you for your payment! Here are the details of your trip:</p>
      <div class="blk">
        <h2>Payment Details</h2>
        <ul>
          <li><strong>Amount Paid:</strong> R${Number(amount).toFixed(2)}</li>
          <li><strong>Payment Method:</strong> ${paymentMethod}</li>
          <li><strong>Paid On:</strong> ${new Date(paidAt || Date.now()).toLocaleString()}</li>
          <li><strong>Status:</strong> Completed</li>
        </ul>
      </div>
    `,
  });

  const text = stripHtml(
    `Payment Receipt — VayaRide
Amount Paid: R${Number(amount).toFixed(2)}
Payment Method: ${paymentMethod}
Paid On: ${new Date(paidAt || Date.now()).toLocaleString()}
Status: Completed`
  );

  try {
    const info = await transporter.sendMail({
      from: fromHeader(),
      to: riderEmail,
      subject: 'Payment Receipt for Your VayaRide Trip',
      html,
      text,
    });
    console.log('✅ Receipt email sent:', { messageId: info?.messageId, to: maskEmail(riderEmail) });
  } catch (err) {
    console.error('❌ Error sending payment receipt email:', err?.message || err);
  }
}

/** Rider payment failed/cancelled */
export async function sendPaymentFailedEmail(riderEmail, details = {}) {
  if (!riderEmail) return;
  const { amount = 0, reason = 'Your payment was not completed.' } = details;

  const html = wrapEmail({
    title: 'Payment Not Completed',
    preheader: 'Your payment was not completed.',
    heading: 'Payment Not Completed',
    subheading: '<strong>VayaRide</strong>',
    bodyHtml: `
      <p>${reason}</p>
      <div class="blk">
        <h2>Details</h2>
        <ul>
          <li><strong>Attempted Amount:</strong> R${Number(amount).toFixed(2)}</li>
          <li><strong>Status:</strong> Failed/Cancelled</li>
        </ul>
      </div>
    `,
  });

  const text = stripHtml(
    `Payment Not Completed — VayaRide
Reason: ${reason}
Attempted Amount: R${Number(amount).toFixed(2)}
Status: Failed/Cancelled`
  );

  try {
    const info = await transporter.sendMail({
      from: fromHeader(),
      to: riderEmail,
      subject: 'Your VayaRide Payment Was Not Completed',
      html,
      text,
    });
    console.log('✅ Failure email sent:', { messageId: info?.messageId, to: maskEmail(riderEmail) });
  } catch (err) {
    console.error('❌ Error sending failed payment email:', err?.message || err);
  }
}

/** Admin → Drivers: bulk/targeted announcement */
export async function sendAdminEmailToDrivers(recipients, subjectOrOptions, htmlMaybe) {
  const list = Array.isArray(recipients) ? recipients.filter(Boolean) : [recipients].filter(Boolean);
  if (!list.length) return { sent: 0, failed: 0, results: [] };

  let subject = 'VayaRide Announcement';
  let html = '';
  let text = '';

  if (typeof subjectOrOptions === 'string') {
    subject = subjectOrOptions || subject;
    html = htmlMaybe || '';
  } else if (subjectOrOptions && typeof subjectOrOptions === 'object') {
    subject = subjectOrOptions.subject || subject;
    html = subjectOrOptions.html || '';
    text = subjectOrOptions.text || '';
  }

  if (!html && text) {
    html = `<pre style="font-family:inherit;white-space:pre-wrap;margin:0">${text}</pre>`;
  }
  if (!html && !text) {
    html = `<p>Hello from VayaRide.</p>`;
    text = 'Hello from VayaRide.';
  }

  const wrappedHtml = wrapEmail({
    title: subject,
    preheader: stripHtml(html).slice(0, 120),
    heading: subject,
    bodyHtml: html,
  });
  const wrappedText = stripHtml(html);

  const results = [];
  let sent = 0;
  let failed = 0;

  for (const to of list) {
    try {
      const info = await transporter.sendMail({
        from: fromHeader(),
        to,
        subject,
        html: wrappedHtml,
        text: wrappedText,
      });
      results.push({ to, messageId: info?.messageId, ok: true });
      sent += 1;
      console.log('📨 Admin mail ->', maskEmail(to), info?.messageId || 'ok');
    } catch (err) {
      results.push({ to, ok: false, error: err?.message || String(err) });
      failed += 1;
      console.error('❌ Admin mail failed for', maskEmail(to), ':', err?.message || err);
    }
  }

  return { sent, failed, results };
}
