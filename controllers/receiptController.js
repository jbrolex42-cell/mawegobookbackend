
'use strict';

const mongoose = require('mongoose');

const { Order, Setting } = require('../models');
const { serialize } = require('../utils/helpers');

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const logError = (context, error) => {
  console.error(`[ReceiptController] ${context}`, {
    message: error?.message,
    name: error?.name
  });
};

const cleanString = (value) => {
  if (value === undefined || value === null) return '';

  return String(value).trim();
};

const normalizePhone = (value) => {
  return cleanString(value).replace(/[\s\-().]/g, '');
};

const getUserId = (req) => {
  const id = req.user?.id || req.user?._id;

  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) {
    return null;
  }

  return String(id);
};

const isAdmin = (req) => {
  return ['admin', 'super_admin'].includes(
    String(req.user?.role || '').toLowerCase()
  );
};

const isValidObjectId = (value) => {
  return mongoose.Types.ObjectId.isValid(String(value || ''));
};

/**
 * Load application settings into a plain object.
 */
async function loadSettings() {
  const rows = await Setting.find({})
    .select('key value')
    .lean();

  return rows.reduce((settings, row) => {
    if (row.key) {
      settings[row.key] = row.value;
    }

    return settings;
  }, {});
}

/**
 * Check whether the requester can access the requested order.
 *
 * Admins can access all orders.
 * Authenticated customers can access their own orders.
 * Guest customers must provide the matching phone number.
 */
const canAccessOrder = (req, order, suppliedPhone = '') => {
  if (isAdmin(req)) {
    return true;
  }

  const userId = getUserId(req);

  if (userId && order.user_id) {
    return String(order.user_id) === userId;
  }

  const phone = normalizePhone(suppliedPhone);
  const orderPhone = normalizePhone(order.customer_phone);

  return Boolean(phone && orderPhone && phone === orderPhone);
};

/**
 * Standard receipt response.
 */
async function sendReceipt(req, res, order, suppliedPhone = '') {
  if (!canAccessOrder(req, order, suppliedPhone)) {
    return res.status(403).json({
      error: 'You are not authorized to view this receipt.'
    });
  }

  const settings = await loadSettings();

  return res.json({
    order: serialize(order),
    settings
  });
}

/* -------------------------------------------------------------------------- */
/* Get receipt by MongoDB order ID                                            */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/receipts/:orderId
 */
exports.getByOrderId = async (req, res) => {
  try {
    const orderId = req.params.orderId;

    if (!isValidObjectId(orderId)) {
      return res.status(400).json({
        error: 'Invalid order ID.'
      });
    }

    const order = await Order.findById(orderId).lean();

    if (!order) {
      return res.status(404).json({
        error: 'Order not found.'
      });
    }

    return await sendReceipt(req, res, order, req.query.phone);
  } catch (error) {
    logError('Failed to load receipt by order ID', error);

    return res.status(500).json({
      error: 'Failed to load receipt.'
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Get receipt by public order number                                        */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/receipts/number/:orderNumber?phone=...
 */
exports.getByOrderNumber = async (req, res) => {
  try {
    const orderNumber = cleanString(req.params.orderNumber);

    if (!orderNumber) {
      return res.status(400).json({
        error: 'Order number is required.'
      });
    }

    const order = await Order.findOne({
      order_number: orderNumber
    }).lean();

    if (!order) {
      return res.status(404).json({
        error: 'Order not found.'
      });
    }

    return await sendReceipt(req, res, order, req.query.phone);
  } catch (error) {
    logError('Failed to load receipt by order number', error);

    return res.status(500).json({
      error: 'Failed to load receipt.'
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

exports.loadSettings = loadSettings;
exports.normalizePhone = normalizePhone;