
'use strict';

const mongoose = require('mongoose');

const { PromoCode, Order } = require('../models');
const { serialize, serializeMany } = require('../utils/helpers');

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_PER_USER_LIMIT = 1;

const VALID_DISCOUNT_TYPES = ['percent', 'fixed'];

/* -------------------------------------------------------------------------- */
/* General helpers                                                            */
/* -------------------------------------------------------------------------- */

const logError = (context, error) => {
  console.error(`[PromoController] ${context}`, {
    message: error?.message,
    name: error?.name
  });
};

const cleanString = (value, fallback = '') => {
  if (value === undefined || value === null) return fallback;

  return String(value).trim();
};

const normalizeCode = (value) =>
  cleanString(value).toUpperCase();

const toNumber = (value, field, options = {}) => {
  const {
    min = 0,
    required = false,
    integer = false
  } = options;

  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new Error(`${field} is required.`);
    }

    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error(`${field} must be a valid number.`);
  }

  if (number < min) {
    throw new Error(`${field} cannot be less than ${min}.`);
  }

  if (integer && !Number.isInteger(number)) {
    throw new Error(`${field} must be a whole number.`);
  }

  return number;
};

const parseDate = (value, field) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} is not a valid date.`);
  }

  return date;
};

const parsePagination = (query = {}) => {
  const pageValue = Number.parseInt(query.page, 10);
  const limitValue = Number.parseInt(query.limit, 10);

  const page = Number.isInteger(pageValue) && pageValue > 0
    ? pageValue
    : 1;

  const limit = Number.isInteger(limitValue) && limitValue > 0
    ? Math.min(limitValue, MAX_LIMIT)
    : DEFAULT_LIMIT;

  return {
    page,
    limit,
    skip: (page - 1) * limit
  };
};

const paginationResponse = (page, limit, total) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit) || 1,
  has_next: page * limit < total,
  has_previous: page > 1
});

const getUserId = (req) => {
  const id = req.user?.id || req.user?._id;

  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) {
    return null;
  }

  return id;
};

const formatKes = (amount) =>
  Number(amount).toLocaleString('en-KE', {
    maximumFractionDigits: 0
  });

/* -------------------------------------------------------------------------- */
/* Discount calculation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Calculates the discount in KES.
 *
 * Percentage discounts are calculated from the eligible basket subtotal.
 * Fixed discounts cannot exceed the subtotal.
 */
function calculateDiscount(promo, subtotal) {
  const amount = Number(subtotal);

  if (!Number.isFinite(amount) || amount <= 0) {
    return 0;
  }

  const value = Number(promo.discount_value);

  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  let discount = promo.discount_type === 'percent'
    ? amount * value / 100
    : value;

  if (promo.max_discount_kes !== undefined &&
      promo.max_discount_kes !== null) {
    const maximum = Number(promo.max_discount_kes);

    if (Number.isFinite(maximum) && maximum >= 0) {
      discount = Math.min(discount, maximum);
    }
  }

  // KES is rounded to the nearest whole shilling.
  return Math.max(
    0,
    Math.min(amount, Math.round(discount))
  );
}

/* -------------------------------------------------------------------------- */
/* Customer promo validation                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Validates a promotional code for a customer.
 *
 * Important:
 * This function validates eligibility but does not reserve or consume
 * promotional-code usage. Usage must be recorded when an order is confirmed.
 *
 * @param {string} code
 * @param {number} subtotal
 * @param {string|null} userId
 */
async function validatePromoForCustomer(code, subtotal, userId = null) {
  const normalizedCode = normalizeCode(code);
  const amount = Number(subtotal);

  if (!normalizedCode) {
    throw new Error('Enter a promotional code.');
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Your basket subtotal is invalid.');
  }

  const promo = await PromoCode.findOne({
    code: normalizedCode,
    is_active: true
  }).lean();

  if (!promo) {
    throw new Error(
      'This promotional code is invalid or inactive.'
    );
  }

  const now = new Date();

  if (promo.starts_at && now < new Date(promo.starts_at)) {
    throw new Error(
      'This promotional code is not active yet.'
    );
  }

  if (promo.expires_at && now > new Date(promo.expires_at)) {
    throw new Error(
      'This promotional code has expired.'
    );
  }

  const usageLimit = promo.usage_limit == null
    ? null
    : Number(promo.usage_limit);

  const usedCount = Number(promo.used_count) || 0;

  if (
    usageLimit !== null &&
    usedCount >= usageLimit
  ) {
    throw new Error(
      'This promotional code has reached its usage limit.'
    );
  }

  const minimumOrder = Number(promo.min_order_kes) || 0;

  if (amount < minimumOrder) {
    throw new Error(
      `This code requires a minimum basket value of KES ${formatKes(minimumOrder)}.`
    );
  }

  const perUserLimit = Number(promo.per_user_limit) || 0;

  if (userId && perUserLimit > 0) {
    if (!mongoose.Types.ObjectId.isValid(String(userId))) {
      throw new Error('Invalid customer account.');
    }

    const previousUses = await Order.countDocuments({
      user_id: userId,
      coupon_code: normalizedCode,
      order_status: { $ne: 'cancelled' }
    });

    if (previousUses >= perUserLimit) {
      throw new Error(
        'You have already used this promotional code.'
      );
    }
  }

  const discount = calculateDiscount(promo, amount);

  return {
    promo,
    code: normalizedCode,
    discount_kes: discount,
    subtotal_kes: amount,
    total_after_discount_kes: Math.max(0, amount - discount)
  };
}

/* -------------------------------------------------------------------------- */
/* Request validation                                                         */
/* -------------------------------------------------------------------------- */

const validatePromoInput = (body = {}) => {
  const code = normalizeCode(body.code);
  const discountType = cleanString(body.discount_type).toLowerCase();

  const discountValue = toNumber(
    body.discount_value,
    'Discount value',
    { required: true, min: 0.01 }
  );

  const minimumOrder = body.min_order_kes === undefined ||
    body.min_order_kes === ''
    ? 0
    : toNumber(body.min_order_kes, 'Minimum order amount', {
        min: 0
      });

  const maximumDiscount = body.max_discount_kes === undefined ||
    body.max_discount_kes === null ||
    body.max_discount_kes === ''
    ? null
    : toNumber(body.max_discount_kes, 'Maximum discount', {
        min: 0
      });

  const usageLimit = body.usage_limit === undefined ||
    body.usage_limit === null ||
    body.usage_limit === ''
    ? null
    : toNumber(body.usage_limit, 'Usage limit', {
        min: 1,
        integer: true
      });

  const perUserLimit = body.per_user_limit === undefined ||
    body.per_user_limit === null ||
    body.per_user_limit === ''
    ? DEFAULT_PER_USER_LIMIT
    : toNumber(body.per_user_limit, 'Per-user limit', {
        min: 1,
        integer: true
      });

  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) {
    throw new Error(
      'Code must be 3–40 letters, numbers, hyphens or underscores.'
    );
  }

  if (!VALID_DISCOUNT_TYPES.includes(discountType)) {
    throw new Error(
      'Discount type must be percent or fixed.'
    );
  }

  if (
    discountType === 'percent' &&
    discountValue > 100
  ) {
    throw new Error(
      'Percentage discount cannot exceed 100%.'
    );
  }

  const startsAt = parseDate(body.starts_at, 'Start date');
  const expiresAt = parseDate(body.expires_at, 'Expiry date');

  if (startsAt && expiresAt && expiresAt <= startsAt) {
    throw new Error(
      'Expiry date must be later than the start date.'
    );
  }

  return {
    code,
    discount_type: discountType,
    discount_value: discountValue,
    min_order_kes: minimumOrder,
    max_discount_kes: maximumDiscount,
    usage_limit: usageLimit,
    per_user_limit: perUserLimit,
    starts_at: startsAt,
    expires_at: expiresAt,
    is_active: body.is_active === undefined
      ? true
      : parseBoolean(body.is_active),
    description: cleanString(body.description)
  };
};

function parseBoolean(value) {
  if (value === true || value === 1 ||
      value === '1' || value === 'true') {
    return true;
  }

  if (value === false || value === 0 ||
      value === '0' || value === 'false') {
    return false;
  }

  throw new Error('Invalid active status.');
}

/* -------------------------------------------------------------------------- */
/* Customer endpoints                                                         */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/promos/validate
 */
exports.validate = async (req, res) => {
  try {
    const body = req.body || {};
    const subtotal = Number(body.subtotal);

    const result = await validatePromoForCustomer(
      body.code,
      subtotal,
      getUserId(req)
    );

    return res.json({
      valid: true,
      code: result.code,
      discount_kes: result.discount_kes,
      subtotal_kes: result.subtotal_kes,
      total_after_discount_kes: result.total_after_discount_kes,
      message: 'Promotional code applied.'
    });
  } catch (error) {
    return res.status(400).json({
      valid: false,
      error: error.message ||
        'Unable to validate promotional code.'
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Admin endpoints                                                            */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/admin/promos
 *
 * Creates a new promotional code.
 */
exports.create = async (req, res) => {
  try {
    const fields = validatePromoInput(req.body || {});

    const existing = await PromoCode.exists({
      code: fields.code
    });

    if (existing) {
      return res.status(409).json({
        error: 'That promotional code already exists.'
      });
    }

    const promo = await PromoCode.create({
      ...fields,
      used_count: 0,
      created_by: getUserId(req)
    });

    return res.status(201).json({
      message: 'Promotional code created successfully.',
      promo: serialize(promo)
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: 'That promotional code already exists.'
      });
    }

    if (
      error.message?.includes('required') ||
      error.message?.includes('valid') ||
      error.message?.includes('cannot') ||
      error.message?.includes('must') ||
      error.message?.includes('later') ||
      error.message?.includes('Code must')
    ) {
      return res.status(400).json({
        error: error.message
      });
    }

    logError('Create promo failed', error);

    return res.status(500).json({
      error: 'Unable to create promotional code.'
    });
  }
};

/**
 * GET /api/admin/promos
 *
 * Lists promotional codes with pagination and optional filters.
 */
exports.list = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);

    const filter = {};

    if (req.query.is_active !== undefined) {
      filter.is_active = parseBoolean(req.query.is_active);
    }

    if (req.query.q) {
      const search = cleanString(req.query.q)
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      filter.$or = [
        { code: new RegExp(search, 'i') },
        { description: new RegExp(search, 'i') }
      ];
    }

    const [promos, total] = await Promise.all([
      PromoCode.find(filter)
        .sort({ created_at: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      PromoCode.countDocuments(filter)
    ]);

    return res.json({
      promos: serializeMany(promos),
      pagination: paginationResponse(page, limit, total)
    });
  } catch (error) {
    logError('List promos failed', error);

    return res.status(500).json({
      error: 'Unable to load promotional codes.'
    });
  }
};

/**
 * PUT /api/admin/promos/:id
 *
 * Updates an existing promotional code.
 */
exports.update = async (req, res) => {
  try {
    const id = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(400).json({
        error: 'Invalid promotional code ID.'
      });
    }

    const existing = await PromoCode.findById(id);

    if (!existing) {
      return res.status(404).json({
        error: 'Promotional code not found.'
      });
    }

    const fields = validatePromoInput({
      ...existing.toObject(),
      ...req.body,
      code: req.body.code === undefined
        ? existing.code
        : req.body.code,
      discount_type: req.body.discount_type === undefined
        ? existing.discount_type
        : req.body.discount_type,
      discount_value: req.body.discount_value === undefined
        ? existing.discount_value
        : req.body.discount_value,
      min_order_kes: req.body.min_order_kes === undefined
        ? existing.min_order_kes
        : req.body.min_order_kes,
      max_discount_kes: req.body.max_discount_kes === undefined
        ? existing.max_discount_kes
        : req.body.max_discount_kes,
      usage_limit: req.body.usage_limit === undefined
        ? existing.usage_limit
        : req.body.usage_limit,
      per_user_limit: req.body.per_user_limit === undefined
        ? existing.per_user_limit
        : req.body.per_user_limit,
      starts_at: req.body.starts_at === undefined
        ? existing.starts_at
        : req.body.starts_at,
      expires_at: req.body.expires_at === undefined
        ? existing.expires_at
        : req.body.expires_at,
      is_active: req.body.is_active === undefined
        ? existing.is_active
        : req.body.is_active,
      description: req.body.description === undefined
        ? existing.description
        : req.body.description
    });

    if (
      fields.code !== existing.code &&
      await PromoCode.exists({
        code: fields.code,
        _id: { $ne: existing._id }
      })
    ) {
      return res.status(409).json({
        error: 'That promotional code already exists.'
      });
    }

    Object.assign(existing, fields);

    await existing.save();

    return res.json({
      message: 'Promotional code updated successfully.',
      promo: serialize(existing)
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: 'That promotional code already exists.'
      });
    }

    if (
      error.message?.includes('required') ||
      error.message?.includes('valid') ||
      error.message?.includes('cannot') ||
      error.message?.includes('must') ||
      error.message?.includes('later') ||
      error.message?.includes('Code must')
    ) {
      return res.status(400).json({
        error: error.message
      });
    }

    logError('Update promo failed', error);

    return res.status(500).json({
      error: 'Unable to update promotional code.'
    });
  }
};

/**
 * DELETE /api/admin/promos/:id
 *
 * Soft-deletes a promo by disabling it.
 * Keeps historical order references intact.
 */
exports.remove = async (req, res) => {
  try {
    const id = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(400).json({
        error: 'Invalid promotional code ID.'
      });
    }

    const promo = await PromoCode.findByIdAndUpdate(
      id,
      {
        $set: {
          is_active: false
        }
      },
      {
        new: true,
        runValidators: true
      }
    );

    if (!promo) {
      return res.status(404).json({
        error: 'Promotional code not found.'
      });
    }

    return res.json({
      message: 'Promotional code disabled successfully.',
      promo: serialize(promo)
    });
  } catch (error) {
    logError('Remove promo failed', error);

    return res.status(500).json({
      error: 'Unable to disable promotional code.'
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Shared exports                                                             */
/* -------------------------------------------------------------------------- */

exports.calculateDiscount = calculateDiscount;
exports.validatePromoForCustomer = validatePromoForCustomer;