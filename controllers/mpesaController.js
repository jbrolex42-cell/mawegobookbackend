
'use strict';

const mongoose = require('mongoose');

const {
  Order,
  MpesaTransaction,
  PaymentLog
} = require('../models');

const mpesaService = require('../services/mpesaService');
const orderController = require('./orderController');

const PROVIDER = 'mpesa';
const ACTIVE_STATUSES = ['initiated', 'pending'];

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

function isValidObjectId(value) {
  return (
    typeof value === 'string' &&
    /^[a-f\d]{24}$/i.test(value) &&
    mongoose.Types.ObjectId.isValid(value)
  );
}

function getUserId(req) {
  return req.user?._id || req.user?.id || null;
}

function serialize(value) {
  if (value === undefined || value === null) return null;

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
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
      request_payload: serialize(requestPayload),
      response_payload: serialize(responsePayload),
      status: status || null
    });
  } catch (error) {
    // Logging must never interrupt a payment operation.
    logError('Payment log write failed', error);
  }
}

function callbackAck(res, description = 'Accepted') {
  return res.status(200).json({
    ResultCode: 0,
    ResultDesc: description
  });
}

function callbackMetadata(callback) {
  const items = callback?.CallbackMetadata?.Item;

  if (!Array.isArray(items)) return {};

  return items.reduce((result, item) => {
    if (item && typeof item.Name === 'string') {
      result[item.Name] = item.Value;
    }

    return result;
  }, {});
}

function safeMessage(error) {
  const message = String(error?.message || '');

  // Never return internal configuration or credential details.
  if (
    /consumer.?key|consumer.?secret|passkey|access.?token|authorization|bearer/i.test(
      message
    )
  ) {
    return 'M-Pesa configuration or authentication failed. Please contact support.';
  }

  return message || 'Unable to process the M-Pesa request.';
}

async function setTransactionFailure(transaction, message, payload) {
  transaction.status = 'failed';
  transaction.result_description = message;

  if (payload !== undefined) {
    transaction.request_response = payload;
  }

  await transaction.save();
}

async function findActiveTransaction(orderId) {
  return MpesaTransaction.findOne({
    order_id: orderId,
    status: { $in: ACTIVE_STATUSES }
  }).select('_id status checkout_request_id');
}

// -----------------------------------------------------------------------------
// INITIATE STK PUSH
// -----------------------------------------------------------------------------

exports.initiateStk = async (req, res) => {
  let transaction = null;

  try {
    const { order_id, phone } = req.body || {};

    if (!isValidObjectId(order_id)) {
      return sendError(res, 400, 'Invalid order ID.');
    }

    if (typeof phone !== 'string' || !phone.trim()) {
      return sendError(res, 400, 'M-Pesa phone number is required.');
    }

    const order = await Order.findById(order_id);

    if (!order) {
      return sendError(res, 404, 'Order not found.');
    }

    if (String(order.payment_method).toLowerCase() !== PROVIDER) {
      return sendError(
        res,
        400,
        'This order is not configured for M-Pesa payment.'
      );
    }

    if (String(order.payment_status).toLowerCase() === 'paid') {
      return sendError(res, 409, 'This order has already been paid.');
    }

    if (!['pending', 'failed'].includes(
      String(order.payment_status).toLowerCase()
    )) {
      return sendError(
        res,
        409,
        'This order cannot currently accept an M-Pesa payment.'
      );
    }

    const userId = getUserId(req);

    if (
      userId &&
      order.user_id &&
      String(order.user_id) !== String(userId)
    ) {
      return sendError(res, 403, 'You cannot pay for this order.');
    }

    let normalizedPhone;
    let savedPhone;

    try {
      normalizedPhone = mpesaService.normalizePhone(phone);
      savedPhone = mpesaService.normalizePhone(order.customer_phone);
    } catch {
      return sendError(
        res,
        400,
        'Enter a valid Kenyan M-Pesa phone number.'
      );
    }

    if (normalizedPhone !== savedPhone) {
      return sendError(
        res,
        400,
        'The M-Pesa number must match the phone number used for this order.'
      );
    }

    const amount = mpesaService.normalizeAmount(order.total_kes);

    if (!order.order_number) {
      return sendError(res, 400, 'The order reference is missing.');
    }

    const active = await findActiveTransaction(order._id);

    if (active) {
      return sendError(
        res,
        409,
        'An M-Pesa request is already active for this order. Check your phone or wait for its result before trying again.',
        {
          order_number: order.order_number,
          checkout_request_id: active.checkout_request_id || null
        }
      );
    }

    // Save an initiation record before contacting Safaricom.
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

    const result = await mpesaService.initiateStkPush({
      phone: normalizedPhone,
      amount,
      orderNumber: order.order_number
    });

    // mpesaService returns camelCase fields.
    if (
      result?.success !== true ||
      String(result.responseCode) !== '0' ||
      !result.checkoutRequestId ||
      !result.merchantRequestId
    ) {
      throw new Error(
        result?.responseDescription ||
        'Safaricom did not accept the STK request.'
      );
    }

    transaction.merchant_request_id = result.merchantRequestId;
    transaction.checkout_request_id = result.checkoutRequestId;
    transaction.status = 'pending';
    transaction.request_response = result;

    await transaction.save();

    await logPayment(
      order._id,
      'stk_initiation_accepted',
      {
        phone: normalizedPhone,
        amount,
        order_number: order.order_number
      },
      result,
      'pending'
    );

    return res.status(200).json({
      success: true,
      message:
        result.customerMessage ||
        'M-Pesa prompt sent. Check your phone and enter your M-Pesa PIN.',
      order_id: String(order._id),
      order_number: order.order_number,
      amount,
      phone: normalizedPhone,
      checkout_request_id: result.checkoutRequestId,
      payment_status: 'pending'
    });
  } catch (error) {
    logError('M-Pesa STK initiation', error);

    if (transaction) {
      try {
        if (error.uncertain || error.code === 'MPESA_REQUEST_TIMEOUT') {
          // Safaricom may have received the request even though our
          // server did not receive its response. Do not invite a duplicate.
          transaction.status = 'pending';
          transaction.result_description =
            'Request outcome is uncertain. Verify transaction status before retrying.';
          await transaction.save();

          await logPayment(
            transaction.order_id,
            'stk_initiation_uncertain',
            null,
            { message: safeMessage(error) },
            'pending'
          );

          return sendError(
            res,
            202,
            'The payment request timed out and its status is not yet known. Do not send another prompt yet. Check your phone or contact support.',
            { payment_status: 'pending' }
          );
        }

        await setTransactionFailure(
          transaction,
          safeMessage(error),
          {
            message: safeMessage(error),
            provider_code: error.providerCode || null
          }
        );

        await logPayment(
          transaction.order_id,
          'stk_initiation_failed',
          null,
          {
            message: safeMessage(error),
            provider_code: error.providerCode || null
          },
          'failed'
        );
      } catch (saveError) {
        logError('Could not update failed STK transaction', saveError);
      }
    }

    const status = Number(error.statusCode);

    return sendError(
      res,
      status >= 400 && status < 500 ? status : 502,
      safeMessage(error)
    );
  }
};

// -----------------------------------------------------------------------------
// PROCESS SAFARICOM CALLBACK
// -----------------------------------------------------------------------------

exports.callback = async (req, res) => {
  const callback = req.body?.Body?.stkCallback;

  if (
    !callback ||
    !callback.CheckoutRequestID ||
    callback.ResultCode === undefined
  ) {
    logError(
      'M-Pesa callback',
      new Error('Invalid callback structure received.')
    );

    return callbackAck(res, 'Invalid callback received');
  }

  const checkoutRequestId = String(callback.CheckoutRequestID);

  try {
    const transaction = await MpesaTransaction.findOne({
      checkout_request_id: checkoutRequestId
    });

    if (!transaction) {
      logError(
        'M-Pesa callback',
        new Error(`Unknown CheckoutRequestID: ${checkoutRequestId}`)
      );

      return callbackAck(res, 'Transaction not found');
    }

    // Safaricom may send the same callback more than once.
    if (transaction.status === 'success') {
      return callbackAck(res, 'Payment already processed');
    }

    const resultCode = Number(callback.ResultCode);

    transaction.callback_payload = req.body;
    transaction.result_code = resultCode;
    transaction.result_description = callback.ResultDesc || null;

    if (resultCode !== 0) {
      transaction.status = 'failed';
      await transaction.save();

      const anotherActive = await MpesaTransaction.exists({
        order_id: transaction.order_id,
        status: { $in: ACTIVE_STATUSES },
        _id: { $ne: transaction._id }
      });

      if (!anotherActive) {
        await Order.updateOne(
          {
            _id: transaction.order_id,
            payment_status: 'pending'
          },
          {
            $set: { payment_status: 'failed' }
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

      return callbackAck(res, 'Payment was not completed');
    }

    const metadata = callbackMetadata(callback);

    const receipt = String(metadata.MpesaReceiptNumber || '').trim();
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

    if (
      !receipt ||
      !Number.isSafeInteger(paidAmount) ||
      paidAmount < 1 ||
      !paidPhone
    ) {
      transaction.status = 'failed';
      transaction.result_description =
        'Successful callback did not contain valid payment details.';
      await transaction.save();

      await logPayment(
        transaction.order_id,
        'stk_callback_invalid_metadata',
        null,
        req.body,
        'failed'
      );

      return callbackAck(res, 'Invalid payment metadata');
    }

    if (paidAmount !== Number(transaction.amount_kes)) {
      transaction.status = 'failed';
      transaction.result_description = 'Payment amount mismatch.';
      await transaction.save();

      await logPayment(
        transaction.order_id,
        'stk_callback_amount_mismatch',
        null,
        req.body,
        'failed'
      );

      return callbackAck(res, 'Payment amount mismatch');
    }

    if (paidPhone !== transaction.phone) {
      transaction.status = 'failed';
      transaction.result_description = 'Payment phone number mismatch.';
      await transaction.save();

      await logPayment(
        transaction.order_id,
        'stk_callback_phone_mismatch',
        null,
        req.body,
        'failed'
      );

      return callbackAck(res, 'Payment phone mismatch');
    }

    const duplicateReceipt = await MpesaTransaction.findOne({
      mpesa_receipt: receipt,
      status: 'success',
      _id: { $ne: transaction._id }
    }).select('_id');

    if (duplicateReceipt) {
      transaction.status = 'failed';
      transaction.result_description =
        'This M-Pesa receipt has already been recorded.';
      await transaction.save();

      await logPayment(
        transaction.order_id,
        'stk_callback_duplicate_receipt',
        null,
        { receipt, checkout_request_id: checkoutRequestId },
        'failed'
      );

      return callbackAck(res, 'Duplicate receipt');
    }

    const order = await Order.findById(transaction.order_id);

    if (!order) {
      transaction.status = 'failed';
      transaction.result_description = 'Associated order not found.';
      await transaction.save();

      await logPayment(
        transaction.order_id,
        'stk_callback_order_missing',
        null,
        req.body,
        'failed'
      );

      return callbackAck(res, 'Order not found');
    }

    const orderAmount = mpesaService.normalizeAmount(order.total_kes);

    if (
      String(order.payment_method).toLowerCase() !== PROVIDER ||
      orderAmount !== Number(transaction.amount_kes)
    ) {
      transaction.status = 'failed';
      transaction.result_description =
        'Order payment details do not match the callback.';
      await transaction.save();

      await logPayment(
        transaction.order_id,
        'stk_callback_order_validation_failed',
        null,
        req.body,
        'failed'
      );

      return callbackAck(res, 'Order validation failed');
    }

    // Do not overwrite a different completed payment.
    if (String(order.payment_status).toLowerCase() === 'paid') {
      transaction.status = 'failed';
      transaction.result_description =
        'Order was already marked paid by another transaction.';
      await transaction.save();

      return callbackAck(res, 'Order already paid');
    }

    // This call is retained from your existing controller contract.
    // orderController.markPaid must be an exported helper accepting
    // (orderId, paymentDetails), not an Express route handler.
    if (typeof orderController.markPaid !== 'function') {
      throw new Error(
        'orderController.markPaid is not exported as a payment helper.'
      );
    }

    await orderController.markPaid(order._id, {
      mpesa_receipt: receipt,
      payment_reference: checkoutRequestId,
      payment_method: PROVIDER
    });

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

    console.info(
      '[M-Pesa] Payment confirmed:',
      order.order_number,
      receipt
    );

    return callbackAck(res, 'Payment processed successfully');
  } catch (error) {
    // Daraja expects an acknowledgement. Failed internal processing
    // must be logged and reconciled; it must not be treated as paid.
    logError('M-Pesa callback processing', error);

    await logPayment(
      null,
      'stk_callback_processing_error',
      null,
      {
        checkout_request_id: checkoutRequestId,
        message: safeMessage(error)
      },
      'error'
    );

    return callbackAck(res, 'Callback received; processing requires review');
  }
};