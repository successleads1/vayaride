// import nodemailer from 'nodemailer';
// import 'dotenv/config'; // To load environment variables from .env file

// // Create reusable transporter object using the default SMTP transport
// const transporter = nodemailer.createTransport({
//   service: 'gmail',
//   auth: {
//     user: process.env.EMAIL_USER,
//     pass: process.env.EMAIL_PASS
//   }
// });

// async function sendPaymentReceiptEmail(riderEmail, paymentDetails) {
//   const { amount, paymentMethod, paidAt } = paymentDetails;

//   // Set recipient email here (using riderEmail if available)
//   const recipientEmail = riderEmail || 'draglearnn@gmail.com'; // Default to hardcoded recipient email

//   // Email HTML content with dynamic data
//   const emailHtml = `
//     <!DOCTYPE html>
//     <html lang="en">
//     <head>
//       <meta charset="UTF-8">
//       <meta name="viewport" content="width=device-width, initial-scale=1.0">
//       <title>Payment Receipt - VayaRide</title>
//       <style>
//         body {
//           font-family: 'Arial', sans-serif;
//           background-color: #fff;
//           color: #000;
//           margin: 0;
//           padding: 0;
//         }

//         .email-container {
//           max-width: 600px;
//           margin: 0 auto;
//           background-color: #fff;
//           padding: 20px;
//           border: 2px solid #000;
//           border-radius: 15px;
//         }

//         .header {
//           text-align: center;
//           margin-bottom: 30px;
//           border-bottom: 2px solid #000;
//           padding: 30px 20px;
//           border-radius: 10px;
//           background-color: #fff;
//         }

//         .header-logo {
//           width: 100px;
//           height: 100px;
//           border-radius: 50%;
//           margin: 0 auto;
//           display: block;
//           border: 2px solid #000;
//         }

//         h1 {
//           font-size: 28px;
//           color: #000;
//           margin: 20px 0 15px 0;
//           font-weight: bold;
//           text-transform: uppercase;
//         }

//         p {
//           font-size: 16px;
//           line-height: 1.5;
//           color: #000;
//         }

//         .download-pdf {
//           text-align: center;
//           margin: 20px 0;
//           padding: 15px;
//           border: 2px solid #000;
//           background-color: #000;
//         }

//         .download-pdf a {
//           color: #fff;
//           text-decoration: none;
//           font-weight: bold;
//           font-size: 16px;
//           text-transform: uppercase;
//         }

//         .download-pdf a:hover {
//           text-decoration: underline;
//         }

//         .payment-details {
//           margin-top: 30px;
//           padding: 20px;
//           background-color: #000;
//           color: #fff;
//           border: 2px solid #000;
//         }

//         .payment-details h2 {
//           font-size: 20px;
//           color: #fff;
//           margin-bottom: 15px;
//           text-transform: uppercase;
//           font-weight: bold;
//         }

//         .payment-details ul {
//           list-style: none;
//           padding: 0;
//         }

//         .payment-details li {
//           font-size: 16px;
//           margin-bottom: 10px;
//           color: #fff;
//         }

//         .table {
//           width: 100%;
//           border-collapse: collapse;
//           margin-top: 30px;
//           border: 2px solid #000;
//         }

//         .table th, .table td {
//           padding: 15px;
//           text-align: left;
//           font-size: 16px;
//           border: 1px solid #000;
//         }

//         .table th {
//           background-color: #000;
//           color: #fff;
//           font-weight: bold;
//           text-transform: uppercase;
//         }

//         .table td {
//           background-color: #fff;
//           color: #000;
//         }

//         .table tr:nth-child(even) td {
//           background-color: #f9f9f9;
//         }

//         .footer {
//           margin-top: 40px;
//           text-align: center;
//           font-size: 14px;
//           color: #fff;
//           background-color: #000;
//           padding: 25px;
//           border: 2px solid #000;
//         }

//         .footer p {
//           margin: 10px 0;
//           color: #fff;
//         }

//         .footer a {
//           color: #fff;
//           text-decoration: underline;
//         }

//         .footer a:hover {
//           text-decoration: none;
//         }

//         .company-address {
//           margin-top: 0;
//           font-size: 14px;
//           color: #fff;
//           text-align: center;
//           background-color: #000;
//           padding: 15px;
//         }

//         .terms {
//           font-size: 14px;
//           color: #fff;
//           margin-top: 0;
//           text-align: center;
//           background-color: #000;
//           padding: 15px;
//           border-top: 1px solid #333;
//         }

//         .terms a {
//           color: #fff;
//           text-decoration: underline;
//         }

//         .terms a:hover {
//           text-decoration: none;
//         }

//         .receipt-number {
//           text-align: center;
//           margin: 20px 0;
//           padding: 10px;
//           border: 2px solid #000;
//           background-color: #fff;
//           font-weight: bold;
//           font-size: 18px;
//         }
//       </style>
//     </head>
//     <body>

//       <div class="email-container">
        
//         <!-- Logo centered -->
//         <div class="header">
//           <img src="https://res.cloudinary.com/darf17drw/image/upload/v1752064092/Untitled_design_2_wilxrl.png" class="header-logo" alt="VayaRide Logo">
//           <h1>Payment Receipt</h1>
//           <p><strong>VayaRide</strong></p>
//         </div>

//         <!-- PDF Download Link -->
//         <div class="download-pdf">
//           <a href="https://www.vayaride.com/download-receipt.pdf" target="_blank">
//             <svg style="width: 18px; height: 18px; vertical-align: middle; margin-right: 10px; fill: white;" viewBox="0 0 24 24">
//               <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/>
//               <path d="M12,11L16,15H13V19H11V15H8L12,11Z"/>
//             </svg>
//             Download PDF Receipt
//           </a>
//         </div>

//         <!-- Receipt Number -->
//         <div class="receipt-number">
//           Receipt #: VR-${new Date().getTime()}
//         </div>

//         <p>Thank you for completing your payment! We appreciate your trust in us. Below are the details of your trip:</p>

//         <!-- Payment Details Section -->
//         <div class="payment-details">
//           <h2>Payment Details</h2>
//           <ul>
//             <li><strong>Amount Paid:</strong> R${amount}</li>
//             <li><strong>Payment Method:</strong> ${paymentMethod}</li>
//             <li><strong>Paid On:</strong> ${new Date(paidAt).toLocaleString()}</li>
//             <li><strong>Status:</strong> Completed</li>
//           </ul>
//         </div>

//         <!-- Payment Breakdown Table -->
//         <table class="table">
//           <thead>
//             <tr>
//               <th>Time Charge</th>
//               <th>Distance Charge</th>
//               <th>Subtotal</th>
//             </tr>
//           </thead>
//           <tbody>
//             <tr>
//               <td>R 9.00</td>
//               <td>R 30.00</td>
//               <td>R 39.00</td>
//             </tr>
//             <tr>
//               <td colspan="2"><strong>Service Fee</strong></td>
//               <td>R 6.00</td>
//             </tr>
//             <tr>
//               <td colspan="2"><strong>Total Amount</strong></td>
//               <td><strong>R ${amount}</strong></td>
//             </tr>
//           </tbody>
//         </table>

//         <p><strong>Questions or concerns?</strong> Contact our support team immediately.</p>

//         <!-- Footer Section -->
//         <div class="footer">
//           <p><strong>
//             <svg style="width: 18px; height: 18px; vertical-align: middle; margin-right: 8px; fill: white;" viewBox="0 0 24 24">
//               <path d="M5,11L6.5,6.5H17.5L19,11M17.5,16A1.5,1.5 0 0,1 16,14.5A1.5,1.5 0 0,1 17.5,13A1.5,1.5 0 0,1 19,14.5A1.5,1.5 0 0,1 17.5,16M6.5,16A1.5,1.5 0 0,1 5,14.5A1.5,1.5 0 0,1 6.5,13A1.5,1.5 0 0,1 8,14.5A1.5,1.5 0 0,1 6.5,16M18.92,6C18.72,5.42 18.16,5 17.5,5H6.5C5.84,5 5.28,5.42 5.08,6L3,12V20A1,1 0 0,0 4,21H5A1,1 0 0,0 6,20V19H18V20A1,1 0 0,0 19,21H20A1,1 0 0,0 21,20V12L18.92,6Z"/>
//             </svg>
//             VAYARIDE
//           </strong> | All Rights Reserved</p>
//           <p>Follow us on 
//             <svg style="width: 16px; height: 16px; vertical-align: middle; margin: 0 8px; fill: white;" viewBox="0 0 24 24">
//               <path d="M7.8,2H16.2C19.4,2 22,4.6 22,7.8V16.2A5.8,5.8 0 0,1 16.2,22H7.8C4.6,22 2,19.4 2,16.2V7.8A5.8,5.8 0 0,1 7.8,2M7.6,4A3.6,3.6 0 0,0 4,7.6V16.4C4,18.39 5.61,20 7.6,20H16.4A3.6,3.6 0 0,0 20,16.4V7.6C20,5.61 18.39,4 16.4,4H7.6M17.25,5.5A1.25,1.25 0 0,1 18.5,6.75A1.25,1.25 0 0,1 17.25,8A1.25,1.25 0 0,1 16,6.75A1.25,1.25 0 0,1 17.25,5.5M12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9Z"/>
//             </svg>
//             <a href="https://www.instagram.com/vayaride">Instagram</a> | 
//             <svg style="width: 16px; height: 16px; vertical-align: middle; margin: 0 8px; fill: white;" viewBox="0 0 24 24">
//               <path d="M22.46,6C21.69,6.35 20.86,6.58 20,6.69C20.88,6.16 21.56,5.32 21.88,4.31C21.05,4.81 20.13,5.16 19.16,5.36C18.37,4.5 17.26,4 16,4C13.65,4 11.73,5.92 11.73,8.29C11.73,8.63 11.77,8.96 11.84,9.27C8.28,9.09 5.11,7.38 3,4.79C2.63,5.42 2.42,6.16 2.42,6.94C2.42,8.43 3.17,9.75 4.33,10.5C3.62,10.5 2.96,10.3 2.38,10C2.38,10 2.38,10 2.38,10.03C2.38,12.11 3.86,13.85 5.82,14.24C5.46,14.34 5.08,14.39 4.69,14.39C4.42,14.39 4.15,14.36 3.89,14.31C4.43,16 6,17.26 7.89,17.29C6.43,18.45 4.58,19.13 2.56,19.13C2.22,19.13 1.88,19.11 1.54,19.07C3.44,20.29 5.7,21 8.12,21C16,21 20.33,14.46 20.33,8.79C20.33,8.6 20.33,8.42 20.32,8.23C21.16,7.63 21.88,6.87 22.46,6Z"/>
//             </svg>
//             <a href="https://www.twitter.com/vayaride">Twitter</a> | 
//             <svg style="width: 16px; height: 16px; vertical-align: middle; margin: 0 8px; fill: white;" viewBox="0 0 24 24">
//               <path d="M24,12.073C24,5.405 18.627,0.073 12,0.073S0,5.405 0,12.073C0,18.099 4.388,23.023 10.125,23.927V15.541H7.078V12.073H10.125V9.404C10.125,6.369 11.917,4.716 14.658,4.716C15.97,4.716 17.344,4.953 17.344,4.953V7.928H15.83C14.34,7.928 13.875,8.83 13.875,9.755V12.073H17.203L16.671,15.541H13.875V23.927C19.612,23.023 24,18.099 24,12.073Z"/>
//             </svg>
//             <a href="https://www.facebook.com/vayaride">Facebook</a>
//           </p>
          
//           <!-- Company Address -->
//           <div class="company-address">
//             <p>
//               <svg style="width: 16px; height: 16px; vertical-align: middle; margin-right: 8px; fill: white;" viewBox="0 0 24 24">
//                 <path d="M12,3L2,12H5V20H19V12H22L12,3M12,8.75A2.25,2.25 0 0,1 14.25,11A2.25,2.25 0 0,1 12,13.25A2.25,2.25 0 0,1 9.75,11A2.25,2.25 0 0,1 12,8.75Z"/>
//               </svg>
//               VayaRide, 1234 Main Street, Cape Town, South Africa
//             </p>
//             <p>
//               <svg style="width: 16px; height: 16px; vertical-align: middle; margin-right: 8px; fill: white;" viewBox="0 0 24 24">
//                 <path d="M20,8L12,13L4,8V6L12,11L20,6M20,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V6C22,4.89 21.1,4 20,4Z"/>
//               </svg>
//               Email: support@vayaride.com | 
//               <svg style="width: 16px; height: 16px; vertical-align: middle; margin: 0 8px; fill: white;" viewBox="0 0 24 24">
//                 <path d="M6.62,10.79C8.06,13.62 10.38,15.94 13.21,17.38L15.41,15.18C15.69,14.9 16.08,14.82 16.43,14.93C17.55,15.3 18.75,15.5 20,15.5A1,1 0 0,1 21,16.5V20A1,1 0 0,1 20,21A17,17 0 0,1 3,4A1,1 0 0,1 4,3H7.5A1,1 0 0,1 8.5,4C8.5,5.25 8.7,6.45 9.07,7.57C9.18,7.92 9.1,8.31 8.82,8.59L6.62,10.79Z"/>
//               </svg>
//               Phone: +27 21 123 4567
//             </p>
//           </div>

//           <!-- Terms and Conditions -->
//           <div class="terms">
//             <p>
//               <svg style="width: 16px; height: 16px; vertical-align: middle; margin-right: 8px; fill: white;" viewBox="0 0 24 24">
//                 <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/>
//               </svg>
//               <a href="https://www.vayaride.com/terms">Terms & Conditions</a> | 
//               <svg style="width: 16px; height: 16px; vertical-align: middle; margin: 0 8px; fill: white;" viewBox="0 0 24 24">
//                 <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12,7C13.4,7 14.8,8.6 14.8,10V11C15.4,11 16,11.4 16,12V16C16,16.6 15.6,17 15,17H9C8.4,17 8,16.6 8,16V12C8,11.4 8.4,11 9,11V10C9,8.6 10.6,7 12,7M12,8.2C11.2,8.2 10.2,9.2 10.2,10V11H13.8V10C13.8,9.2 12.8,8.2 12,8.2Z"/>
//               </svg>
//               <a href="https://www.vayaride.com/privacy">Privacy Policy</a> | 
//               <svg style="width: 16px; height: 16px; vertical-align: middle; margin: 0 8px; fill: white;" viewBox="0 0 24 24">
//                 <path d="M12,1C8.96,1 6.21,2.65 4.86,5.58C5.45,6.04 6,6.58 6.5,7.17C7.25,4.83 9.39,3.17 12,3.17C15.93,3.17 19.17,6.41 19.17,10.33C19.17,14.26 15.93,17.5 12,17.5C9.39,17.5 7.25,15.84 6.5,13.5C6,14.09 5.45,14.63 4.86,15.09C6.21,18 8.96,19.67 12,19.67C17.05,19.67 21.17,15.54 21.17,10.5C21.17,5.46 17.05,1.33 12,1.33V1M7.71,7.12C6.45,7.96 5.5,9.43 5.5,11.38C5.5,13.32 6.45,14.8 7.71,15.64C7.71,15.64 9.5,14.36 9.5,11.38C9.5,8.39 7.71,7.12 7.71,7.12Z"/>
//               </svg>
//               <a href="https://www.vayaride.com/support">Support</a>
//             </p>
//           </div>
//         </div>

//       </div>

//     </body>
//     </html>
//   `;

//   // Prepare email options
//   const mailOptions = {
//     from: process.env.EMAIL_USER, // sender address
//     to: recipientEmail, // recipient email
//     subject: 'Payment Receipt for Your VayaRide Trip',
//     html: emailHtml, // HTML body content
//   };

//   // Send the email
//   try {
//     await transporter.sendMail(mailOptions);
//     console.log('✅ Payment receipt email sent successfully');
//   } catch (error) {
//     console.error('❌ Error sending payment receipt email:', error);
//   }
// }

// // Test the function with a sample email and payment details
// const sampleEmail = 'draglearnn@gmail.com'; // Change this to the rider's email
// const samplePaymentDetails = {
//   amount: 45.00,
//   paymentMethod: 'PayFast',
//   paidAt: new Date(),
// };

// sendPaymentReceiptEmail(sampleEmail, samplePaymentDetails);