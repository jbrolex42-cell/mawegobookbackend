
'use strict';

/**
 * =============================================================================
 * MAWEGO BOOKSHOP - ORDER RECEIPT EMAIL SERVICE
 * =============================================================================
 *
 * Responsibilities:
 * - Verify that an order has confirmed payment
 * - Validate the customer's email address
 * - Prevent duplicate receipt deliveries
 * - Prevent simultaneous receipt processing
 * - Generate receipt PDFs
 * - Send receipts through Brevo
 * - Track receipt email delivery attempts
 * - Record successful and failed deliveries
 * - Support intentional receipt resending
 *
 * IMPORTANT:
 * A successful Brevo response means the email was accepted by Brevo.
 * It does not guarantee that the email reached the customer's inbox.
 *
 * =============================================================================
 */

const mongoose = require('mongoose');

const ReceiptEmailLog = require('../models/ReceiptEmailLog');

const { generateReceiptPdf } = require('./receiptPdf');

const { sendReceiptEmail } = require('./brevoEmail');

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const MAX_ERROR_LENGTH = 2000;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function getOrderId(order) {
  if (!order || !order._id) {
    throw new Error('Order ID is required to send a receipt.');
  }

  return order._id;
}

function getOrderPaymentStatus(order) {
  return String(
    order.payment_status ||
    order.paymentStatus ||
    ''
  ).trim().toLowerCase();
}

function getCustomerEmail(order) {
  return String(
    order.customer_email ||
    order.email ||
    order.customer?.email ||
    ''
  ).trim().toLowerCase();
}

function getCustomerName(order) {
  return String(
    order.customer_name ||
    order.customerName ||
    order.full_name ||
    order.customer?.name ||
    'Valued Customer'
  ).trim();
}

function getOrderNumber(order, orderId) {
  return String(
    order.order_number ||
    order.orderNumber ||
    orderId
  ).trim();
}

function validateEmail(email) {
  if (!email || !EMAIL_REGEX.test(email)) {
    throw new Error(
      'The order does not contain a valid customer email address.'
    );
  }

  return email;
}

function normalizeError(error) {
  return String(
    error?.message ||
    error ||
    'Unknown receipt email error'
  ).slice(0, MAX_ERROR_LENGTH);
}

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

/* -------------------------------------------------------------------------- */
/* Receipt Log Creation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Creates a pending receipt log.
 *
 * The unique partial index on:
 *
 * { order_id: 1 }
 *
 * with:
 *
 * { status: "pending" }
 *
 * is responsible for preventing concurrent pending receipts.
 *
 * Make sure that index exists in MongoDB.
 */
async function createPendingLog({
  orderId,
  email
}) {
  try {
    return await ReceiptEmailLog.create({
      order_id: orderId,
      customer_email: email,
      status: 'pending',
      attempts: 1,
      error_message: ''
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return null;
    }

    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Mark Receipt as Sent                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Only changes a log that is still pending.
 *
 * This prevents an already completed log from being overwritten.
 */
async function markReceiptSent(logId, result) {
  const messageId = result?.messageId || null;

  const updatedLog = await ReceiptEmailLog.findOneAndUpdate(
    {
      _id: logId,
      status: 'pending'
    },
    {
      $set: {
        status: 'sent',
        brevo_message_id: messageId,
        sent_at: new Date(),
        error_message: ''
      }
    },
    {
      new: true,
      runValidators: true
    }
  );

  if (!updatedLog) {
    throw new Error(
      'Brevo accepted the receipt, but the receipt log could not be updated. Delivery status requires reconciliation.'
    );
  }

  return updatedLog;
}

/* -------------------------------------------------------------------------- */
/* Mark Receipt as Failed                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Marks a pending receipt log as failed.
 *
 * This function is not used when Brevo has already accepted
 * the email, because marking it failed could cause an unsafe retry.
 */
async function markReceiptFailed(logId, error) {
  return ReceiptEmailLog.findOneAndUpdate(
    {
      _id: logId,
      status: 'pending'
    },
    {
      $set: {
        status: 'failed',
        error_message: normalizeError(error)
      }
    },
    {
      new: true,
      runValidators: true
    }
  );
}

/* -------------------------------------------------------------------------- */
/* Send Order Receipt                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Sends a paid order receipt to the customer.
 *
 * Usage:
 *
 * await sendOrderReceipt(order);
 *
 * Force resend:
 *
 * await sendOrderReceipt(order, { force: true });
 *
 * Results:
 *
 * Already sent:
 * {
 *   success: true,
 *   duplicate: true
 * }
 *
 * Currently processing:
 * {
 *   success: false,
 *   processing: true
 * }
 *
 * Successfully accepted by Brevo:
 * {
 *   success: true,
 *   messageId: "..."
 * }
 */
async function sendOrderReceipt(order, options = {}) {
  const force = options.force === true;

  if (!order) {
    throw new Error('Order not found.');
  }

  if (mongoose.isValidObjectId(order._id) === false) {
    throw new Error('Invalid order ID.');
  }

  const orderId = getOrderId(order);

  // Never send a receipt before confirmed payment.
  if (getOrderPaymentStatus(order) !== 'paid') {
    throw new Error(
      'Receipt email requires confirmed payment.'
    );
  }

  const email = validateEmail(
    getCustomerEmail(order)
  );

  const customerName = getCustomerName(order);

  const orderNumber = getOrderNumber(
    order,
    orderId
  );

  /* ---------------------------------------------------------------------- */
  /* Check Previous Successful Delivery                                     */
  /* ---------------------------------------------------------------------- */

  if (!force) {
    const existingSent = await ReceiptEmailLog.exists({
      order_id: orderId,
      status: 'sent'
    });

    if (existingSent) {
      return {
        success: true,
        duplicate: true,
        message: 'Receipt was already sent.'
      };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Create Pending Delivery Log                                            */
  /* ---------------------------------------------------------------------- */

  const log = await createPendingLog({
    orderId,
    email
  });

  if (!log) {
    return {
      success: false,
      processing: true,
      message: 'A receipt email is already being processed.'
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Generate PDF and Send Email                                            */
  /* ---------------------------------------------------------------------- */

  let deliveryAccepted = false;

  try {
    const pdfBuffer = await generateReceiptPdf(order);

    if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
      throw new Error(
        'Receipt PDF generation returned an invalid or empty file.'
      );
    }

    const result = await sendReceiptEmail({
      email,
      customerName,
      orderNumber,
      pdfBuffer
    });

    if (!result || result.success === false) {
      throw new Error(
        result?.message ||
        'Brevo did not confirm receipt email acceptance.'
      );
    }

    // From this point onward, do not mark the log as failed:
    // Brevo may already have accepted the email.
    deliveryAccepted = true;

    const updatedLog = await markReceiptSent(
      log._id,
      result
    );

    return {
      success: true,
      duplicate: false,
      message: 'Receipt email accepted by Brevo.',
      messageId: result.messageId || null,
      logId: updatedLog._id
    };
  } catch (error) {
    if (deliveryAccepted) {
      // Do not mark this as failed or automatically retry.
      // The email may already have been accepted by Brevo.
      error.code = 'RECEIPT_DELIVERY_STATUS_UNCONFIRMED';
      error.receiptLogId = log._id;

      throw error;
    }

    try {
      await markReceiptFailed(log._id, error);
    } catch (logError) {
      // Preserve the original delivery error while attaching
      // the logging error for server-side investigation.
      error.logUpdateError = normalizeError(logError);
      error.receiptLogId = log._id;
    }

    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  sendOrderReceipt
};