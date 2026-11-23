
const mongoose = require('mongoose');

const {
  Order,
  MpesaTransaction,
  PaymentLog
} = require('../models');

const mpesaService = require('../services/mpesaService');
const orderController = require('./orderController');

// ------------------------------------------------------
// PAYMENT LOGGING
// ------------------------------------------------------

async function logPayment(
  orderId,
  eventType,
  requestPayload,
  responsePayload,
  status
) {
  await PaymentLog.create({
    order_id: orderId || null,
    provider: 'mpesa',
    event_type: eventType,
    request_payload: requestPayload
      ? JSON.stringify(requestPayload)
      : null,
    response_payload: responsePayload
      ? JSON.stringify(responsePayload)
      : null,
    status: status || null
  });
}

// ------------------------------------------------------
// CALLBACK METADATA
// ------------------------------------------------------

function getCallbackMetadata(callback) {
  const items = callback.CallbackMetadata?.Item || [];
  const metadata = {};

  for (const item of items) {
    if (item.Name) {
      metadata[item.Name] = item.Value;
    }
  }

  return metadata;
}

// ------------------------------------------------------
// INITIATE STK PUSH
// POST /api/payments/mpesa/stk
// ------------------------------------------------------

exports.initiateStk = async (req, res) => {
  let transaction = null;

  try {
    const { order_id, phone } = req.body || {};

    if (!mongoose.isValidObjectId(order_id)) {
      return res.status(400).json({
        error: 'Invalid order ID'
      });
    }

    if (!phone) {
      return res.status(400).json({
        error: 'M-Pesa phone number is required'
      });
    }

    const order = await Order.findById(order_id);

    if (!order) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    if (order.payment_method !== 'mpesa') {
      return res.status(400).json({
        error: 'This order is not set for M-Pesa payment'
      });
    }

    if (order.payment_status === 'paid') {
      return res.status(400).json({
        error: 'This order has already been paid'
      });
    }

    if (!['pending', 'failed'].includes(order.payment_status)) {
      return res.status(400).json({
        error: 'This order cannot accept an M-Pesa payment'
      });
    }

    // Check ownership for authenticated customers.
    const authenticatedUserId =
      req.user?._id || req.user?.id;

    if (
      authenticatedUserId &&
      order.user_id &&
      String(order.user_id) !== String(authenticatedUserId)
    ) {
      return res.status(403).json({
        error: 'You cannot pay for this order'
      });
    }

    const normalizedPhone = mpesaService.normalizePhone(phone);

    let orderPhone;

    try {
      orderPhone = mpesaService.normalizePhone(
        order.customer_phone
      );
    } catch {
      return res.status(400).json({
        error: 'The phone number saved on this order is invalid. Contact the shop for assistance.'
      });
    }

    if (orderPhone !== normalizedPhone) {
      return res.status(400).json({
        error: 'The M-Pesa phone number must match the phone number on the order'
      });
    }

    const amount = Math.round(Number(order.total_kes));

    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({
        error: 'Invalid order payment amount'
      });
    }

    // Save the transaction before contacting Safaricom.
    transaction = await MpesaTransaction.create({
      order_id: order._id,
      phone: normalizedPhone,
      amount_kes: amount,
      account_reference: order.order_number,
      status: 'initiated'
    });

    const result = await mpesaService.initiateStkPush({
      phone: normalizedPhone,
      amount,
      orderNumber: order.order_number
    });

    if (
      String(result.ResponseCode) !== '0' ||
      !result.CheckoutRequestID
    ) {
      transaction.status = 'failed';
      transaction.result_description =
        result.ResponseDescription ||
        result.errorMessage ||
        'Safaricom did not accept the STK request';

      transaction.request_response = result;

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

      return res.status(400).json({
        error: transaction.result_description
      });
    }

    transaction.merchant_request_id =
      result.MerchantRequestID;

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
    console.error(
      'M-Pesa STK initiation error:',
      error.message
    );

    if (transaction) {
      transaction.status = 'failed';
      transaction.result_description = error.message;

      await transaction.save().catch(saveError => {
        console.error(
          'Could not save failed M-Pesa transaction:',
          saveError.message
        );
      });
    }

    return res.status(500).json({
      error: error.message || 'Unable to initiate M-Pesa payment'
    });
  }
};

// ------------------------------------------------------
// SAFARICOM STK CALLBACK
// POST /api/payments/mpesa/callback
// ------------------------------------------------------

exports.callback = async (req, res) => {
  // Safaricom should always receive an acknowledgement.
  // Internal processing errors are logged separately.
  try {
    const callback = req.body?.Body?.stkCallback;

    if (!callback || !callback.CheckoutRequestID) {
      console.error('Invalid M-Pesa callback received');

      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: 'Accepted'
      });
    }

    // Match the exact STK transaction.
    const transaction = await MpesaTransaction.findOne({
      checkout_request_id: callback.CheckoutRequestID
    });

    if (!transaction) {
      console.error(
        'No matching M-Pesa transaction:',
        callback.CheckoutRequestID
      );

      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: 'Accepted'
      });
    }

    // Ignore duplicate callbacks for completed payments.
    if (transaction.status === 'success') {
      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: 'Already processed'
      });
    }

    transaction.callback_payload = req.body;
    transaction.result_code = callback.ResultCode;
    transaction.result_description = callback.ResultDesc;

    // --------------------------------------------------
    // SUCCESSFUL PAYMENT CALLBACK
    // --------------------------------------------------

    if (Number(callback.ResultCode) === 0) {
      const metadata = getCallbackMetadata(callback);

      const receipt = metadata.MpesaReceiptNumber;
      const paidAmount = Number(metadata.Amount);

      let paidPhone = null;

      if (metadata.PhoneNumber !== undefined) {
        paidPhone = mpesaService.normalizePhone(
          metadata.PhoneNumber
        );
      }

      // A successful callback must include these details.
      if (
        !receipt ||
        !Number.isFinite(paidAmount) ||
        !paidPhone
      ) {
        transaction.status = 'failed';
        transaction.result_description =
          'Payment callback is missing required payment details';

        await transaction.save();

        await logPayment(
          transaction.order_id,
          'stk_callback_invalid',
          null,
          req.body,
          'failed'
        );

        return res.status(200).json({
          ResultCode: 0,
          ResultDesc: 'Accepted'
        });
      }

      // Validate the callback against the saved transaction.
      if (paidAmount !== Number(transaction.amount_kes)) {
        transaction.status = 'failed';
        transaction.result_description =
          'Callback amount does not match the requested amount';

        await transaction.save();

        await logPayment(
          transaction.order_id,
          'stk_callback_amount_mismatch',
          null,
          req.body,
          'failed'
        );

        return res.status(200).json({
          ResultCode: 0,
          ResultDesc: 'Accepted'
        });
      }

      if (paidPhone !== transaction.phone) {
        transaction.status = 'failed';
        transaction.result_description =
          'Callback phone number does not match the requested phone number';

        await transaction.save();

        await logPayment(
          transaction.order_id,
          'stk_callback_phone_mismatch',
          null,
          req.body,
          'failed'
        );

        return res.status(200).json({
          ResultCode: 0,
          ResultDesc: 'Accepted'
        });
      }

      const order = await Order.findById(
        transaction.order_id
      );

      if (
        !order ||
        order.payment_method !== 'mpesa' ||
        Math.round(Number(order.total_kes)) !==
          Number(transaction.amount_kes)
      ) {
        transaction.status = 'failed';
        transaction.result_description =
          'Order validation failed';

        await transaction.save();

        await logPayment(
          transaction.order_id,
          'stk_callback_order_validation_failed',
          null,
          req.body,
          'failed'
        );

        return res.status(200).json({
          ResultCode: 0,
          ResultDesc: 'Accepted'
        });
      }

      // Mark paid using the existing order workflow.
      // This handles stock, points and the Brevo receipt.
      await orderController.markPaid(order._id, {
        mpesa_receipt: receipt,
        payment_reference: callback.CheckoutRequestID
      });

      transaction.status = 'success';
      transaction.mpesa_receipt = receipt;
      transaction.completed_at = new Date();

      await transaction.save();

      await logPayment(
        order._id,
        'stk_callback_success',
        null,
        {
          receipt,
          amount: paidAmount,
          phone: paidPhone,
          checkout_request_id: callback.CheckoutRequestID
        },
        'success'
      );

      console.log(
        'M-Pesa payment confirmed:',
        order.order_number,
        receipt
      );

    } else {
      // ------------------------------------------------
      // FAILED OR CANCELLED PAYMENT CALLBACK
      // ------------------------------------------------

      transaction.status = 'failed';

      await transaction.save();

      // Do not mark the order failed if another STK
      // attempt for this order is still pending.
      const anotherPendingTransaction =
        await MpesaTransaction.exists({
          order_id: transaction.order_id,
          status: {
            $in: ['initiated', 'pending']
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
        callback.ResultDesc
      );
    }

  } catch (error) {
    console.error(
      'M-Pesa callback processing error:',
      error.message
    );
  }

  return res.status(200).json({
    ResultCode: 0,
    ResultDesc: 'Accepted'
  });
};