
'use strict';

const mongoose = require('mongoose');

const {
  Order,
  MpesaTransaction,
  PaymentLog
} = require('../models');

const mpesaService = require('../services/mpesaService');
const orderController = require('./orderController');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const PROVIDER = 'mpesa';

const ACTIVE_STATUSES = [
  'initiated',
  'pending'
];

const TRANSACTION_STATUSES = [
  'initiated',
  'pending',
  'success',
  'failed'
];

const CALLBACK_SUCCESS_CODE = 0;

// -----------------------------------------------------------------------------
// General helpers
// -----------------------------------------------------------------------------

function isValidObjectId(value) {
  return (
    typeof value === 'string' &&
    /^[a-f\d]{24}$/i.test(value) &&
    mongoose.Types.ObjectId.isValid(value)
  );
}

function normalizeString(value) {
  return typeof value === 'string'
    ? value.trim()
    : '';
}

function normalizePhone(value) {
  if (typeof mpesaService.normalizePhone === 'function') {
    return mpesaService.normalizePhone(value);
  }

  let phone = String(value || '').replace(/\D/g, '');

  if (phone.startsWith('0') && phone.length === 10) {
    phone = `254${phone.slice(1)}`;
  }

  if (
    (phone.startsWith('7') || phone.startsWith('1')) &&
    phone.length === 9
  ) {
    phone = `254${phone}`;
  }

  return /^254[17]\d{8}$/.test(phone)
    ? phone
    : null;
}

function normalizeAmount(value) {
  const amount = Number(value);

  if (
    !Number.isFinite(amount) ||
    !Number.isInteger(amount) ||
    amount <= 0
  ) {
    return null;
  }

  return amount;
}

function getUserId(req) {
  return req.user?._id || req.user?.id || null;
}

function serialize(value) {
  if (value === undefined || value === null) {
    return null;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function sendError(res, status, message, extra = {}) {
  return res.status(status).json({
    success: false,
    message,
    ...extra
  });
}

function logError(context, error) {
  console.error(`[${context}]`, {
    message: error?.message || String(error),
    code: error?.code || null,
    providerCode: error?.providerCode || null
  });
}

function safeMessage(error) {
  const message = String(error?.message || '');

  if (
    /consumer.?key|consumer.?secret|passkey|access.?token|authorization|bearer/i.test(
      message
    )
  ) {
    return 'M-Pesa authentication failed. Please contact support.';
  }

  return 'Unable to initiate M-Pesa payment. Please try again or contact support.';
}

function callbackAck(res, description = 'Accepted') {
  return res.status(200).json({
    ResultCode: 0,
    ResultDesc: description
  });
}

function isSuccessResultCode(value) {
  return Number(value) === CALLBACK_SUCCESS_CODE;
}

function isUncertainError(error) {
  return Boolean(
    error?.uncertain ||
    error?.code === 'ETIMEDOUT' ||
    error?.code === 'ECONNRESET' ||
    error?.code === 'ECONNABORTED' ||
    error?.name === 'AbortError'
  );
}

// -----------------------------------------------------------------------------
// Payment logging
// -----------------------------------------------------------------------------

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
      request_payload: serialize(requestPayload),
      response_payload: serialize(responsePayload),
      status: status || null
    });
  } catch (error) {
    // Logging must never interrupt payment processing.
    logError('Payment log write failed', error);
  }
}

// -----------------------------------------------------------------------------
// Transaction helpers
// -----------------------------------------------------------------------------

async function findActiveTransaction(orderId) {
  return MpesaTransaction.findOne({
    order_id: orderId,
    status: {
      $in: ACTIVE_STATUSES
    }
  })
    .sort({
      created_at: -1
    })
    .select(
      '_id order_id status checkout_request_id merchant_request_id amount_kes phone created_at'
    );
}

async function setTransactionFailure(
  transaction,
  message,
  payload
) {
  transaction.status = 'failed';
  transaction.result_description = message;

  if (payload !== undefined) {
    transaction.request_response = payload;
  }

  await transaction.save();
}

async function setTransactionPending(
  transaction,
  message,
  payload
) {
  transaction.status = 'pending';
  transaction.result_description = message;

  if (payload !== undefined) {
    transaction.request_response = payload;
  }

  await transaction.save();
}

function callbackMetadata(callback) {
  const items = callback?.CallbackMetadata?.Item;

  if (!Array.isArray(items)) {
    return {};
  }

  return items.reduce((result, item) => {
    if (
      item &&
      typeof item.Name === 'string'
    ) {
      result[item.Name] = item.Value;
    }

    return result;
  }, {});
}

function getCallbackBody(req) {
  return req.body?.Body?.stkCallback || null;
}

// -----------------------------------------------------------------------------
// Callback validation
// -----------------------------------------------------------------------------

function validateCallbackMetadata(metadata) {
  const receipt = normalizeString(metadata.MpesaReceiptNumber);

  const amount = normalizeAmount(metadata.Amount);

  const phone = normalizePhone(metadata.PhoneNumber);

  if (!receipt) {
    return {
      valid: false,
      reason: 'Missing M-Pesa receipt number.'
    };
  }

  if (!amount) {
    return {
      valid: false,
      reason: 'Invalid M-Pesa transaction amount.'
    };
  }

  if (!phone) {
    return {
      valid: false,
      reason: 'Invalid customer phone in M-Pesa callback.'
    };
  }

  return {
    valid: true,
    receipt,
    amount,
    phone,
    transactionDate: metadata.TransactionDate || null
  };
}

// -----------------------------------------------------------------------------
// STK Push initiation
// -----------------------------------------------------------------------------

exports.initiateStk = async (req, res) => {
  let transaction = null;

  try {
    const orderId = normalizeString(req.body?.order_id);

    const suppliedPhone = normalizePhone(req.body?.phone);

    if (!isValidObjectId(orderId)) {
      return sendError(
        res,
        400,
        'A valid order ID is required.'
      );
    }

    if (!suppliedPhone) {
      return sendError(
        res,
        400,
        'Please provide a valid Kenyan M-Pesa phone number.'
      );
    }

    const order = await Order.findById(orderId);

    if (!order) {
      return sendError(
        res,
        404,
        'Order not found.'
      );
    }

    if (order.payment_method !== PROVIDER) {
      return sendError(
        res,
        400,
        'This order is not configured for M-Pesa payment.'
      );
    }

    if (order.order_status === 'cancelled') {
      return sendError(
        res,
        400,
        'This order has been cancelled and cannot be paid.'
      );
    }

    if (order.payment_status === 'paid') {
      return sendError(
        res,
        409,
        'This order has already been paid.'
      );
    }

    if (
      !['pending', 'failed'].includes(order.payment_status)
    ) {
      return sendError(
        res,
        400,
        'This order is not currently available for payment.'
      );
    }

    // Check ownership when the request is authenticated.
    const userId = getUserId(req);

    if (
      userId &&
      order.user_id &&
      String(order.user_id) !== String(userId)
    ) {
      return sendError(
        res,
        403,
        'You are not authorized to pay for this order.'
      );
    }

    const orderPhone = normalizePhone(order.customer_phone);

    if (!orderPhone || suppliedPhone !== orderPhone) {
      return sendError(
        res,
        400,
        'The M-Pesa phone number must match the phone number on your order.'
      );
    }

    const amount = normalizeAmount(order.total_kes);

    if (!amount) {
      return sendError(
        res,
        400,
        'The order has an invalid payment amount.'
      );
    }

    const orderNumber = normalizeString(order.order_number);

    if (!orderNumber) {
      return sendError(
        res,
        400,
        'The order is missing its reference number.'
      );
    }

    // Do not initiate another STK request while one is active.
    const activeTransaction = await findActiveTransaction(order._id);

    if (activeTransaction) {
      return sendError(
        res,
        409,
        'An M-Pesa payment request is already active for this order. Check your phone before trying again.',
        {
          pending: true,
          transaction: {
            id: String(activeTransaction._id),
            status: activeTransaction.status,
            checkout_request_id:
              activeTransaction.checkout_request_id || null
          }
        }
      );
    }

    // Create the local transaction before contacting Safaricom.
    transaction = await MpesaTransaction.create({
      order_id: order._id,
      phone: suppliedPhone,
      amount_kes: amount,
      account_reference: orderNumber,
      status: 'initiated'
    });

    await logPayment(
      order._id,
      'stk_initiated',
      {
        order_id: String(order._id),
        order_number: orderNumber,
        phone: suppliedPhone,
        amount
      },
      {
        transaction_id: String(transaction._id)
      },
      'initiated'
    );

    const result = await mpesaService.initiateStkPush({
      phone: suppliedPhone,
      amount,
      orderNumber
    });

    if (!result || result.success !== true) {
      const message =
        result?.responseDescription ||
        result?.message ||
        'Safaricom did not accept the payment request.';

      await setTransactionFailure(
        transaction,
        message,
        result || null
      );

      await logPayment(
        order._id,
        'stk_rejected',
        {
          transaction_id: String(transaction._id)
        },
        result || null,
        'failed'
      );

      return sendError(
        res,
        400,
        'Safaricom could not initiate your payment. Please try again.',
        {
          transaction_id: String(transaction._id)
        }
      );
    }

    const checkoutRequestId = normalizeString(
      result.checkoutRequestId
    );

    const merchantRequestId = normalizeString(
      result.merchantRequestId
    );

    // A successful STK response must include identifiers.
    if (!checkoutRequestId || !merchantRequestId) {
      const error = new Error(
        'Safaricom response did not include valid request identifiers.'
      );

      error.uncertain = true;

      throw error;
    }

    transaction.checkout_request_id = checkoutRequestId;
    transaction.merchant_request_id = merchantRequestId;
    transaction.status = 'pending';
    transaction.result_description =
      result.responseDescription ||
      'STK Push request accepted.';

    transaction.request_response = result;

    await transaction.save();

    await logPayment(
      order._id,
      'stk_accepted',
      {
        transaction_id: String(transaction._id),
        phone: suppliedPhone,
        amount
      },
      result,
      'pending'
    );

    return res.status(200).json({
      success: true,
      message:
        result.customerMessage ||
        'M-Pesa payment request sent. Please check your phone and enter your PIN.',
      pending: true,
      transaction_id: String(transaction._id),
      checkout_request_id: checkoutRequestId,
      merchant_request_id: merchantRequestId,
      amount,
      phone: suppliedPhone
    });
  } catch (error) {
    logError('M-Pesa STK initiation failed', error);

    if (transaction) {
      try {
        if (isUncertainError(error)) {
          await setTransactionPending(
            transaction,
            'Payment request outcome is uncertain. Awaiting Safaricom callback or reconciliation.',
            {
              error: error.message || 'Uncertain STK response',
              uncertain: true
            }
          );

          await logPayment(
            transaction.order_id,
            'stk_uncertain',
            {
              transaction_id: String(transaction._id)
            },
            {
              message: error.message || null
            },
            'pending'
          );

          return res.status(202).json({
            success: true,
            pending: true,
            message:
              'Your payment request may have reached Safaricom. Check your phone and do not submit another payment until its status is confirmed.',
            transaction_id: String(transaction._id),
            checkout_request_id:
              transaction.checkout_request_id || null
          });
        }

        await setTransactionFailure(
          transaction,
          'M-Pesa payment initiation failed.',
          {
            error: error.message || null
          }
        );

        await logPayment(
          transaction.order_id,
          'stk_failed',
          {
            transaction_id: String(transaction._id)
          },
          {
            message: error.message || null
          },
          'failed'
        );
      } catch (saveError) {
        logError(
          'Unable to update failed STK transaction',
          saveError
        );
      }
    }

    return sendError(
      res,
      500,
      safeMessage(error)
    );
  }
};

// -----------------------------------------------------------------------------
// Safaricom callback
// -----------------------------------------------------------------------------

exports.callback = async (req, res) => {
  const callback = getCallbackBody(req);

  if (!callback) {
    await logPayment(
      null,
      'invalid_callback',
      null,
      req.body || null,
      'invalid'
    );

    return callbackAck(
      res,
      'Invalid callback payload acknowledged.'
    );
  }

  const checkoutRequestId = normalizeString(
    callback.CheckoutRequestID
  );

  if (!checkoutRequestId) {
    await logPayment(
      null,
      'callback_missing_checkout_id',
      null,
      callback,
      'invalid'
    );

    return callbackAck(
      res,
      'Missing checkout request identifier acknowledged.'
    );
  }

  let transaction = null;

  try {
    transaction = await MpesaTransaction.findOne({
      checkout_request_id: checkoutRequestId
    });

    if (!transaction) {
      await logPayment(
        null,
        'callback_unknown_transaction',
        {
          checkout_request_id: checkoutRequestId
        },
        callback,
        'unknown'
      );

      return callbackAck(
        res,
        'Unknown transaction acknowledged.'
      );
    }

    // A previously completed callback is idempotent.
    if (transaction.status === 'success') {
      await logPayment(
        transaction.order_id,
        'duplicate_success_callback',
        {
          checkout_request_id: checkoutRequestId
        },
        callback,
        'duplicate'
      );

      return callbackAck(
        res,
        'Payment callback already processed.'
      );
    }

    const resultCode = callback.ResultCode;

    transaction.callback_payload = callback;
    transaction.result_code = resultCode;
    transaction.result_description =
      callback.ResultDesc || '';

    // -----------------------------------------------------------------------
    // Failed or cancelled STK request
    // -----------------------------------------------------------------------

    if (!isSuccessResultCode(resultCode)) {
      transaction.status = 'failed';

      await transaction.save();

      const activeTransaction = await findActiveTransaction(
        transaction.order_id
      );

      // Do not mark the order failed if another request is still active.
      if (!activeTransaction) {
        await Order.updateOne(
          {
            _id: transaction.order_id,
            payment_method: PROVIDER,
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
        {
          checkout_request_id: checkoutRequestId
        },
        callback,
        'failed'
      );

      return callbackAck(
        res,
        'Failed payment callback processed.'
      );
    }

    // -----------------------------------------------------------------------
    // Successful STK callback
    // -----------------------------------------------------------------------

    const metadata = callbackMetadata(callback);

    const validation = validateCallbackMetadata(metadata);

    if (!validation.valid) {
      // A success result with invalid metadata may still represent money
      // collected from the customer. Keep it pending for investigation.
      transaction.status = 'pending';
      transaction.result_description =
        `Successful callback requires review: ${validation.reason}`;

      await transaction.save();

      await logPayment(
        transaction.order_id,
        'callback_metadata_requires_review',
        {
          checkout_request_id: checkoutRequestId
        },
        {
          callback,
          reason: validation.reason
        },
        'review_required'
      );

      return callbackAck(
        res,
        'Successful callback received and flagged for review.'
      );
    }

    const {
      receipt,
      amount,
      phone
    } = validation;

    // Validate the callback against the original STK transaction.
    if (
      amount !== Number(transaction.amount_kes) ||
      phone !== normalizePhone(transaction.phone)
    ) {
      transaction.status = 'pending';
      transaction.result_description =
        'Successful callback amount or phone does not match the original transaction. Manual reconciliation required.';

      await transaction.save();

      await logPayment(
        transaction.order_id,
        'callback_mismatch_requires_review',
        {
          checkout_request_id: checkoutRequestId,
          expected_amount: transaction.amount_kes,
          expected_phone: transaction.phone
        },
        {
          receipt,
          received_amount: amount,
          received_phone: phone,
          callback
        },
        'review_required'
      );

      return callbackAck(
        res,
        'Payment callback received and flagged for reconciliation.'
      );
    }

    // Prevent the same M-Pesa receipt being applied to another transaction.
    const existingReceipt = await MpesaTransaction.findOne({
      _id: {
        $ne: transaction._id
      },
      mpesa_receipt: receipt
    }).select('_id order_id status');

    if (existingReceipt) {
      transaction.status = 'pending';
      transaction.result_description =
        'M-Pesa receipt is already associated with another transaction. Manual reconciliation required.';

      await transaction.save();

      await logPayment(
        transaction.order_id,
        'duplicate_receipt_requires_review',
        {
          checkout_request_id: checkoutRequestId
        },
        {
          receipt,
          existing_transaction_id: String(existingReceipt._id),
          existing_order_id: String(existingReceipt.order_id)
        },
        'review_required'
      );

      return callbackAck(
        res,
        'Duplicate receipt flagged for reconciliation.'
      );
    }

    const order = await Order.findById(transaction.order_id);

    if (!order) {
      transaction.status = 'pending';
      transaction.result_description =
        'Successful M-Pesa payment received for an order that could not be found. Manual reconciliation required.';

      await transaction.save();

      await logPayment(
        transaction.order_id,
        'payment_order_missing',
        {
          checkout_request_id: checkoutRequestId
        },
        {
          receipt,
          amount,
          phone
        },
        'review_required'
      );

      return callbackAck(
        res,
        'Payment received and flagged for reconciliation.'
      );
    }

    // Verify the stored order still matches the original payment.
    if (
      order.payment_method !== PROVIDER ||
      Number(order.total_kes) !== amount
    ) {
      transaction.status = 'pending';
      transaction.result_description =
        'Successful payment does not match the current order payment configuration. Manual reconciliation required.';

      await transaction.save();

      await logPayment(
        order._id,
        'payment_order_mismatch',
        {
          checkout_request_id: checkoutRequestId
        },
        {
          receipt,
          callback_amount: amount,
          order_amount: order.total_kes,
          payment_method: order.payment_method
        },
        'review_required'
      );

      return callbackAck(
        res,
        'Payment received and flagged for reconciliation.'
      );
    }

    // If the order was already paid with this same receipt, this is an
    // idempotent recovery of the transaction record.
    if (order.payment_status === 'paid') {
      if (
        normalizeString(order.mpesa_receipt) === receipt
      ) {
        transaction.status = 'success';
        transaction.mpesa_receipt = receipt;
        transaction.completed_at =
          transaction.completed_at || new Date();

        transaction.result_description =
          'Payment already applied to this order.';

        await transaction.save();

        await logPayment(
          order._id,
          'payment_already_applied',
          {
            checkout_request_id: checkoutRequestId
          },
          {
            receipt
          },
          'success'
        );

        return callbackAck(
          res,
          'Payment already applied.'
        );
      }

      // A different receipt means another payment may have been collected.
      transaction.status = 'pending';
      transaction.result_description =
        'Order is already paid using a different payment reference. Possible duplicate customer charge; reconciliation required.';

      await transaction.save();

      await logPayment(
        order._id,
        'second_successful_payment_requires_review',
        {
          checkout_request_id: checkoutRequestId
        },
        {
          new_receipt: receipt,
          existing_order_receipt: order.mpesa_receipt || null,
          amount
        },
        'review_required'
      );

      return callbackAck(
        res,
        'Additional successful payment flagged for reconciliation.'
      );
    }

    // A cancelled order must not be silently marked paid. The customer
    // may nevertheless have been charged by Safaricom.
    if (order.order_status === 'cancelled') {
      transaction.status = 'pending';
      transaction.result_description =
        'Payment received for a cancelled order. Refund or manual reconciliation required.';

      await transaction.save();

      await logPayment(
        order._id,
        'payment_for_cancelled_order',
        {
          checkout_request_id: checkoutRequestId
        },
        {
          receipt,
          amount
        },
        'review_required'
      );

      return callbackAck(
        res,
        'Payment received for a cancelled order and flagged for review.'
      );
    }

    // -----------------------------------------------------------------------
    // Confirm the order through the existing order controller helper.
    // -----------------------------------------------------------------------

    if (typeof orderController.markPaid !== 'function') {
      throw new Error(
        'orderController.markPaid is not available.'
      );
    }

    try {
      await orderController.markPaid(order._id, {
        mpesa_receipt: receipt,
        payment_reference: checkoutRequestId,
        payment_method: PROVIDER
      });
    } catch (paymentError) {
      // markPaid may have saved payment_status=paid before a later
      // operation (such as reward points) failed. Re-read the order
      // before deciding whether payment confirmation actually failed.
      const refreshedOrder = await Order.findById(order._id);

      if (
        refreshedOrder?.payment_status === 'paid' &&
        normalizeString(refreshedOrder.mpesa_receipt) === receipt
      ) {
        transaction.status = 'success';
        transaction.mpesa_receipt = receipt;
        transaction.completed_at = new Date();
        transaction.result_description =
          'Payment applied. A post-payment operation requires investigation.';

        transaction.callback_payload = callback;

        await transaction.save();

        await logPayment(
          order._id,
          'payment_applied_post_processing_error',
          {
            checkout_request_id: checkoutRequestId
          },
          {
            receipt,
            error: paymentError.message || null
          },
          'success'
        );

        return callbackAck(
          res,
          'Payment applied. Post-payment processing requires review.'
        );
      }

      throw paymentError;
    }

    // Confirm the saved order state before marking the transaction successful.
    const confirmedOrder = await Order.findById(order._id);

    if (
      !confirmedOrder ||
      confirmedOrder.payment_status !== 'paid' ||
      normalizeString(confirmedOrder.mpesa_receipt) !== receipt
    ) {
      throw new Error(
        'Order payment confirmation could not be verified after markPaid.'
      );
    }

    transaction.status = 'success';
    transaction.mpesa_receipt = receipt;
    transaction.completed_at = new Date();
    transaction.result_description =
      callback.ResultDesc || 'Payment completed successfully.';
    transaction.callback_payload = callback;

    await transaction.save();

    await logPayment(
      order._id,
      'payment_success',
      {
        checkout_request_id: checkoutRequestId,
        transaction_id: String(transaction._id)
      },
      {
        receipt,
        amount,
        phone
      },
      'success'
    );

    return callbackAck(
      res,
      'Payment successfully processed.'
    );
  } catch (error) {
    logError('M-Pesa callback processing failed', error);

    if (transaction) {
      try {
        // Preserve the callback and transaction for later investigation.
        // Do not mark a possibly collected payment as failed.
        transaction.status = 'pending';
        transaction.result_description =
          'Callback processing failed. Manual reconciliation required.';
        transaction.callback_payload =
          callback || transaction.callback_payload;

        await transaction.save();

        await logPayment(
          transaction.order_id,
          'callback_processing_error',
          {
            checkout_request_id: checkoutRequestId,
            transaction_id: String(transaction._id)
          },
          {
            message: error.message || null,
            callback
          },
          'review_required'
        );
      } catch (saveError) {
        logError(
          'Failed to preserve callback for reconciliation',
          saveError
        );
      }
    } else {
      await logPayment(
        null,
        'callback_processing_error',
        {
          checkout_request_id: checkoutRequestId
        },
        {
          message: error.message || null,
          callback
        },
        'review_required'
      );
    }

    // Acknowledge the callback to avoid relying on provider retries.
    // The pending transaction and payment log must be reconciled internally.
    return callbackAck(
      res,
      'Callback received. Payment status requires reconciliation.'
    );
  }
};

// -----------------------------------------------------------------------------
// Optional transaction lookup helper for internal use
// -----------------------------------------------------------------------------

exports.findActiveTransaction = findActiveTransaction;