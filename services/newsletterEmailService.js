
'use strict';

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

const escapeHtml = (value = '') =>
  String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);

async function sendNewsletterEmail({ to, subject, html, text }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.NEWSLETTER_FROM_EMAIL;
  const senderName = process.env.NEWSLETTER_FROM_NAME || 'Mawego Bookshop';

  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not configured.');
  }

  if (!senderEmail) {
    throw new Error('NEWSLETTER_FROM_EMAIL is not configured.');
  }

  if (!to || !subject || !html) {
    throw new Error('Recipient, subject and email content are required.');
  }

  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      sender: {
        name: senderName,
        email: senderEmail
      },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text || ''
    })
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('[Newsletter] Brevo email error:', {
      status: response.status,
      message: result.message || result.code || 'Email delivery failed'
    });

    throw new Error(
      result.message || 'The email provider could not send the message.'
    );
  }

  return result;
}

function newsletterEmailLayout(content) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Mawego Bookshop</title>
    </head>
    <body style="margin:0;padding:30px 12px;background:#f4f7f5;font-family:Arial,sans-serif;color:#26352e;">
      <div style="max-width:600px;margin:auto;background:#ffffff;border-radius:12px;overflow:hidden;">
        <div style="background:#087653;padding:25px;text-align:center;">
          <h1 style="margin:0;color:#ffffff;font-size:25px;">Mawego Bookshop</h1>
          <p style="margin:8px 0 0;color:#e4f4eb;">Books, Stationery & Learning</p>
        </div>

        <div style="padding:30px 25px;line-height:1.7;font-size:15px;">
          ${content}
        </div>

        <div style="padding:20px;background:#f4f7f5;text-align:center;color:#64736b;font-size:12px;">
          <p>Mawego Bookshop — Keep discovering. Keep learning.</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

module.exports = {
  sendNewsletterEmail,
  newsletterEmailLayout,
  escapeHtml
};