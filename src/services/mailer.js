// src/services/mailer.js
import nodemailer from 'nodemailer';
import 'dotenv/config';

// ---- helpers (no secrets logged) ----
const maskEmail = (e = '') =>
  typeof e === 'string' && e.includes('@')
    ? e.replace(/^(.).+(@.+)$/, (_, a, b) => `${a}***${b}`)
    : e;

console.log('📧 Mailer env check:', {
  EMAIL_USER_present: !!process.env.EMAIL_USER,
  EMAIL_PASS_present: !!process.env.EMAIL_PASS,
});

// ---- transporter ----
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// verify the connection once on boot
try {
  console.log('🔌 Verifying SMTP transport...');
  const ok = await transporter.verify();
  console.log('✅ SMTP transport ready:', ok);
} catch (err) {
  console.error('❌ SMTP verify failed:', err?.message || err, err?.stack ? '\n' + err.stack : '');
}

/**
 * Send a payment receipt email (rider)
 * @param {string} riderEmail - required
 * @param {{ amount:number, paymentMethod:string, paidAt:Date }} paymentDetails
 */
export async function sendPaymentReceiptEmail(riderEmail, paymentDetails) {
  if (!riderEmail) {
    console.warn('❌ No riderEmail provided, skipping receipt email.');
    return;
  }

  const { amount, paymentMethod, paidAt } = paymentDetails || {};
  console.log('✉️ sendPaymentReceiptEmail ->', {
    to: maskEmail(riderEmail),
    amount: Number(amount || 0),
    paymentMethod: paymentMethod || '—',
    paidAt: paidAt ? new Date(paidAt).toISOString() : null,
  });

  const emailHtml = `
    <!doctype html>
    <html><head><meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>Payment Receipt - VayaRide</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;background:#fff;color:#000;margin:0}
      .wrap{max-width:600px;margin:0 auto;padding:24px}
      .card{border:2px solid #000;border-radius:14px;padding:24px}
      .header{text-align:center;padding-bottom:16px;border-bottom:2px solid #000}
      .logo{width:90px;height:90px;border-radius:50%;border:2px solid #000;display:block;margin:0 auto}
      h1{margin:14px 0 0;font-size:22px}
      .receipt{margin:16px 0;padding:8px;border:2px solid #000;text-align:center;font-weight:700}
      .blk{background:#000;color:#fff;border-radius:12px;margin-top:20px;padding:16px}
      .blk h2{margin:0 0 10px;font-size:16px}
      ul{margin:0;padding-left:18px}
      .footer{margin-top:18px;text-align:center;font-size:12px;color:#555}
    </style></head>
    <body>
      <div class="wrap">
        <div class="card">
          <div class="header">
            <img class="logo" src="https://res.cloudinary.com/darf17drw/image/upload/v1752064092/Untitled_design_2_wilxrl.png" alt="VayaRide"/>
            <h1>Payment Receipt</h1>
            <p><strong>VayaRide</strong></p>
          </div>

          <div class="receipt">Receipt #: VR-${Date.now()}</div>
          <p>Thank you for your payment! Here are the details of your trip:</p>

          <div class="blk">
            <h2>Payment Details</h2>
            <ul>
              <li><strong>Amount Paid:</strong> R${Number(amount || 0).toFixed(2)}</li>
              <li><strong>Payment Method:</strong> ${paymentMethod || '—'}</li>
              <li><strong>Paid On:</strong> ${new Date(paidAt || Date.now()).toLocaleString()}</li>
              <li><strong>Status:</strong> Completed</li>
            </ul>
          </div>

          <div class="footer">
            © ${new Date().getFullYear()} VayaRide — All Rights Reserved
          </div>
        </div>
      </div>
    </body></html>
  `;

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: riderEmail,
    subject: 'Payment Receipt for Your VayaRide Trip',
    html: emailHtml,
  };

  try {
    console.log('📨 Sending email (receipt) to', maskEmail(mailOptions.to), 'subject:', mailOptions.subject);
    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Receipt email sent:', { messageId: info?.messageId, to: maskEmail(riderEmail) });
  } catch (error) {
    console.error('❌ Error sending payment receipt email:', error?.message || error, error?.stack ? '\n' + error.stack : '');
  }
}

/**
 * Send a welcome email (driver)
 * @param {string} driverEmail - required
 * @param {{ name?: string, vehicleType?: 'normal'|'comfort'|'luxury'|'xl' }} [opts]
 */
export async function sendDriverWelcomeEmail(driverEmail, opts = {}) {
  if (!driverEmail) {
    console.warn('❌ No driverEmail provided, skipping welcome email.');
    return;
  }

  const { name = 'Driver', vehicleType } = opts;
  const baseUrl = process.env.PUBLIC_URL || 'http://localhost:3000';
  const supportEmail = process.env.SUPPORT_EMAIL || 'support@vayaride.com';

  const vt =
    vehicleType === 'comfort' ? 'VayaRide • Comfort' :
    vehicleType === 'luxury'  ? 'VayaRide • Luxury'  :
    vehicleType === 'xl'      ? 'VayaRide • XL'      :
                                 'VayaRide • Normal';

  console.log('✉️ sendDriverWelcomeEmail ->', {
    to: maskEmail(driverEmail),
    name,
    vehicleType: vt,
    baseUrl,
  });

  const emailHtml = `
    <!doctype html>
    <html><head><meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>Welcome to VayaRide</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;background:#fff;color:#000;margin:0}
      .wrap{max-width:620px;margin:0 auto;padding:24px}
      .card{border:2px solid #000;border-radius:14px;padding:24px}
      .header{text-align:center;padding-bottom:16px;border-bottom:2px solid #000}
      .logo{width:100px;height:100px;border-radius:50%;border:2px solid #000;display:block;margin:0 auto}
      h1{margin:14px 0 4px;font-size:24px}
      .sub{color:#333;margin:0 0 12px}
      .cta{display:inline-block;padding:12px 18px;background:#000;color:#fff;text-decoration:none;border-radius:10px;border:2px solid #000;font-weight:700}
      .blk{background:#000;color:#fff;border-radius:12px;margin-top:20px;padding:16px}
      .blk h2{margin:0 0 10px;font-size:16px}
      ul{margin:0;padding-left:18px}
      .pill{display:inline-block;border:2px solid #000;border-radius:999px;padding:6px 10px;margin-top:10px}
      .footer{margin-top:18px;text-align:center;font-size:12px;color:#555}
    </style></head>
    <body>
      <div class="wrap">
        <div class="card">
          <div class="header">
            <img class="logo" src="https://res.cloudinary.com/darf17drw/image/upload/v1752064092/Untitled_design_2_wilxrl.png" alt="VayaRide"/>
            <h1>Welcome aboard, ${name}!</h1>
            <p class="sub">Your journey with VayaRide starts now.</p>
          </div>

          <p>Thanks for creating your driver account. We’re excited to have you on the platform.</p>
          <p class="pill"><strong>Selected vehicle type:</strong> ${vt}</p>

          <div class="blk">
            <h2>Next steps to get approved</h2>
            <ul>
              <li>Log in to your dashboard</li>
              <li>Upload required documents (ID, driver’s licence, vehicle docs)</li>
              <li>Set your availability</li>
            </ul>
          </div>

          <p style="margin:18px 0;">
            <a class="cta" href="${baseUrl}/driver/login" target="_blank" rel="noopener">Open Driver Dashboard</a>
          </p>

          <p>If you need help at any time, reply to this email or contact us at <strong>${supportEmail}</strong>.</p>

          <div class="footer">
            © ${new Date().getFullYear()} VayaRide — Let’s move the city together.
          </div>
        </div>
      </div>
    </body></html>
  `;

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: driverEmail,
    subject: 'Welcome to VayaRide — Your Driver Account',
    html: emailHtml,
  };

  try {
    console.log('📨 Sending email (welcome) to', maskEmail(mailOptions.to), 'subject:', mailOptions.subject);
    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Welcome email sent:', { messageId: info?.messageId, to: maskEmail(driverEmail) });
  } catch (error) {
    console.error('❌ Error sending driver welcome email:', error?.message || error, error?.stack ? '\n' + error.stack : '');
  }
}
