
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

async function sendReceiptEmail({
  email,
  customerName,
  orderNumber,
  pdfBuffer
}) {
  if (!process.env.BREVO_API_KEY) {
    throw new Error("BREVO_API_KEY is missing");
  }

  if (!process.env.BREVO_SENDER_EMAIL) {
    throw new Error("BREVO_SENDER_EMAIL is missing");
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Customer email is missing or invalid");
  }

  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.length) {
    throw new Error("Receipt PDF is missing or invalid");
  }

  const api = new brevo.TransactionalEmailsApi();

  api.setApiKey(
    brevo.TransactionalEmailsApiApiKeys.apiKey,
    process.env.BREVO_API_KEY
  );

  const safeName = escapeHtml(customerName || "Customer");
  const safeOrderNumber = escapeHtml(orderNumber || "N/A");

  const message = new brevo.SendSmtpEmail();

  message.sender = {
    name: process.env.BREVO_SENDER_NAME || "Mawego Bookshop",
    email: process.env.BREVO_SENDER_EMAIL
  };

  message.to = [{
    email,
    name: customerName || "Customer"
  }];

  message.subject = `Your Mawego Bookshop Receipt - ${orderNumber}`;

  message.htmlContent = `
    <div style="font-family:Arial,sans-serif;color:#222;line-height:1.6">
      <h2 style="color:#08734e">MAWEGO BOOKSHOP</h2>
      <p>Hello ${safeName},</p>
      <p>Thank you for shopping with Mawego Bookshop.</p>
      <p>Your order <strong>${safeOrderNumber}</strong> has been paid.</p>
      <p>Your official PDF receipt is attached to this email.</p>
      <p>Thank you for choosing Mawego Bookshop!</p>
    </div>
  `;

  message.attachment = [{
    name: `Mawego-Receipt-${String(orderNumber || "order")
      .replace(/[^a-zA-Z0-9_-]/g, "")}.pdf`,
    content: pdfBuffer.toString("base64")
  }];

  const response = await api.sendTransacEmail(message);

  // Brevo SDK responses can expose the message ID in different locations.
  const messageId =
    response?.messageId ||
    response?.body?.messageId ||
    null;

  return {
    messageId,
    response
  };
}

module.exports = { sendReceiptEmail };