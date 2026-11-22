
const brevo = require("@getbrevo/brevo");

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

function getBrevoApi() {
  if (!process.env.BREVO_API_KEY) {
    throw new Error("BREVO_API_KEY is missing");
  }

  if (!process.env.BREVO_SENDER_EMAIL) {
    throw new Error("BREVO_SENDER_EMAIL is missing");
  }

  const api = new brevo.TransactionalEmailsApi();

  api.setApiKey(
    brevo.TransactionalEmailsApiApiKeys.apiKey,
    process.env.BREVO_API_KEY
  );

  return api;
}

function validateEmail(email) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Customer email is missing or invalid");
  }
}

async function sendEmail({ email, name, subject, html, attachment }) {
  validateEmail(email);

  const message = new brevo.SendSmtpEmail();

  message.sender = {
    name: process.env.BREVO_SENDER_NAME || "Mawego Bookshop",
    email: process.env.BREVO_SENDER_EMAIL
  };

  message.to = [{
    email,
    name: name || "Customer"
  }];

  message.subject = subject;
  message.htmlContent = html;

  if (attachment) {
    message.attachment = attachment;
  }

  const response = await getBrevoApi().sendTransacEmail(message);

  return {
    messageId:
      response?.messageId ||
      response?.body?.messageId ||
      null,
    response
  };
}

// 1. WELCOME EMAIL
async function sendWelcomeEmail({ email, customerName }) {
  const safeName = escapeHtml(customerName || "Customer");

  return sendEmail({
    email,
    name: customerName,
    subject: "Welcome to Mawego Bookshop!",
    html: `
      <div style="font-family:Arial,sans-serif;color:#24352e;line-height:1.7;max-width:600px;margin:auto;padding:25px">
        <div style="background:#08734e;padding:25px;text-align:center;border-radius:12px">
          <h1 style="color:white;margin:0">MAWEGO BOOKSHOP</h1>
          <p style="color:#e0f2e9;margin:8px 0 0">Your reading journey starts here.</p>
        </div>

        <h2>Hello ${safeName}!</h2>

        <p>Welcome to Mawego Bookshop. We're delighted to have you as part of our reading community.</p>

        <p>Your customer account has been successfully created. You can now:</p>

        <ul>
          <li>Discover and purchase books.</li>
          <li>Track your orders.</li>
          <li>Access your digital receipts.</li>
          <li>Earn and redeem customer reward points.</li>
        </ul>

        <p style="text-align:center;margin:30px 0">
          <a href="${escapeHtml(process.env.FRONTEND_URL || "https://mawegobookshop.vercel.app")}"
             style="background:#08734e;color:white;padding:14px 25px;text-decoration:none;border-radius:7px;font-weight:bold">
            Start Shopping
          </a>
        </p>

        <p>Thank you for choosing Mawego Bookshop!</p>

        <p style="color:#777;font-size:12px">
          This is an automatic account welcome message.
        </p>
      </div>
    `
  });
}

// 2. PASSWORD RESET EMAIL
async function sendPasswordResetEmail({
  email,
  customerName,
  resetToken
}) {
  const safeName = escapeHtml(customerName || "Customer");

  const frontendUrl = (
    process.env.FRONTEND_URL ||
    "https://mawegobookshop.vercel.app"
  ).replace(/\/+$/, "");

  const resetUrl =
    `${frontendUrl}/pages/reset-password.html?token=${encodeURIComponent(resetToken)}`;

  return sendEmail({
    email,
    name: customerName,
    subject: "Reset Your Mawego Bookshop Password",
    html: `
      <div style="font-family:Arial,sans-serif;color:#24352e;line-height:1.7;max-width:600px;margin:auto;padding:25px">
        <div style="background:#08734e;padding:25px;text-align:center;border-radius:12px">
          <h1 style="color:white;margin:0">MAWEGO BOOKSHOP</h1>
        </div>

        <h2>Password Reset Request</h2>

        <p>Hello ${safeName},</p>

        <p>We received a request to reset the password associated with your Mawego Bookshop account.</p>

        <p>Click the button below to create a new password:</p>

        <p style="text-align:center;margin:30px 0">
          <a href="${escapeHtml(resetUrl)}"
             style="background:#08734e;color:white;padding:14px 25px;text-decoration:none;border-radius:7px;font-weight:bold">
            Reset My Password
          </a>
        </p>

        <p>This link expires in 30 minutes and can only be used once.</p>

        <p>If you did not request a password reset, you can safely ignore this email.</p>

        <p>Mawego Bookshop Support</p>
      </div>
    `
  });
}

// 3. EXISTING ORDER RECEIPT EMAIL
async function sendReceiptEmail({
  email,
  customerName,
  orderNumber,
  pdfBuffer
}) {
  validateEmail(email);

  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.length) {
    throw new Error("Receipt PDF is missing or invalid");
  }

  const safeName = escapeHtml(customerName || "Customer");
  const safeOrderNumber = escapeHtml(orderNumber || "N/A");

  return sendEmail({
    email,
    name: customerName,
    subject: `Your Mawego Bookshop Receipt - ${orderNumber}`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#222;line-height:1.6">
        <h2 style="color:#08734e">MAWEGO BOOKSHOP</h2>
        <p>Hello ${safeName},</p>
        <p>Thank you for shopping with Mawego Bookshop.</p>
        <p>Your order <strong>${safeOrderNumber}</strong> has been paid.</p>
        <p>Your official PDF receipt is attached to this email.</p>
        <p>Thank you for choosing Mawego Bookshop!</p>
      </div>
    `,
    attachment: [{
      name: `Mawego-Receipt-${String(orderNumber || "order")
        .replace(/[^a-zA-Z0-9_-]/g, "")}.pdf`,
      content: pdfBuffer.toString("base64")
    }]
  });
}

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendReceiptEmail
};