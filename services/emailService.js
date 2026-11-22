
const brevo = require('@getbrevo/brevo');

const FRONTEND_URL = (
  process.env.FRONTEND_URL || 'https://mawegobookshop.vercel.app'
).replace(/\/+$/, '');

function getBrevoApi() {
  if (!process.env.BREVO_API_KEY) {
    throw new Error('BREVO_API_KEY is not configured');
  }

  if (!process.env.BREVO_SENDER_EMAIL) {
    throw new Error('BREVO_SENDER_EMAIL is not configured');
  }

  const apiInstance = new brevo.TransactionalEmailsApi();

  apiInstance.setApiKey(
    brevo.TransactionalEmailsApiApiKeys.apiKey,
    process.env.BREVO_API_KEY
  );

  return apiInstance;
}

function getSender() {
  return {
    name: process.env.BREVO_SENDER_NAME || 'Mawego Bookshop',
    email: process.env.BREVO_SENDER_EMAIL
  };
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    String(email || '').trim()
  );
}

async function sendEmail({ to, subject, htmlContent, textContent, attachment }) {
  if (!validateEmail(to)) {
    throw new Error('A valid recipient email is required');
  }

  const api = getBrevoApi();

  const message = new brevo.SendSmtpEmail();

  message.sender = getSender();

  message.to = [
    {
      email: String(to).trim()
    }
  ];

  message.subject = subject;
  message.htmlContent = htmlContent;
  message.textContent = textContent || '';

  if (attachment) {
    message.attachment = [attachment];
  }

  return api.sendTransacEmail(message);
}

// ==================================================
// WELCOME EMAIL
// ==================================================

async function sendWelcomeEmail({ email, customerName }) {
  const name = customerName || 'Valued Customer';

  return sendEmail({
    to: email,
    subject: 'Welcome to Mawego Bookshop!',

    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#333;line-height:1.6">
        <div style="background:#183b32;padding:25px;text-align:center;color:white">
          <h1 style="margin:0">Mawego Bookshop</h1>
        </div>

        <div style="padding:25px">
          <h2>Welcome, ${escapeHtml(name)}!</h2>

          <p>
            Thank you for creating an account with Mawego Bookshop.
            We're delighted to have you shopping with us.
          </p>

          <p>
            You can now browse our catalogue, place orders,
            track purchases and enjoy your customer account.
          </p>

          <p style="text-align:center;margin:30px 0">
            <a href="${FRONTEND_URL}"
               style="background:#183b32;color:white;padding:13px 25px;text-decoration:none;border-radius:5px">
              Start Shopping
            </a>
          </p>

          <p>Thank you for choosing Mawego Bookshop.</p>
        </div>
      </div>
    `,

    textContent:
      `Welcome to Mawego Bookshop, ${name}! Visit ${FRONTEND_URL} to start shopping.`
  });
}

// ==================================================
// PASSWORD RESET EMAIL
// ==================================================

async function sendPasswordResetEmail({
  email,
  customerName,
  resetToken
}) {
  if (!resetToken) {
    throw new Error('Password reset token is required');
  }

  const name = customerName || 'Customer';

  const resetUrl =
    `${FRONTEND_URL}/pages/reset-password.html?token=${encodeURIComponent(resetToken)}`;

  return sendEmail({
    to: email,
    subject: 'Reset Your Mawego Bookshop Password',

    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#333;line-height:1.6">
        <div style="background:#183b32;padding:25px;text-align:center;color:white">
          <h1 style="margin:0">Mawego Bookshop</h1>
        </div>

        <div style="padding:25px">
          <h2>Password Reset</h2>

          <p>Hello ${escapeHtml(name)},</p>

          <p>
            We received a request to reset your Mawego Bookshop password.
          </p>

          <p style="text-align:center;margin:30px 0">
            <a href="${resetUrl}"
               style="background:#183b32;color:white;padding:14px 25px;text-decoration:none;border-radius:5px">
              Reset My Password
            </a>
          </p>

          <p>This link expires in 30 minutes and can only be used once.</p>

          <p>
            If you did not request a password reset, you can ignore this email.
          </p>

          <p style="font-size:12px;color:#777">
            If the button doesn't work, copy this link into your browser:<br>
            ${resetUrl}
          </p>
        </div>
      </div>
    `,

    textContent:
      `Hello ${name}. Reset your password using this link: ${resetUrl}. This link expires in 30 minutes.`
  });
}

// ==================================================
// PDF ORDER RECEIPT EMAIL
// ==================================================

async function sendReceiptEmail({
  email,
  customerName,
  orderNumber,
  pdfBuffer
}) {
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
    throw new Error('A valid PDF receipt buffer is required');
  }

  const safeOrderNumber = String(orderNumber || 'receipt')
    .replace(/[^a-zA-Z0-9_-]/g, '_');

  return sendEmail({
    to: email,
    subject: `Your Mawego Bookshop Receipt - ${orderNumber}`,

    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#333;line-height:1.6">
        <div style="background:#183b32;padding:25px;text-align:center;color:white">
          <h1 style="margin:0">Mawego Bookshop</h1>
        </div>

        <div style="padding:25px">
          <h2>Thank you for your order, ${escapeHtml(customerName || 'Customer')}!</h2>

          <p>
            Your order <strong>${escapeHtml(orderNumber)}</strong>
            has been received.
          </p>

          <p>
            Your PDF receipt is attached to this email.
            Please keep it for your records.
          </p>

          <p>Thank you for shopping with Mawego Bookshop.</p>
        </div>
      </div>
    `,

    textContent:
      `Thank you for shopping with Mawego Bookshop. Your receipt for order ${orderNumber} is attached.`,

    attachment: {
      name: `Mawego-Receipt-${safeOrderNumber}.pdf`,
      content: pdfBuffer.toString('base64')
    }
  });
}

// ==================================================
// HTML ESCAPING
// ==================================================

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ==================================================
// EXPORTS
// ==================================================

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendReceiptEmail
};