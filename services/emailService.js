
'use strict';

const brevoEmail = require('./brevoEmail');

const REQUIRED_METHODS = [
  'sendEmail',
  'sendWelcomeEmail',
  'sendPasswordResetEmail',
  'sendReceiptEmail'
];

for (const method of REQUIRED_METHODS) {
  if (typeof brevoEmail[method] !== 'function') {
    throw new Error(
      `Email service error: brevoEmail.${method} is not implemented.`
    );
  }
}

async function sendEmail(options = {}) {
  return brevoEmail.sendEmail(options);
}

async function sendWelcomeEmail(options = {}) {
  return brevoEmail.sendWelcomeEmail(options);
}

async function sendPasswordResetEmail(options = {}) {
  return brevoEmail.sendPasswordResetEmail(options);
}

async function sendReceiptEmail(options = {}) {
  return brevoEmail.sendReceiptEmail(options);
}

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendReceiptEmail
};