'use strict';

const mongoose = require('mongoose');

const { Order, PaymentLog } = require('../models');
const orderController = require('./orderController');
const mpesaService = require('../services/mpesaService');

const PROVIDERS = Object.freeze({
  MPESA: 'mpesa',
  CARD: 'card',
  MANUAL: 'manual'
});

const PAYMENT_STATUSES = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  REFUNDED: 'refunded'
});

const ORDER_CANCELLED = 'cancelled';

const MPESA_SETUP_URL = 'https://developer.safaricom.co.ke/';

const MAX_LOG_LENGTH = 15000;
const MAX_PHONE_LENGTH = 20;
const MAX_REFERENCE_LENGTH = 120;

const ADMIN_ROLES = new Set([
  'owner',
  'admin'
]);

function successResponse(res, statusCode, message, data = {}) {
  return res.status(statusCode).json({
    success: true,
    message,
    ...data
  });
}

function errorResponse(res, statusCode, message, data = {}) {
  return res.status(statusCode).json({
    success: false,
    error: message,
    ...data
  });
}

function serverError(res, message, err) {
  console.error(message, err);

  return errorResponse(res, 500, message);
}

function normalizeString(value) {
  return typeof value === 'string'
    ? value.trim()
    : '';
}

function isValidObjectId(value) {
  return (
    typeof value === 'string' &&
    mongoose.Types.ObjectId.isValid(value)
  );
}

function getUserId(req) {
  return req.user?.id || req.user?._id || null;
}

function isAuthenticated(req) {
  return Boolean(getUserId(req));
}

function getUserRole(req) {
  return String(req.user?.role || '')
    .trim()
    .toLowerCase();
}

function isAdmin(req) {
  return ADMIN_ROLES.has(getUserRole(req));
}

function isPendingOrder(order) {
  return Boolean(
    order &&
    order.payment_status === PAYMENT_STATUSES.PENDING &&
    order.order_status !== ORDER_CANCELLED
  );
}

function normalizePhone(value) {
  if (
    value === null ||
    value === undefined ||
    !['string', 'number'].includes(typeof value)
  ) {
    return null;
  }

  let phone = String(value)
    .trim()
    .replace(/[\s()-]/g, '');

  if (!phone || phone.length > MAX_PHONE_LENGTH) {
    return null;
  }

  if (phone.startsWith('+')) {
    phone = phone.slice(1);
  }

  if (/^0[17]\d{8}$/.test(phone)) {
    phone = `254${phone.slice(1)}`;
  } else if (/^[17]\d{8}$/.test(phone)) {
    phone = `254${phone}`;
  }

  return /^254[17]\d{8}$/.test(phone)
    ? phone
    : null;
}

function maskPhone(value) {
  const phone = normalizePhone(value);

  if (!phone) {
    return '***';
  }

  return `${phone.slice(0, 5)}****${phone.slice(-2)}`;
}

function normalizeAmount(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const amount = Number(value);

  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isSafeInteger(Math.round(amount))
  ) {
    return null;
  }

  return Math.round(amount);
}

const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'access_token',
  'refresh_token',
  'consumer_secret',
  'consumer_key',
  'passkey',
  'authorization',
  'api_key',
  'apikey',
  'secret',
  'signature'
]);

const PHONE_KEYS = new Set([
  'phone',
  'phonenumber',
  'msisdn',
  'customer_phone',
  'callback_phone'
]);

function sanitizeLogPayload(value, depth = 0) {
  if (value === undefined || value === null) {
    return null;
  }

  if (depth > 10) {
    return '[Maximum nesting depth reached]';
  }

  if (Array.isArray(value)) {
    return value.map(item =>
      sanitizeLogPayload(item, depth + 1)
    );
  }

  if (typeof value !== 'object') {
    return value;
  }

  const sanitized = {};

  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();

    if (SENSITIVE_KEYS.has(normalizedKey)) {
      sanitized[key] = '[REDACTED]';
      continue;
    }

    if (PHONE_KEYS.has(normalizedKey)) {
      sanitized[key] = maskPhone(item);
      continue;
    }

    sanitized[key] = sanitizeLogPayload(
      item,
      depth + 1
    );
  }

  return sanitized;
}

function serializeLogPayload(value) {
  if (value === undefined || value === null) {
    return null;
  }

  let serialized;

  try {
    serialized = JSON.stringify(
      sanitizeLogPayload(value)
    );
  } catch (err) {
    serialized = JSON.stringify({
      message: 'Unable to serialize payment payload.'
    });
  }

  if (serialized.length > MAX_LOG_LENGTH) {
    serialized = serialized.slice(0, MAX_LOG_LENGTH);
  }

  return serialized;
}

async function logPayment(
  orderId,
  provider,
  eventType,
  request,
  response,
  status
) {
  return PaymentLog.create({
    order_id: orderId || null,
    provider,
    event_type: eventType,
    request_payload: serializeLogPayload(request),
    response_payload: serializeLogPayload(response),
    status: status || null
  });
}

async function logPaymentSafely(...args) {
  try {
    return await logPayment(...args);
  } catch (err) {
    console.error(
      'Payment audit logging failed:',
      err.message
    );

    return null;
  }
}

async function findOrder(orderId) {
  if (!isValidObjectId(orderId)) {
    return null;
  }

  return Order.findById(orderId);
}

function canAccessPaymentOrder(
  req,
  order,
  suppliedPhone = null
) {
  if (!order) {
    return false;
  }

  if (isAdmin(req)) {
    return true;
  }

  const userId = getUserId(req);

  if (userId) {
    return (
      String(order.user_id || '') === String(userId)
    );
  }

  const storedPhone = normalizePhone(
    order.customer_phone
  );

  const submittedPhone = normalizePhone(
    suppliedPhone
  );

  return Boolean(
    storedPhone &&
    submittedPhone &&
    storedPhone === submittedPhone
  );
}

function validateOrderPayment(order, provider) {
  if (!order) {
    return {
      valid: false,
      status: 404,
      message: 'Order not found.'
    };
  }

  if (order.payment_method !== provider) {
    return {
      valid: false,
      status: 400,
      message: 'This order uses a different payment method.'
    };
  }

  if (order.payment_status === PAYMENT_STATUSES.PAID) {
    return {
      valid: false,
      status: 409,
      message: 'This order has already been paid.'
    };
  }

  if (!isPendingOrder(order)) {
    return {
      valid: false,
      status: 400,
      message: 'This order is not available for payment.'
    };
  }

  const amount = normalizeAmount(order.total_kes);

  if (!amount) {
    return {
      valid: false,
      status: 400,
      message:
        'The order has an invalid payment amount. Please contact the shop administrator.'
    };
  }

  return {
    valid: true,
    amount
  };
}

function isMpesaConfigured() {
  try {
    if (
      !mpesaService ||
      typeof mpesaService.getConfig !== 'function'
    ) {
      return false;
    }

    mpesaService.getConfig();

    return true;
  } catch (err) {
    return false;
  }
}

function isCardConfigured() {
  return Boolean(
    process.env.PESAPAL_CONSUMER_KEY &&
    process.env.PESAPAL_CONSUMER_SECRET
  );
}

function getMpesaConfigurationResponse(order) {
  return {
    success: false,
    error: 'M-Pesa is not configured.',
    message:
      'Check your Daraja credentials, environment settings and callback URL.',
    order_id: String(order._id),
    order_number: order.order_number,
    amount: normalizeAmount(order.total_kes),
    setup_guide: MPESA_SETUP_URL
  };
}

exports.mpesaStkPush = async (req, res) => {
  let order = null;

  try {
    const orderId = normalizeString(
      req.body?.order_id
    );

    const submittedPhone = req.body?.phone;

    if (!orderId || !submittedPhone) {
      return errorResponse(
        res,
        400,
        'Order ID and phone number are required.'
      );
    }

    if (!isValidObjectId(orderId)) {
      return errorResponse(
        res,
        400,
        'Invalid order ID.'
      );
    }

    order = await findOrder(orderId);

    if (!order) {
      return errorResponse(
        res,
        404,
        'Order not found.'
      );
    }

    const phone = normalizePhone(submittedPhone);

    if (!phone) {
      return errorResponse(
        res,
        400,
        'Enter a valid Kenyan mobile number starting with 07, 01, 2547 or 2541.'
      );
    }

    if (!canAccessPaymentOrder(
      req,
      order,
      submittedPhone
    )) {
      return errorResponse(
        res,
        403,
        'You are not authorized to pay for this order.'
      );
    }

    const eligibility = validateOrderPayment(
      order,
      PROVIDERS.MPESA
    );

    if (!eligibility.valid) {
      return errorResponse(
        res,
        eligibility.status,
        eligibility.message
      );
    }

    if (!isMpesaConfigured()) {
      await logPaymentSafely(
        order._id,
        PROVIDERS.MPESA,
        'stk_push_not_configured',
        {
          order_id: String(order._id),
          phone,
          amount: eligibility.amount
        },
        {
          message:
            'M-Pesa service configuration is invalid.'
        },
        'not_configured'
      );

      return res.status(503).json(
        getMpesaConfigurationResponse(order)
      );
    }

    if (order.mpesa_checkout_request_id) {
      return errorResponse(
        res,
        409,
        'An M-Pesa payment request already exists for this order.',
        {
          order_id: String(order._id),
          order_number: order.order_number,
          message:
            'Check the payment status before attempting another prompt.'
        }
      );
    }

    const result = await mpesaService.initiateStkPush({
      phone,
      amount: eligibility.amount,
      orderNumber: order.order_number
    });

    if (
      !result ||
      !result.checkoutRequestId
    ) {
      throw new Error(
        'M-Pesa service did not return a checkout request ID.'
      );
    }

    order.mpesa_checkout_request_id =
      result.checkoutRequestId;

    try {
      await order.save();
    } catch (saveError) {

      await logPaymentSafely(
        order._id,
        PROVIDERS.MPESA,
        'stk_push_persistence_failed',
        {
          phone,
          amount: eligibility.amount
        },
        {
          checkout_request_id:
            result.checkoutRequestId,
          merchant_request_id:
            result.merchantRequestId,
          error: saveError.message
        },
        'reconciliation_required'
      );

      console.error(
        'M-Pesa request was created but order persistence failed:',
        saveError
      );

      return errorResponse(
        res,
        503,
        'The M-Pesa request may have been sent, but its reference could not be saved.',
        {
          order_id: String(order._id),
          message:
            'Do not retry immediately. Reconcile the transaction before creating another payment request.'
        }
      );
    }

    await logPaymentSafely(
      order._id,
      PROVIDERS.MPESA,
      'stk_push_initiated',
      {
        phone,
        amount: result.amount || eligibility.amount,
        order_number: order.order_number
      },
      {
        checkout_request_id:
          result.checkoutRequestId,
        merchant_request_id:
          result.merchantRequestId,
        response_code: result.responseCode
      },
      'pending'
    );

    return successResponse(
      res,
      200,
      result.customerMessage ||
        'M-Pesa payment prompt sent. Check your phone.',
      {
        order_id: String(order._id),
        order_number: order.order_number,
        checkout_request_id:
          result.checkoutRequestId,
        amount: eligibility.amount,
        phone: maskPhone(phone),
        payment_status: PAYMENT_STATUSES.PENDING
      }
    );
  } catch (err) {
    console.error('M-Pesa STK Push error:', err);

    if (order) {
      await logPaymentSafely(
        order._id,
        PROVIDERS.MPESA,
        'stk_push_error',
        {
          order_id: String(order._id)
        },
        {
          message: err.message
        },
        'error'
      );
    }

    return errorResponse(
      res,
      502,
      'Unable to initiate the M-Pesa payment. Check the payment status before trying again.'
    );
  }
};

function getCallbackMetadata(callback) {
  const items = callback?.CallbackMetadata?.Item;

  return Array.isArray(items)
    ? items
    : [];
}

function getMetadataValue(metadata, name) {
  const item = metadata.find(
    entry => entry?.Name === name
  );

  return item?.Value ?? null;
}

function extractMpesaCallback(body) {
  const callback = body?.Body?.stkCallback;

  if (!callback) {
    return null;
  }

  const rawResultCode = callback.ResultCode;
  const resultCode = Number(rawResultCode);

  if (
    rawResultCode === undefined ||
    rawResultCode === null ||
    !Number.isInteger(resultCode)
  ) {
    return null;
  }

  const metadata = getCallbackMetadata(callback);

  return {
    resultCode,
    resultDescription: callback.ResultDesc || '',
    checkoutRequestId:
      callback.CheckoutRequestID || null,
    merchantRequestId:
      callback.MerchantRequestID || null,
    amount: getMetadataValue(metadata, 'Amount'),
    receipt: getMetadataValue(
      metadata,
      'MpesaReceiptNumber'
    ),
    phone: getMetadataValue(
      metadata,
      'PhoneNumber'
    )
  };
}

async function findOrderByCheckoutRequestId(
  checkoutRequestId
) {
  if (
    typeof checkoutRequestId !== 'string' ||
    !checkoutRequestId.trim()
  ) {
    return null;
  }

  return Order.findOne({
    payment_method: PROVIDERS.MPESA,
    mpesa_checkout_request_id:
      checkoutRequestId.trim()
  });
}

async function receiptAlreadyUsed(receipt, orderId) {
  if (!receipt) {
    return false;
  }

  return Boolean(
    await Order.exists({
      mpesa_receipt: receipt,
      _id: { $ne: orderId }
    })
  );
}

function acknowledgeMpesaCallback(res) {
  return res.status(200).json({
    ResultCode: 0,
    ResultDesc: 'Accepted'
  });
}

exports.mpesaCallback = async (req, res) => {
  const body = req.body || {};

  try {
    await logPaymentSafely(
      null,
      PROVIDERS.MPESA,
      'callback_received',
      body,
      null,
      'received'
    );

    const data = extractMpesaCallback(body);

    if (!data) {
      await logPaymentSafely(
        null,
        PROVIDERS.MPESA,
        'callback_invalid',
        body,
        {
          message:
            'Invalid M-Pesa callback structure.'
        },
        'invalid'
      );

      return acknowledgeMpesaCallback(res);
    }

    const order = await findOrderByCheckoutRequestId(
      data.checkoutRequestId
    );

    if (!order) {
      await logPaymentSafely(
        null,
        PROVIDERS.MPESA,
        'callback_order_not_found',
        {
          checkout_request_id:
            data.checkoutRequestId
        },
        {
          result_code: data.resultCode,
          receipt: data.receipt
        },
        'unmatched'
      );

      return acknowledgeMpesaCallback(res);
    }

    if (data.resultCode !== 0) {
      await logPaymentSafely(
        order._id,
        PROVIDERS.MPESA,
        'payment_failed',
        {
          checkout_request_id:
            data.checkoutRequestId,
          merchant_request_id:
            data.merchantRequestId
        },
        {
          result_code: data.resultCode,
          result_description:
            data.resultDescription
        },
        'failed'
      );

      return acknowledgeMpesaCallback(res);
    }

    if (
      !data.receipt ||
      !data.checkoutRequestId
    ) {
      await logPaymentSafely(
        order._id,
        PROVIDERS.MPESA,
        'callback_invalid_success',
        {
          checkout_request_id:
            data.checkoutRequestId
        },
        {
          message:
            'Successful callback is missing payment identifiers.'
        },
        'invalid'
      );

      return acknowledgeMpesaCallback(res);
    }

    const callbackAmount = normalizeAmount(
      data.amount
    );

    const expectedAmount = normalizeAmount(
      order.total_kes
    );

    if (
      !callbackAmount ||
      !expectedAmount ||
      callbackAmount !== expectedAmount
    ) {
      await logPaymentSafely(
        order._id,
        PROVIDERS.MPESA,
        'callback_amount_mismatch',
        {
          checkout_request_id:
            data.checkoutRequestId
        },
        {
          expected_amount: expectedAmount,
          received_amount: callbackAmount,
          receipt: data.receipt
        },
        'mismatch'
      );

      return acknowledgeMpesaCallback(res);
    }

    if (
      order.payment_status === PAYMENT_STATUSES.PAID
    ) {
      await logPaymentSafely(
        order._id,
        PROVIDERS.MPESA,
        'duplicate_callback',
        {
          checkout_request_id:
            data.checkoutRequestId
        },
        {
          receipt: data.receipt
        },
        'duplicate'
      );

      return acknowledgeMpesaCallback(res);
    }

    if (!isPendingOrder(order)) {
      await logPaymentSafely(
        order._id,
        PROVIDERS.MPESA,
        'callback_order_not_payable',
        {
          checkout_request_id:
            data.checkoutRequestId
        },
        {
          payment_status: order.payment_status,
          order_status: order.order_status
        },
        'rejected'
      );

      return acknowledgeMpesaCallback(res);
    }

    const receipt = String(data.receipt).trim();

    if (await receiptAlreadyUsed(
      receipt,
      order._id
    )) {
      await logPaymentSafely(
        order._id,
        PROVIDERS.MPESA,
        'duplicate_receipt',
        {
          checkout_request_id:
            data.checkoutRequestId
        },
        {
          receipt
        },
        'duplicate'
      );

      return acknowledgeMpesaCallback(res);
    }

    if (
      data.phone !== null &&
      data.phone !== undefined
    ) {
      const callbackPhone = normalizePhone(
        data.phone
      );

      const orderPhone = normalizePhone(
        order.customer_phone
      );

      if (
        !callbackPhone ||
        !orderPhone ||
        callbackPhone !== orderPhone
      ) {
        await logPaymentSafely(
          order._id,
          PROVIDERS.MPESA,
          'callback_phone_mismatch',
          {
            checkout_request_id:
              data.checkoutRequestId
          },
          {
            callback_phone: maskPhone(data.phone),
            order_phone: maskPhone(
              order.customer_phone
            )
          },
          'mismatch'
        );

        return acknowledgeMpesaCallback(res);
      }
    }

    const updatedOrder = await orderController.markPaid(
      order._id,
      {
        mpesa_receipt: receipt,
        payment_reference:
          String(data.checkoutRequestId)
      }
    );

    if (!updatedOrder) {
      throw new Error(
        'Unable to confirm the paid order.'
      );
    }

    await logPaymentSafely(
      order._id,
      PROVIDERS.MPESA,
      'payment_success',
      {
        checkout_request_id:
          data.checkoutRequestId
      },
      {
        receipt,
        amount: callbackAmount
      },
      'paid'
    );

    return acknowledgeMpesaCallback(res);
  } catch (err) {
    console.error(
      'M-Pesa callback processing error:',
      err
    );

    await logPaymentSafely(
      null,
      PROVIDERS.MPESA,
      'callback_processing_error',
      null,
      {
        message: err.message
      },
      'error'
    );

    return acknowledgeMpesaCallback(res);
  }
};

exports.cardInitiate = async (req, res) => {
  try {
    const orderId = normalizeString(
      req.body?.order_id
    );

    if (!orderId) {
      return errorResponse(
        res,
        400,
        'Order ID is required.'
      );
    }

    if (!isValidObjectId(orderId)) {
      return errorResponse(
        res,
        400,
        'Invalid order ID.'
      );
    }

    const order = await findOrder(orderId);

    if (!order) {
      return errorResponse(
        res,
        404,
        'Order not found.'
      );
    }

    if (!canAccessPaymentOrder(
      req,
      order,
      req.body?.phone
    )) {
      return errorResponse(
        res,
        403,
        'You are not authorized to pay for this order.'
      );
    }

    const eligibility = validateOrderPayment(
      order,
      PROVIDERS.CARD
    );

    if (!eligibility.valid) {
      return errorResponse(
        res,
        eligibility.status,
        eligibility.message
      );
    }

    if (!isCardConfigured()) {
      await logPaymentSafely(
        order._id,
        PROVIDERS.CARD,
        'card_not_configured',
        {
          order_id: String(order._id),
          amount: eligibility.amount
        },
        {
          message:
            'Pesapal credentials are missing.'
        },
        'not_configured'
      );

      return errorResponse(
        res,
        503,
        'Card payments are not configured.'
      );
    }

    await logPaymentSafely(
      order._id,
      PROVIDERS.CARD,
      'card_integration_incomplete',
      {
        order_id: String(order._id),
        amount: eligibility.amount
      },
      {
        message:
          'Credentials exist, but a real Pesapal request has not been implemented.'
      },
      'pending_integration'
    );

    return errorResponse(
      res,
      501,
      'Pesapal integration is incomplete.',
      {
        order_id: String(order._id),
        amount: eligibility.amount,
        message:
          'Connect the Pesapal service before accepting card payments.'
      }
    );
  } catch (err) {
    return serverError(
      res,
      'Card payment initiation failed.',
      err
    );
  }
};

exports.cardCallback = async (req, res) => {
  try {
    await logPaymentSafely(
      null,
      PROVIDERS.CARD,
      'callback_received',
      {
        body: req.body || {},
        query: req.query || {}
      },
      null,
      'received'
    );

    return successResponse(
      res,
      200,
      'Card payment callback received.'
    );
  } catch (err) {
    return serverError(
      res,
      'Card payment callback failed.',
      err
    );
  }
};

exports.adminMarkPaid = async (req, res) => {
  try {
    if (!isAuthenticated(req)) {
      return errorResponse(
        res,
        401,
        'Authentication required.'
      );
    }

    if (!isAdmin(req)) {
      return errorResponse(
        res,
        403,
        'Owner or administrator access required.'
      );
    }

    const orderId = normalizeString(
      req.params?.id
    );

    if (!isValidObjectId(orderId)) {
      return errorResponse(
        res,
        400,
        'Invalid order ID.'
      );
    }

    const order = await Order.findById(orderId);

    if (!order) {
      return errorResponse(
        res,
        404,
        'Order not found.'
      );
    }

    if (
      order.payment_status === PAYMENT_STATUSES.PAID
    ) {
      return errorResponse(
        res,
        409,
        'This order has already been paid.'
      );
    }

    if (order.order_status === ORDER_CANCELLED) {
      return errorResponse(
        res,
        400,
        'A cancelled order cannot be marked as paid.'
      );
    }

    const amount = normalizeAmount(order.total_kes);

    if (!amount) {
      return errorResponse(
        res,
        400,
        'This order has an invalid payment amount. Correct the order total before confirming payment.'
      );
    }

    const receipt = normalizeString(
      req.body?.mpesa_receipt
    );

    const reference = normalizeString(
      req.body?.payment_reference
    );

    if (!reference) {
      return errorResponse(
        res,
        400,
        'A verified payment reference is required.'
      );
    }

    if (reference.length > MAX_REFERENCE_LENGTH) {
      return errorResponse(
        res,
        400,
        'Payment reference is too long.'
      );
    }

    if (receipt) {
      if (receipt.length > MAX_REFERENCE_LENGTH) {
        return errorResponse(
          res,
          400,
          'M-Pesa receipt is too long.'
        );
      }

      if (await receiptAlreadyUsed(
        receipt,
        order._id
      )) {
        return errorResponse(
          res,
          409,
          'This M-Pesa receipt has already been used for another order.'
        );
      }
    }

    const updatedOrder = await orderController.markPaid(
      order._id,
      {
        mpesa_receipt: receipt || null,
        payment_reference: reference
      }
    );

    if (!updatedOrder) {
      return errorResponse(
        res,
        400,
        'Unable to mark order as paid.'
      );
    }

    await logPaymentSafely(
      order._id,
      PROVIDERS.MANUAL,
      'admin_mark_paid',
      {
        admin_user_id: String(getUserId(req)),
        admin_role: getUserRole(req),
        mpesa_receipt: receipt || null,
        payment_reference: reference,
        amount
      },
      {
        payment_status: PAYMENT_STATUSES.PAID
      },
      'paid'
    );

    return successResponse(
      res,
      200,
      'Order successfully marked as paid.',
      {
        order: updatedOrder
      }
    );
  } catch (err) {
    return serverError(
      res,
      'Failed to mark order as paid.',
      err
    );
  }
};

exports.logPayment = logPayment;
exports.logPaymentSafely = logPaymentSafely;

exports.normalizePhone = normalizePhone;
exports.maskPhone = maskPhone;
exports.normalizeAmount = normalizeAmount;

exports.isMpesaConfigured = isMpesaConfigured;
exports.isCardConfigured = isCardConfigured;

exports.canAccessPaymentOrder = canAccessPaymentOrder;
exports.validateOrderPayment = validateOrderPayment;