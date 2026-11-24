const { PromoCode, Order } = require('../models');
const { serialize, serializeMany } = require('../utils/helpers');

function calculateDiscount(promo, subtotal) {
  let discount = promo.discount_type === 'percent'
    ? subtotal * Number(promo.discount_value) / 100
    : Number(promo.discount_value);

  if (promo.max_discount_kes != null) {
    discount = Math.min(discount, Number(promo.max_discount_kes));
  }

  return Math.max(0, Math.min(subtotal, Math.round(discount)));
}

async function validatePromoForCustomer(code, subtotal, userId) {
  const normalizedCode = String(code || '').trim().toUpperCase();

  if (!normalizedCode) {
    throw new Error('Enter a promotional code.');
  }

  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    throw new Error('Your basket subtotal is invalid.');
  }

  const promo = await PromoCode.findOne({
    code: normalizedCode,
    is_active: true
  });

  if (!promo) {
    throw new Error('This promotional code is invalid or inactive.');
  }

  const now = new Date();

  if (promo.starts_at && now < promo.starts_at) {
    throw new Error('This promotional code is not active yet.');
  }

  if (promo.expires_at && now > promo.expires_at) {
    throw new Error('This promotional code has expired.');
  }

  if (
    promo.usage_limit != null &&
    promo.used_count >= promo.usage_limit
  ) {
    throw new Error('This promotional code has reached its usage limit.');
  }

  if (subtotal < Number(promo.min_order_kes || 0)) {
    throw new Error(
      `This code requires a minimum basket value of KES ${Number(
        promo.min_order_kes
      ).toLocaleString('en-KE')}.`
    );
  }

  if (userId && Number(promo.per_user_limit || 0) > 0) {
    const previousUses = await Order.countDocuments({
      user_id: userId,
      coupon_code: normalizedCode,
      order_status: { $ne: 'cancelled' }
    });

    if (previousUses >= promo.per_user_limit) {
      throw new Error('You have already used this promotional code.');
    }
  }

  return {
    promo,
    code: normalizedCode,
    discount_kes: calculateDiscount(promo, subtotal)
  };
}

exports.validate = async (req, res) => {
  try {
    const subtotal = Number(req.body.subtotal);
    const result = await validatePromoForCustomer(
      req.body.code,
      subtotal,
      req.user?.id
    );

    res.json({
      valid: true,
      code: result.code,
      discount_kes: result.discount_kes,
      subtotal_kes: subtotal,
      message: 'Promotional code applied.'
    });
  } catch (err) {
    res.status(400).json({
      valid: false,
      error: err.message || 'Unable to validate promotional code.'
    });
  }
};

exports.create = async (req, res) => {
  try {
    const code = String(req.body.code || '').trim().toUpperCase();
    const discountType = req.body.discount_type;
    const discountValue = Number(req.body.discount_value);
    const minOrder = Number(req.body.min_order_kes || 0);
    const maxDiscount = req.body.max_discount_kes == null ||
      req.body.max_discount_kes === ''
      ? null
      : Number(req.body.max_discount_kes);

    if (!/^[A-Z0-9_-]{3,40}$/.test(code)) {
      return res.status(400).json({
        error: 'Code must be 3–40 letters, numbers, hyphens or underscores.'
      });
    }

    if (!['percent', 'fixed'].includes(discountType)) {
      return res.status(400).json({
        error: 'Discount type must be percent or fixed.'
      });
    }

    if (
      !Number.isFinite(discountValue) ||
      discountValue <= 0 ||
      (discountType === 'percent' && discountValue > 100)
    ) {
      return res.status(400).json({
        error: 'Enter a valid discount value.'
      });
    }

    if (!Number.isFinite(minOrder) || minOrder < 0) {
      return res.status(400).json({
        error: 'Minimum order amount is invalid.'
      });
    }

    if (
      maxDiscount !== null &&
      (!Number.isFinite(maxDiscount) || maxDiscount < 0)
    ) {
      return res.status(400).json({
        error: 'Maximum discount is invalid.'
      });
    }

    const promo = await PromoCode.create({
      code,
      discount_type: discountType,
      discount_value: discountValue,
      min_order_kes: minOrder,
      max_discount_kes: maxDiscount,
      usage_limit: req.body.usage_limit || null,
      per_user_limit: req.body.per_user_limit || 1,
      starts_at: req.body.starts_at || null,
      expires_at: req.body.expires_at || null,
      is_active: req.body.is_active !== false,
      description: req.body.description || '',
      created_by: req.user?.id || null
    });

    res.status(201).json({
      promo: serialize(promo)
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        error: 'That promotional code already exists.'
      });
    }

    console.error('Create promo error:', err);
    res.status(500).json({
      error: 'Unable to create promotional code.'
    });
  }
};

exports.list = async (req, res) => {
  try {
    const promos = await PromoCode.find()
      .sort({ created_at: -1 });

    res.json({
      promos: serializeMany(promos)
    });
  } catch (err) {
    console.error('List promos error:', err);
    res.status(500).json({
      error: 'Unable to load promotional codes.'
    });
  }
};

exports.validatePromoForCustomer = validatePromoForCustomer;