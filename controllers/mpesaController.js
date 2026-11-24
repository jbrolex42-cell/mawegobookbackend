
'use strict';

const mongoose = require('mongoose');

const {
  Order,
  MpesaTransaction,
  PaymentLog
} = require('../models');

const mpesaService = require('../services/mpesaService');
const orderController = require('./orderController');

// ============================================================
// CONFIGURATION
// ============================================================

const PROVIDER = 'mpesa';

const ACTIVE_TRANSACTION_STATUSES = [
  'initiated',
  'pending'
];

// ============================================================
// SHARED HELPERS
// ============================================================

function sendError(res, status, message) {
  return res.status(status).json({
    error: message
  });
}

function logError(context, error) {
  console.error(
    `[${context}]`,
    error.message || error
  );
}

function isValidObjectId(id) {
  return (
    typeof id === 'string' &&
    /^[a-f\d]{24}$/i.test(id) &&
    mongoose.Types.ObjectId.isValid(id)
  );
}

function normalizeAmount(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount < 1) {
    return null;
  }

  // M-Pesa STK Push accepts whole-number amounts.
  return Math.round(amount);
}

function serializePayload(payload) {
  if (payload === undefined || payload === null) {
    return null;
  }

  try {
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

function getCallbackMetadata(callback) {
  const items = callback?.CallbackMetadata?.Item || [];
  const metadata = {};

  if (!Array.isArray(items)) {
    return metadata;
  }

  for (const item of items) {
    if (
      item &&
      typeof item.Name === 'string'
    ) {
      metadata[item.Name] = item.Value;
    }
  }

  return metadata;
}

function callbackResponse(description = 'Accepted') {
  return {
    ResultCode: 0,
    ResultDesc: description
  };
}

function getAuthenticatedUserId(req) {
  return req.user?._id || req.user?.id || null;
}

async function logPayment(
  orderId,
  eventType,
  requestPayload,
  responsePayload,
  status
) {
  try {
    await PaymentLog.create({
      order_id: orderId || null,
      provider: PROVIDER,
      event_type: eventType,
      request_payload: serializePayload(requestPayload),
      response_payload: serializePayload(responsePayload),
      status: status || null
    });
  } catch (error) {
    // Logging failures must not prevent payment processing.
    logError('Payment logging failed', error);
  }
}

async function markTransactionFailed(
  transaction,
  description
) {
  transaction.status = 'failed';
  transaction.result_description = description;

  await transaction.save();
}

async function acknowledgeCallback(res, description) {
  return res.status(200).json(
    callbackResponse(description)
  );
}

// ============================================================
// INITIATE M-PESA STK PUSH
// ============================================================

exports.initiateStk = async (req, res) => {
  let transaction = null;

  try {
    const {
      order_id,
      phone
    } = req.body || {};

    // --------------------------------------------------------
    // Validate request
    // --------------------------------------------------------

    if (!isValidObjectId(order_id)) {
      return sendError(res, 400, 'Invalid order ID');
    }

    if (
      typeof phone !== 'string' ||
      !phone.trim()
    ) {
      return sendError(
        res,
        400,
        'M-Pesa phone number is required'
      );
    }

    // --------------------------------------------------------
    // Find order
    // --------------------------------------------------------

    const order = await Order.findById(order_id);

    if (!order) {
      return sendError(res, 404, 'Order not found');
    }

    if (order.payment_method !== PROVIDER) {
      return sendError(
        res,
        400,
        'This order is not set for M-Pesa payment'
      );
    }

    if (order.payment_status === 'paid') {
      return sendError(
        res,
        400,
        'This order has already been paid'
      );
    }

    if (
      !['pending', 'failed'].includes(order.payment_status)
    ) {
      return sendError(
        res,
        400,
        'This order cannot accept an M-Pesa payment'
      );
    }

    // --------------------------------------------------------
    // Verify ownership
    // --------------------------------------------------------

    const authenticatedUserId = getAuthenticatedUserId(req);

    if (
      authenticatedUserId &&
      order.user_id &&
      String(order.user_id) !== String(authenticatedUserId)
    ) {
      return sendError(
        res,
        403,
        'You cannot pay for this order'
      );
    }

    // --------------------------------------------------------
    // Validate phone number
    // --------------------------------------------------------

    let normalizedPhone;
    let orderPhone;

    try {
      normalizedPhone = mpesaService.normalizePhone(phone);

      orderPhone = mpesaService.normalizePhone(
        order.customer_phone
      );
    } catch {
      return sendError(
        res,
        400,
        'Invalid phone number. Please check the number and try again.'
      );
    }

    if (!normalizedPhone || !orderPhone) {
      return sendError(
        res,
        400,
        'Invalid M-Pesa phone number'
      );
    }

    if (normalizedPhone !== orderPhone) {
      return sendError(
        res,
        400,
        'The M-Pesa phone number must match the phone number on the order'
      );
    }

    // --------------------------------------------------------
    // Validate payment amount
    // --------------------------------------------------------

    const amount = normalizeAmount(order.total_kes);

    if (amount === null) {
      return sendError(
        res,
        400,
        'Invalid order payment amount'
      );
    }

    if (!order.order_number) {
      return sendError(
        res,
        400,
        'Order reference is missing'
      );
    }

    // --------------------------------------------------------
    // Prevent multiple active payment prompts
    // --------------------------------------------------------

    const activeTransaction = await MpesaTransaction.findOne({
      order_id: order._id,
      status: {
        $in: ACTIVE_TRANSACTION_STATUSES
      }
    }).select('_id');

    if (activeTransaction) {
      return sendError(
        res,
        409,
        'An M-Pesa payment request is already being processed for this order. Please wait before trying again.'
      );
    }

    // --------------------------------------------------------
    // Create transaction record
    // --------------------------------------------------------

    transaction = await MpesaTransaction.create({
      order_id: order._id,
      phone: normalizedPhone,
      amount_kes: amount,
      account_reference: order.order_number,
      status: 'initiated'
    });

    await logPayment(
      order._id,
      'stk_initiation_started',
      {
        phone: normalizedPhone,
        amount,
        order_number: order.order_number
      },
      null,
      'initiated'
    );

    // --------------------------------------------------------
    // Send STK Push request
    // --------------------------------------------------------

    const result = await mpesaService.initiateStkPush({
      phone: normalizedPhone,
      amount,
      orderNumber: order.order_number
    });

    const accepted =
      String(result?.ResponseCode) === '0' &&
      Boolean(result?.CheckoutRequestID);

    if (!accepted) {
      const failureMessage =
        result?.ResponseDescription ||
        result?.errorMessage ||
        'Safaricom did not accept the STK request';

      await markTransactionFailed(
        transaction,
        failureMessage
      );

      transaction.request_response = result || null;
      await transaction.save();

      await logPayment(
        order._id,
        'stk_initiation_failed',
        {
          phone: normalizedPhone,
          amount
        },
        result,
        'failed'
      );

      return sendError(
        res,
        400,
        failureMessage
      );
    }

    // --------------------------------------------------------
    // Save Safaricom request identifiers
    // --------------------------------------------------------

    transaction.merchant_request_id =
      result.MerchantRequestID || null;

    transaction.checkout_request_id =
      result.CheckoutRequestID;

    transaction.status = 'pending';
    transaction.request_response = result;

    await transaction.save();

    await logPayment(
      order._id,
      'stk_initiation',
      {
        phone: normalizedPhone,
        amount
      },
      result,
      'pending'
    );

    // --------------------------------------------------------
    // Respond to customer
    // --------------------------------------------------------

    return res.status(200).json({
      success: true,
      message:
        result.CustomerMessage ||
        'M-Pesa payment prompt sent. Enter your M-Pesa PIN on your phone.',
      order_id: String(order._id),
      order_number: order.order_number,
      amount,
      phone: normalizedPhone,
      checkout_request_id: result.CheckoutRequestID
    });

  } catch (error) {
    logError('M-Pesa STK initiation', error);

    if (transaction) {
      try {
        transaction.status = 'failed';
        transaction.result_description =
          'Unable to complete STK initiation';

        await transaction.save();

        await logPayment(
          transaction.order_id,
          'stk_initiation_error',
          null,
          {
            message: error.message
          },
          'failed'
        );

      } catch (saveError) {
        logError(
          'Failed to update M-Pesa transaction',
          saveError
        );
      }
    }

    return sendError(
      res,
      500,
      'Unable to initiate M-Pesa payment. Please try again.'
    );
  }
};

// ============================================================
// PROCESS M-PESA STK CALLBACK
// ============================================================

exports.callback = async (req, res) => {
  try {
    // --------------------------------------------------------
    // Validate callback structure
    // --------------------------------------------------------

    const callback = req.body?.Body?.stkCallback;

    if (
      !callback ||
      !callback.CheckoutRequestID ||
      callback.ResultCode === undefined
    ) {
      logError(
        'M-Pesa callback',
        new Error('Invalid callback payload received')
      );

      return acknowledgeCallback(res);
    }

    const checkoutRequestId = String(
      callback.CheckoutRequestID
    );

    // --------------------------------------------------------
    // Find original transaction
    // --------------------------------------------------------

    const transaction = await MpesaTransaction.findOne({
      checkout_request_id: checkoutRequestId
    });

    if (!transaction) {
      logError(
        'M-Pesa callback',
        new Error(`Unknown checkout request: ${checkoutRequestId}`)
      );

      return acknowledgeCallback(res);
    }

    // --------------------------------------------------------
    // Protect against duplicate successful callbacks
    // --------------------------------------------------------

    if (transaction.status === 'success') {
      return acknowledgeCallback(
        res,
        'Payment already processed'
      );
    }

    transaction.callback_payload = req.body;
    transaction.result_code = callback.ResultCode;
    transaction.result_description =
      callback.ResultDesc || null;

    const resultCode = Number(callback.ResultCode);

    // --------------------------------------------------------
    // Process unsuccessful payment
    // --------------------------------------------------------

    if (resultCode !== 0) {
      transaction.status = 'failed';

      await transaction.save();

      // Only mark the order failed when no other payment
      // request is still active.
      const anotherPendingTransaction =
        await MpesaTransaction.exists({
          order_id: transaction.order_id,
          status: {
            $in: ACTIVE_TRANSACTION_STATUSES
          },
          _id: {
            $ne: transaction._id
          }
        });

      if (!anotherPendingTransaction) {
        await Order.updateOne(
          {
            _id: transaction.order_id,
            payment_status: 'pending'
          },
          {
            $set: {
              payment_status: 'failed'
            }
          }
        );
      }

      await logPayment(
        transaction.order_id,
        'stk_callback_failed',
        null,
        req.body,
        'failed'
      );

      console.log(
        'M-Pesa payment failed:',
        callback.ResultDesc || 'Payment unsuccessful'
      );

      return acknowledgeCallback(res);
    }

    // --------------------------------------------------------
    // Extract payment metadata
    // --------------------------------------------------------

    const metadata = getCallbackMetadata(callback);

    const receipt = metadata.MpesaReceiptNumber;
    const paidAmount = Number(metadata.Amount);

    let paidPhone = null;

    try {
      if (metadata.PhoneNumber !== undefined) {
        paidPhone = mpesaService.normalizePhone(
          String(metadata.PhoneNumber)
        );
      }
    } catch {
      paidPhone = null;
    }

    // --------------------------------------------------------
    // Validate payment details
    // --------------------------------------------------------

    if (
      typeof receipt !== 'string' ||
      !receipt.trim() ||
      !Number.isFinite(paidAmount) ||
      paidAmount <= 0 ||
      !paidPhone
    ) {
      await markTransactionFailed(
        transaction,
        'Payment callback is missing valid payment details'
      );

      await logPayment(
        transaction.order_id,
        'stk_callback_invalid',
        null,
        req.body,
        'failed'
      );

      return acknowledgeCallback(res);
    }

    if (paidAmount !== Number(transaction.amount_kes)) {
      await markTransactionFailed(
        transaction,
        'Callback amount does not match the requested amount'
      );

      await logPayment(
        transaction.order_id,
        'stk_callback_amount_mismatch',
        null,
        req.body,
        'failed'
      );

      return acknowledgeCallback(res);
    }

    if (paidPhone !== transaction.phone) {
      await markTransactionFailed(
        transaction,
        'Callback phone number does not match the requested phone number'
      );

      await logPayment(
        transaction.order_id,
        'stk_callback_phone_mismatch',
        null,
        req.body,
        'failed'
      );

      return acknowledgeCallback(res);
    }

    // --------------------------------------------------------
    // Prevent reuse of an already recorded M-Pesa receipt
    // --------------------------------------------------------

    const existingReceipt = await MpesaTransaction.findOne({
      mpesa_receipt: receipt,
      status: 'success',
      _id: {
        $ne: transaction._id
      }
    }).select('_id');

    if (existingReceipt) {
      await markTransactionFailed(
        transaction,
        'This M-Pesa receipt has already been used'
      );

      await logPayment(
        transaction.order_id,
        'stk_callback_duplicate_receipt',
        null,
        {
          receipt,
          checkout_request_id: checkoutRequestId
        },
        'failed'
      );

      return acknowledgeCallback(res);
    }

    // --------------------------------------------------------
    // Validate associated order
    // --------------------------------------------------------

    const order = await Order.findById(
      transaction.order_id
    );

    if (!order) {
      await markTransactionFailed(
        transaction,
        'Associated order was not found'
      );

      await logPayment(
        transaction.order_id,
        'stk_callback_order_missing',
        null,
        req.body,
        'failed'
      );

      return acknowledgeCallback(res);
    }

    const orderAmount = normalizeAmount(order.total_kes);

    if (
      order.payment_method !== 'mpesa' ||
      orderAmount === null ||
      orderAmount !== Number(transaction.amount_kes)
    ) {
      await markTransactionFailed(
        transaction,
        'Order payment validation failed'
      );

      await logPayment(
        transaction.order_id,
        'stk_callback_order_validation_failed',
        null,
        req.body,
        'failed'
      );

      return acknowledgeCallback(res);
    }

    // --------------------------------------------------------
    // Mark order as paid
    // --------------------------------------------------------

    await orderController.markPaid(order._id, {
      mpesa_receipt: receipt,
      payment_reference: checkoutRequestId
    });

    // --------------------------------------------------------
    // Update successful transaction
    // --------------------------------------------------------

    transaction.status = 'success';
    transaction.mpesa_receipt = receipt;
    transaction.completed_at = new Date();
    transaction.result_description =
      callback.ResultDesc || 'Payment successful';

    await transaction.save();

    await logPayment(
      order._id,
      'stk_callback_success',
      null,
      {
        receipt,
        amount: paidAmount,
        phone: paidPhone,
        checkout_request_id: checkoutRequestId
      },
      'success'
    );

    console.log(
      'M-Pesa payment confirmed:',
      order.order_number,
      receipt
    );

  } catch (error) {
    logError('M-Pesa callback processing', error);
  }

  // Safaricom expects an acknowledgement.
  // Failed internal processing is logged for investigation.
  return acknowledgeCallback(res);
};