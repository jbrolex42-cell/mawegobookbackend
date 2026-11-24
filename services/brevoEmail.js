
'use strict';

const brevo = require('@getbrevo/brevo');

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const DEFAULT_FRONTEND_URL = 'https://mawegobookshop.vercel.app';
const DEFAULT_SENDER_NAME = 'Mawego Bookshop';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* -------------------------------------------------------------------------- */
/* HTML Utilities                                                             */
/* -------------------------------------------------------------------------- */

function escapeHtml(value) {
  const entities = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  return String(value ?? '').replace(/[&<>"']/g, character => {
    return entities[character];
  });
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function validateEmail(email) {
  return (
    typeof email === 'string' &&
    EMAIL_REGEX.test(email.trim())
  );
}

function requireEmail(email, fieldName = 'Email address') {
  if (!validateEmail(email)) {
    throw new Error(`${fieldName} is missing or invalid.`);
  }

  return email.trim().toLowerCase();
}

function requireString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} is required.`);
  }

  return value.trim();
}

/* -------------------------------------------------------------------------- */
/* Frontend URL                                                               */
/* -------------------------------------------------------------------------- */

function getFrontendUrl() {
  const frontendUrl = String(
    process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL
  ).trim().replace(/\/+$/, '');

  let parsedUrl;

  try {
    parsedUrl = new URL(frontendUrl);
  } catch {
    throw new Error('FRONTEND_URL is invalid.');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('FRONTEND_URL must use HTTP or HTTPS.');
  }

  if (process.env.NODE_ENV === 'production' && parsedUrl.protocol !== 'https:') {
    throw new Error('FRONTEND_URL must use HTTPS in production.');
  }

  return frontendUrl;
}

/* -------------------------------------------------------------------------- */
/* Brevo Configuration                                                        */
/* -------------------------------------------------------------------------- */

function getSender() {
  const email = requireEmail(
    process.env.BREVO_SENDER_EMAIL,
    'BREVO_SENDER_EMAIL'
  );

  const name = String(
    process.env.BREVO_SENDER_NAME || DEFAULT_SENDER_NAME
  ).trim();

  return {
    name: name || DEFAULT_SENDER_NAME,
    email
  };
}

function getBrevoApi() {
  const apiKey = String(
    process.env.BREVO_API_KEY || ''
  ).trim();

  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not configured.');
  }

  const api = new brevo.TransactionalEmailsApi();

  api.setApiKey(
    brevo.TransactionalEmailsApiApiKeys.apiKey,
    apiKey
  );

  return api;
}

/* -------------------------------------------------------------------------- */
/* Brevo Response                                                             */
/* -------------------------------------------------------------------------- */

function getMessageId(response) {
  return (
    response?.messageId ||
    response?.body?.messageId ||
    response?.data?.messageId ||
    null
  );
}

/* -------------------------------------------------------------------------- */
/* Core Email Sender                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Supports both interfaces:
 *
 * New:
 * {
 *   email,
 *   name,
 *   subject,
 *   html,
 *   text,
 *   attachment
 * }
 *
 * Legacy:
 * {
 *   to,
 *   subject,
 *   htmlContent,
 *   textContent,
 *   attachment
 * }
 *
 * Attachment format:
 * [
 *   {
 *     name: 'receipt.pdf',
 *     content: 'BASE64_CONTENT'
 *   }
 * ]
 */
async function sendEmail(options = {}) {
  const {
    email,
    to,
    name = 'Customer',
    subject,
    html,
    htmlContent,
    text,
    textContent,
    attachment = null
  } = options;

  const recipientEmail = requireEmail(
    email || to,
    'Recipient email'
  );

  const recipientName = String(name || 'Customer').trim();

  const emailSubject = requireString(
    subject,
    'Email subject'
  );

  const finalHtml = requireString(
    html || htmlContent,
    'Email HTML content'
  );

  const finalText = text ?? textContent;

  const message = new brevo.SendSmtpEmail();

  message.sender = getSender();

  message.to = [
    {
      email: recipientEmail,
      name: recipientName
    }
  ];

  message.subject = emailSubject;
  message.htmlContent = finalHtml;

  if (finalText !== undefined && finalText !== null && String(finalText).trim()) {
    message.textContent = String(finalText);
  }

  if (attachment !== null) {
    const attachments = Array.isArray(attachment)
      ? attachment
      : [attachment];

    if (attachments.length === 0) {
      throw new Error('Email attachment cannot be empty.');
    }

    message.attachment = attachments.map(file => {
      if (
        !file ||
        typeof file.name !== 'string' ||
        !file.name.trim() ||
        typeof file.content !== 'string' ||
        !file.content.trim()
      ) {
        throw new Error('Email attachment is invalid.');
      }

      return {
        name: file.name.trim(),
        content: file.content.trim()
      };
    });
  }

  const response = await getBrevoApi().sendTransacEmail(message);

  return {
    success: true,
    messageId: getMessageId(response),
    response
  };
}

/* -------------------------------------------------------------------------- */
/* Welcome Email                                                              */
/* -------------------------------------------------------------------------- */

async function sendWelcomeEmail({
  email,
  customerName
}) {
  const name = String(
    customerName || 'Valued Customer'
  ).trim();

  const safeName = escapeHtml(name);
  const frontendUrl = getFrontendUrl();
  const safeFrontendUrl = escapeHtml(frontendUrl);

  const html = `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;padding:20px;background:#f4f7f5;font-family:Arial,sans-serif;color:#333;line-height:1.6">
        <div style="max-width:600px;margin:auto;background:#ffffff;border-radius:10px;overflow:hidden">
          <div style="background:#183b32;padding:25px;text-align:center;color:white">
            <h1 style="margin:0">Mawego Bookshop</h1>
            <p style="margin:8px 0 0">Your reading journey starts here.</p>
          </div>

          <div style="padding:25px">
            <h2>Welcome, ${safeName}!</h2>

            <p>
              Thank you for creating an account with Mawego Bookshop.
              We're delighted to have you shopping with us.
            </p>

            <p>
              You can now browse our catalogue, place orders,
              track purchases and enjoy your customer account.
            </p>

            <p style="text-align:center;margin:30px 0">
              <a
                href="${safeFrontendUrl}"
                style="display:inline-block;background:#183b32;color:white;padding:13px 25px;text-decoration:none;border-radius:5px;font-weight:bold"
              >
                Start Shopping
              </a>
            </p>

            <p>Thank you for choosing Mawego Bookshop.</p>
          </div>
        </div>
      </body>
    </html>
  `;

  return sendEmail({
    email,
    name,
    subject: 'Welcome to Mawego Bookshop!',
    html,
    text: `Welcome to Mawego Bookshop, ${name}! Visit ${frontendUrl} to start shopping.`
  });
}

/* -------------------------------------------------------------------------- */
/* Password Reset Email                                                       */
/* -------------------------------------------------------------------------- */

async function sendPasswordResetEmail({
  email,
  customerName,
  resetToken
}) {
  const token = requireString(
    resetToken,
    'Password reset token'
  );

  const name = String(
    customerName || 'Customer'
  ).trim();

  const safeName = escapeHtml(name);
  const frontendUrl = getFrontendUrl();

  const resetUrl =
    `${frontendUrl}/pages/reset-password.html?token=${encodeURIComponent(token)}`;

  const safeResetUrl = escapeHtml(resetUrl);

  const html = `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;padding:20px;background:#f4f7f5;font-family:Arial,sans-serif;color:#333;line-height:1.6">
        <div style="max-width:600px;margin:auto;background:#ffffff;border-radius:10px;overflow:hidden">
          <div style="background:#183b32;padding:25px;text-align:center;color:white">
            <h1 style="margin:0">Mawego Bookshop</h1>
          </div>

          <div style="padding:25px">
            <h2>Password Reset</h2>

            <p>Hello ${safeName},</p>

            <p>
              We received a request to reset your Mawego Bookshop password.
            </p>

            <p>
              Click the button below to create a new password:
            </p>

            <p style="text-align:center;margin:30px 0">
              <a
                href="${safeResetUrl}"
                style="display:inline-block;background:#183b32;color:white;padding:14px 25px;text-decoration:none;border-radius:5px;font-weight:bold"
              >
                Reset My Password
              </a>
            </p>

            <p>
              This link expires in 30 minutes and can only be used once.
            </p>

            <p>
              If you did not request a password reset, you can ignore this email.
            </p>

            <p style="font-size:12px;color:#777;word-break:break-all">
              If the button doesn't work, copy this link into your browser:
              <br>
              ${safeResetUrl}
            </p>
          </div>
        </div>
      </body>
    </html>
  `;

  return sendEmail({
    email,
    name,
    subject: 'Reset Your Mawego Bookshop Password',
    html,
    text: `Hello ${name}. Reset your password using this link: ${resetUrl}. This link expires in 30 minutes.`
  });
}

/* -------------------------------------------------------------------------- */
/* Receipt Email                                                              */
/* -------------------------------------------------------------------------- */

async function sendReceiptEmail({
  email,
  customerName,
  orderNumber,
  pdfBuffer
}) {
  requireEmail(email, 'Customer email');

  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error('A valid PDF receipt buffer is required.');
  }

  const name = String(
    customerName || 'Customer'
  ).trim();

  const safeName = escapeHtml(name);

  const displayOrderNumber = String(
    orderNumber || 'N/A'
  );

  const safeOrderNumber = escapeHtml(displayOrderNumber);

  const cleanOrderNumber = displayOrderNumber.replace(
    /[^a-zA-Z0-9_-]/g,
    ''
  );

  const filename =
    `Mawego-Receipt-${cleanOrderNumber || 'receipt'}.pdf`;

  const html = `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;padding:20px;background:#f4f7f5;font-family:Arial,sans-serif;color:#333;line-height:1.6">
        <div style="max-width:600px;margin:auto;background:#ffffff;border-radius:10px;overflow:hidden">
          <div style="background:#183b32;padding:25px;text-align:center;color:white">
            <h1 style="margin:0">Mawego Bookshop</h1>
          </div>

          <div style="padding:25px">
            <h2>Thank you for your order, ${safeName}!</h2>

            <p>
              Your order
              <strong>${safeOrderNumber}</strong>
              has been processed.
            </p>

            <p>
              Your PDF receipt is attached to this email.
              Please keep it for your records.
            </p>

            <p>Thank you for shopping with Mawego Bookshop.</p>
          </div>
        </div>
      </body>
    </html>
  `;

  return sendEmail({
    email,
    name,
    subject: `Your Mawego Bookshop Receipt - ${displayOrderNumber}`,
    html,
    text: `Thank you for shopping with Mawego Bookshop. Your receipt for order ${displayOrderNumber} is attached.`,
    attachment: [
      {
        name: filename,
        content: pdfBuffer.toString('base64')
      }
    ]
  });
}

/* -------------------------------------------------------------------------- */
/* Module Exports                                                             */
/* -------------------------------------------------------------------------- */

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendReceiptEmail,
  escapeHtml,
  validateEmail,
  getFrontendUrl
};