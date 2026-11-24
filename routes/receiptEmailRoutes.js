
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const ReceiptOrder = require('../models/ReceiptOrder');
const ReceiptEmailLog = require('../models/ReceiptEmailLog');

const {
  authenticate,
  requireStaff
} = require('../middleware/auth');

const {
  sendOrderReceipt
} = require('../services/orderEmailService');

const router = express.Router();

/*
|--------------------------------------------------------------------------
| Middleware
|--------------------------------------------------------------------------
|
| All receipt management endpoints require an authenticated staff member.
|
*/

router.use(authenticate, requireStaff);

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function parseLimit(value, defaultValue = 50, maximum = 100) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return defaultValue;
  }

  return Math.min(parsed, maximum);
}

function handleServerError(error, label) {
  console.error(`${label}:`, error);
}

/*
|--------------------------------------------------------------------------
| Resend Order Receipt
|--------------------------------------------------------------------------
|
| POST /receipts/resend/:id
|
| Sends or resends the receipt email for a paid order.
|
*/

router.post('/resend/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID.'
      });
    }

    const order = await ReceiptOrder.findById(id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found.'
      });
    }

    if (String(order.payment_status || '').toLowerCase() !== 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Cannot send a receipt for an unpaid order.'
      });
    }

    const result = await sendOrderReceipt(order, {
      force: true
    });

    if (!result || typeof result !== 'object') {
      throw new Error('Invalid receipt email service response.');
    }

    if (result.processing) {
      return res.status(409).json({
        success: false,
        message: result.message || 'Receipt email is already being processed.',
        processing: true
      });
    }

    return res.status(200).json({
      success: result.success !== false,
      message: result.message || 'Receipt email request processed.',
      ...result
    });
  } catch (error) {
    handleServerError(error, 'Receipt resend failed');

    return res.status(500).json({
      success: false,
      message: 'Failed to resend receipt.'
    });
  }
});

/*
|--------------------------------------------------------------------------
| Receipt Email History
|--------------------------------------------------------------------------
|
| GET /receipts/status/:id
|
| Retrieves email delivery history for an order.
|
| Optional query parameters:
|   ?limit=50
|   ?page=1
|
*/

router.get('/status/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID.'
      });
    }

    const orderExists = await ReceiptOrder.exists({
      _id: id
    });

    if (!orderExists) {
      return res.status(404).json({
        success: false,
        message: 'Order not found.'
      });
    }

    const limit = parseLimit(req.query.limit, 50, 100);

    const requestedPage = Number.parseInt(req.query.page, 10);

    const page =
      Number.isInteger(requestedPage) && requestedPage > 0
        ? requestedPage
        : 1;

    const skip = (page - 1) * limit;

    const filter = {
      order_id: new mongoose.Types.ObjectId(id)
    };

    const [logs, total] = await Promise.all([
      ReceiptEmailLog.find(filter)
        .select('-__v')
        .sort({ created_at: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      ReceiptEmailLog.countDocuments(filter)
    ]);

    return res.status(200).json({
      success: true,

      emails: logs,

      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
        hasNextPage: skip + logs.length < total,
        hasPreviousPage: page > 1
      }
    });
  } catch (error) {
    handleServerError(error, 'Receipt email history failed');

    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve receipt email history.'
    });
  }
});

/*
|--------------------------------------------------------------------------
| Router Export
|--------------------------------------------------------------------------
*/

module.exports = router;