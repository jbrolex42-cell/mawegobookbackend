'use strict';

const mongoose = require('mongoose');

const ReceiptEmailLog = require('../models/ReceiptEmailLog');

const { generateReceiptPdf } = require('./receiptPdf');

const { sendReceiptEmail } = require('./brevoEmail');

const MAX_ERROR_LENGTH = 2000;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function toError(error) {
  return error instanceof Error
    ? error
    : new Error(normalizeError(error));
}

async function createPendingLog({ orderId, email }) {
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

async function sendOrderReceipt(order, options = {}) {
  const force = options.force === true;

  if (!order) {
    throw new Error('Order not found.');
  }

  if (!mongoose.isValidObjectId(order._id)) {
    throw new Error('Invalid order ID.');
  }

  const orderId = getOrderId(order);

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
  } catch (originalError) {
    const error = toError(originalError);

    if (deliveryAccepted) {
      error.code = 'RECEIPT_DELIVERY_STATUS_UNCONFIRMED';
      error.receiptLogId = log._id;

      throw error;
    }

    try {
      await markReceiptFailed(log._id, error);
    } catch (logError) {
      error.logUpdateError = normalizeError(logError);
      error.receiptLogId = log._id;
    }

    throw error;
  }
}

module.exports = {
  sendOrderReceipt
};