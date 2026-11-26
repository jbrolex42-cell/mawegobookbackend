
'use strict';

const mongoose = require('mongoose');

const {
  Order,
  Product,
  StockLedger,
  User,
  PointsLedger,
  PromoCode
} = require('../models');

const {
  generateOrderNumber,
  parsePagination,
  serialize,
  serializeMany,
  effectivePrice,
  isSaleActive,
  pointsEarnedFromKes,
  pointsToKes,
  MIN_REDEEM_POINTS
} = require('../utils/helpers');

const {
  sendOrderReceipt
} = require('../services/orderEmailService');

const {
  validatePromoForCustomer
} = require('./promoController');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const FREE_DELIVERY_THRESHOLD =
  Number(process.env.FREE_DELIVERY_THRESHOLD_KES) || 2000;

const DEFAULT_DELIVERY_FEE =
  Number(process.env.DEFAULT_DELIVERY_FEE_KES) || 200;

const MAX_ORDER_ITEMS = 100;
const MAX_QUANTITY_PER_ITEM = 1000;
const MAX_PAGE_SIZE = 100;

const ALLOWED_FULFILMENT_TYPES = [
  'delivery',
  'collection'
];

const ALLOWED_PAYMENT_METHODS = [
  'mpesa',
  'card',
  'cash_on_delivery'
];

const ALLOWED_ORDER_STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'ready',
  'out_for_delivery',
  'completed',
  'cancelled'
];

const ALLOWED_PAYMENT_STATUSES = [
  'pending',
  'paid',
  'failed',
  'refunded'
];

// -----------------------------------------------------------------------------
// General helpers
// -----------------------------------------------------------------------------

function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value);
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePhone(value) {
  return String(value || '').replace(/\s+/g, '');
}

function normalizeMoney(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount < 0) {
    return 0;
  }

  return Math.round(amount);
}

function getUserId(req) {
  return req.user?.id || req.user?._id || null;
}

function getDeliveryFee(subtotal, fulfilmentType) {
  if (fulfilmentType === 'collection') {
    return 0;
  }

  if (subtotal >= FREE_DELIVERY_THRESHOLD) {
    return 0;
  }

  return DEFAULT_DELIVERY_FEE;
}

function formatCurrency(amount) {
  return `KES ${Number(amount || 0).toLocaleString('en-KE')}`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getErrorMessage(err, fallback = 'An unexpected error occurred.') {
  if (
    err &&
    typeof err.message === 'string' &&
    err.message.trim()
  ) {
    return err.message;
  }

  return fallback;
}

function getPagination(query = {}) {
  const parsed = parsePagination(query);

  const page = Math.max(
    1,
    Math.floor(Number(parsed.page) || 1)
  );

  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(Number(parsed.limit) || 20))
  );

  return {
    page,
    limit,
    skip: (page - 1) * limit
  };
}

function getOrderReference(order) {
  return String(order?._id || order?.id || '');
}

function getOrderNumber(order) {
  return String(order?.order_number || '');
}

function isOrderCancelled(order) {
  return order?.order_status === 'cancelled';
}
 
async function deductStockForOrder(order) {
  if (!order?._id) {
    throw new Error('A valid order is required to deduct stock.');
  }

  const referenceId = getOrderReference(order);

  const existingSale = await StockLedger.findOne({
    reference_type: 'order',
    reference_id: referenceId,
    reason: 'sale'
  }).lean();

  if (existingSale) {
    return true;
  }

  const items = Array.isArray(order.items) ? order.items : [];

  if (!items.length) {
    throw new Error('Cannot deduct stock for an order without items.');
  }

  for (const item of items) {
    const productId = item.product_id;
    const quantity = Math.floor(Number(item.quantity));

    if (!isValidObjectId(productId) || quantity < 1) {
      throw new Error(`Invalid stock item in order ${getOrderNumber(order)}.`);
    }

    // Atomically deduct only if sufficient stock remains.
    const product = await Product.findOneAndUpdate(
      {
        _id: productId,
        stock_qty: { $gte: quantity }
      },
      {
        $inc: {
          stock_qty: -quantity
        }
      },
      {
        new: true
      }
    );

    if (!product) {
      const existingProduct = await Product.findById(productId)
        .select('name stock_qty')
        .lean();

      if (!existingProduct) {
        throw new Error(
          `Product not found for ${item.product_name || 'an order item'}.`
        );
      }

      throw new Error(
        `Insufficient stock for "${item.product_name || existingProduct.name}". Available: ${existingProduct.stock_qty}.`
      );
    }

    await StockLedger.create({
      product_id: product._id,
      change_qty: -quantity,
      balance_after: product.stock_qty,
      reason: 'sale',
      reference_type: 'order',
      reference_id: referenceId,
      notes: getOrderNumber(order)
    });
  }

  return true;
}

async function restoreStockForOrder(order) {
  if (!order?._id) {
    throw new Error('A valid order is required to restore stock.');
  }

  const referenceId = getOrderReference(order);

  const saleEntries = await StockLedger.find({
    reference_type: 'order',
    reference_id: referenceId,
    reason: 'sale'
  }).lean();

  if (!saleEntries.length) {
    return true;
  }

  const existingRestoration = await StockLedger.findOne({
    reference_type: 'order',
    reference_id: referenceId,
    reason: 'sale_cancel'
  }).lean();

  if (existingRestoration) {
    return true;
  }

  for (const entry of saleEntries) {
    const quantity = Math.abs(Number(entry.change_qty));

    if (!quantity || !isValidObjectId(entry.product_id)) {
      continue;
    }

    const product = await Product.findByIdAndUpdate(
      entry.product_id,
      {
        $inc: {
          stock_qty: quantity
        }
      },
      {
        new: true
      }
    );

    if (!product) {
      console.error(
        `Unable to restore stock for missing product ${entry.product_id}, order ${referenceId}.`
      );

      continue;
    }

    await StockLedger.create({
      product_id: product._id,
      change_qty: quantity,
      balance_after: product.stock_qty,
      reason: 'sale_cancel',
      reference_type: 'order',
      reference_id: referenceId,
      notes: getOrderNumber(order)
    });
  }

  return true;
}

async function awardPoints(userId, order, points) {
  const amount = Math.floor(Number(points));

  if (!userId || !order?._id || !Number.isFinite(amount) || amount <= 0) {
    return false;
  }

  const existing = await PointsLedger.findOne({
    order_id: order._id,
    reason: 'earn'
  }).lean();

  if (existing) {
    return false;
  }

  const user = await User.findByIdAndUpdate(
    userId,
    {
      $inc: {
        reward_points: amount
      }
    },
    {
      new: true
    }
  );

  if (!user) {
    throw new Error('Unable to award points because the customer was not found.');
  }

  await PointsLedger.create({
    user_id: user._id,
    order_id: order._id,
    change: amount,
    balance_after: Number(user.reward_points || 0),
    reason: 'earn',
    notes: getOrderNumber(order)
  });

  return true;
}

async function reservePoints(userId, orderId, points, orderNumber) {
  const amount = Math.floor(Number(points));

  if (!userId || !orderId || !Number.isFinite(amount) || amount <= 0) {
    return false;
  }

  const user = await User.findOneAndUpdate(
    {
      _id: userId,
      reward_points: {
        $gte: amount
      }
    },
    {
      $inc: {
        reward_points: -amount
      }
    },
    {
      new: true
    }
  );

  if (!user) {
    throw new Error(
      'Your reward points balance changed. Please try again.'
    );
  }

  try {
    await PointsLedger.create({
      user_id: user._id,
      order_id: orderId,
      change: -amount,
      balance_after: Number(user.reward_points || 0),
      reason: 'redeem',
      notes: orderNumber
    });

    return true;
  } catch (err) {
    await User.updateOne(
      { _id: userId },
      {
        $inc: {
          reward_points: amount
        }
      }
    );

    throw err;
  }
}

async function refundRedeemedPoints(order) {
  const points = Math.floor(Number(order?.points_redeemed || 0));

  if (
    !order?.user_id ||
    !order?._id ||
    points <= 0 ||
    order.points_redeemed_refunded
  ) {
    return false;
  }

  const existingReversal = await PointsLedger.findOne({
    order_id: order._id,
    reason: 'redeem_reversal'
  }).lean();

  if (existingReversal) {
    order.points_redeemed_refunded = true;
    await order.save();

    return false;
  }

  const user = await User.findByIdAndUpdate(
    order.user_id,
    {
      $inc: {
        reward_points: points
      }
    },
    {
      new: true
    }
  );

  if (!user) {
    throw new Error('Unable to refund reward points: customer not found.');
  }

  await PointsLedger.create({
    user_id: user._id,
    order_id: order._id,
    change: points,
    balance_after: Number(user.reward_points || 0),
    reason: 'redeem_reversal',
    notes: `Cancelled order ${getOrderNumber(order)}`
  });

  order.points_redeemed_refunded = true;
  await order.save();

  return true;
}

async function reverseCheckoutPoints(userId, order) {
  if (!userId || !order?._id) {
    return false;
  }

  const redemption = await PointsLedger.findOne({
    user_id: userId,
    order_id: order._id,
    reason: 'redeem'
  }).lean();

  if (!redemption) {
    return false;
  }

  const existingReversal = await PointsLedger.findOne({
    order_id: order._id,
    reason: 'redeem_reversal'
  }).lean();

  if (existingReversal) {
    return false;
  }

  const points = Math.abs(Number(redemption.change));

  if (!points) {
    return false;
  }

  const user = await User.findByIdAndUpdate(
    userId,
    {
      $inc: {
        reward_points: points
      }
    },
    {
      new: true
    }
  );

  if (!user) {
    throw new Error('Unable to restore reserved reward points.');
  }

  await PointsLedger.create({
    user_id: userId,
    order_id: order._id,
    change: points,
    balance_after: Number(user.reward_points || 0),
    reason: 'redeem_reversal',
    notes: `Checkout rollback for order ${getOrderNumber(order)}`
  });

  return true;
}

async function consumePromoCode(code) {
  if (!code) return false;

  const normalizedCode = String(code).trim().toUpperCase();

  const result = await PromoCode.findOneAndUpdate(
    {
      code: normalizedCode,
      is_active: true,
      $or: [
        { usage_limit: null },
        { usage_limit: { $exists: false } },
        {
          $expr: {
            $lt: [
              { $ifNull: ['$used_count', 0] },
              '$usage_limit'
            ]
          }
        }
      ]
    },
    {
      $inc: {
        used_count: 1
      }
    },
    {
      new: true
    }
  );

  if (!result) {
    throw new Error(
      'This promotional code is no longer available. Please try another code.'
    );
  }

  return true;
}

async function reversePromoUsage(code) {
  if (!code) return;

  await PromoCode.updateOne(
    {
      code: String(code).trim().toUpperCase(),
      used_count: { $gt: 0 }
    },
    {
      $inc: {
        used_count: -1
      }
    }
  );
}

// -----------------------------------------------------------------------------
// Email
// -----------------------------------------------------------------------------

async function sendReceiptSafely(order) {
  try {
    await sendOrderReceipt(order);
  } catch (err) {
    console.error(
      'Order receipt email failed:',
      order?._id,
      err.message
    );
  }
}

// -----------------------------------------------------------------------------
// Checkout validation
// -----------------------------------------------------------------------------

function validateCheckoutBody(body, authenticatedUser) {
  const {
    items,
    customer_name,
    customer_phone,
    fulfilment_type,
    delivery_address,
    payment_method
  } = body;

  if (!Array.isArray(items) || items.length === 0) {
    return 'Your basket is empty.';
  }

  if (items.length > MAX_ORDER_ITEMS) {
    return `You can order a maximum of ${MAX_ORDER_ITEMS} different items at a time.`;
  }

  if (!normalizeString(customer_name)) {
    return 'Customer name is required.';
  }

  if (!normalizeString(customer_phone)) {
    return 'Customer phone number is required.';
  }

  if (!ALLOWED_FULFILMENT_TYPES.includes(fulfilment_type)) {
    return 'Invalid fulfilment type.';
  }

  if (
    fulfilment_type === 'delivery' &&
    !normalizeString(delivery_address)
  ) {
    return 'Delivery address is required.';
  }

  if (!ALLOWED_PAYMENT_METHODS.includes(payment_method)) {
    return 'Invalid payment method.';
  }

  if (
    body.customer_email &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.customer_email)
  ) {
    return 'Please provide a valid email address.';
  }

  if (
    body.points_redeemed !== undefined &&
    (
      !Number.isFinite(Number(body.points_redeemed)) ||
      Number(body.points_redeemed) < 0
    )
  ) {
    return 'Invalid reward points amount.';
  }

  if (body.points_redeemed && !authenticatedUser) {
    return 'Sign in to redeem reward points.';
  }

  for (const item of items) {
    if (!item || !isValidObjectId(item.product_id)) {
      return 'One or more products in your basket are invalid.';
    }

    const quantity = Number(item.quantity);

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_QUANTITY_PER_ITEM
    ) {
      return 'One or more basket quantities are invalid.';
    }
  }

  return null;
}

function normalizeBasketItems(items) {
  const grouped = new Map();

  for (const item of items) {
    const id = String(item.product_id);
    const quantity = Number(item.quantity);

    const existing = grouped.get(id) || 0;
    const combined = existing + quantity;

    if (combined > MAX_QUANTITY_PER_ITEM) {
      throw new Error('The requested quantity is too large.');
    }

    grouped.set(id, combined);
  }

  return Array.from(grouped.entries()).map(([product_id, quantity]) => ({
    product_id,
    quantity
  }));
}

exports.create = async (req, res) => {
  let createdOrder = null;
  let pointsReserved = false;
  let promoConsumed = false;

  const userId = getUserId(req);

  try {
    const validationError = validateCheckoutBody(req.body, req.user);

    if (validationError) {
      return res.status(400).json({
        error: validationError
      });
    }

    const {
      items,
      customer_name,
      customer_phone,
      customer_email,
      fulfilment_type,
      delivery_address,
      delivery_notes,
      payment_method,
      notes
    } = req.body;

    const basket = normalizeBasketItems(items);

    const lineItems = [];
    let subtotal = 0;
    let productDiscount = 0;

    // Fetch and validate products.
    for (const basketItem of basket) {
      const product = await Product.findOne({
        _id: basketItem.product_id,
        is_active: true
      });

      if (!product) {
        return res.status(400).json({
          error: `Product not found or unavailable: ${basketItem.product_id}`
        });
      }

      const quantity = basketItem.quantity;
      const availableStock = Number(product.stock_qty || 0);

      if (availableStock < quantity) {
        return res.status(400).json({
          error: `Insufficient stock for "${product.name}". Available: ${availableStock}.`
        });
      }

      const originalPrice = Number(product.price_kes);
      const unitPrice = Number(effectivePrice(product));

      if (
        !Number.isFinite(originalPrice) ||
        !Number.isFinite(unitPrice) ||
        originalPrice < 0 ||
        unitPrice < 0
      ) {
        return res.status(400).json({
          error: `Invalid price for "${product.name}".`
        });
      }

      const lineTotal = unitPrice * quantity;

      subtotal += lineTotal;

      productDiscount += Math.max(
        0,
        originalPrice - unitPrice
      ) * quantity;

      lineItems.push({
        product,
        quantity,
        unit_price: unitPrice,
        original_price: originalPrice,
        line_total: lineTotal,
        discount_percent:
          isSaleActive(product) && originalPrice > 0
            ? Math.round((1 - unitPrice / originalPrice) * 100)
            : 0
      });
    }

    subtotal = normalizeMoney(subtotal);
    productDiscount = normalizeMoney(productDiscount);

    // Validate promotional code.
    let couponCode = null;
    let couponDiscount = 0;

    if (req.body.coupon_code) {
      const promoResult = await validatePromoForCustomer(
        req.body.coupon_code,
        subtotal,
        userId
      );

      couponCode = String(promoResult.code).trim().toUpperCase();
      couponDiscount = normalizeMoney(promoResult.discount_kes);

      if (couponDiscount > subtotal) {
        couponDiscount = subtotal;
      }
    }

    const afterCoupon = Math.max(
      0,
      subtotal - couponDiscount
    );

    // Validate and calculate points redemption.
    let pointsRedeemed = Math.floor(
      Number(req.body.points_redeemed) || 0
    );

    let pointsValueKes = 0;

    if (pointsRedeemed > 0) {
      if (!userId) {
        return res.status(400).json({
          error: 'Sign in to redeem reward points.'
        });
      }

      if (pointsRedeemed < MIN_REDEEM_POINTS) {
        return res.status(400).json({
          error: `You need at least ${MIN_REDEEM_POINTS} points to redeem.`
        });
      }

      const user = await User.findById(userId)
        .select('reward_points')
        .lean();

      if (!user) {
        return res.status(401).json({
          error: 'User not found.'
        });
      }

      if (pointsRedeemed > Number(user.reward_points || 0)) {
        return res.status(400).json({
          error: 'You do not have enough reward points.'
        });
      }

      pointsValueKes = normalizeMoney(
        pointsToKes(pointsRedeemed)
      );

      // Do not allow points to discount more than the payable subtotal.
      if (pointsValueKes > afterCoupon) {
        pointsValueKes = afterCoupon;

        // Existing points conversion assumes 1 point = KES 0.5.
        pointsRedeemed = Math.floor(pointsValueKes / 0.5);

        if (pointsRedeemed < MIN_REDEEM_POINTS) {
          pointsRedeemed = 0;
          pointsValueKes = 0;
        }
      }
    }

    const deliveryFee = getDeliveryFee(
      subtotal,
      fulfilment_type
    );

    const total = Math.max(
      0,
      normalizeMoney(
        afterCoupon + deliveryFee - pointsValueKes
      )
    );

    const pointsEarned = Math.max(
      0,
      Math.floor(Number(pointsEarnedFromKes(afterCoupon)) || 0)
    );

    // Create order.
    const order = await Order.create({
      order_number: generateOrderNumber(),
      user_id: userId || null,

      customer_name: normalizeString(customer_name),
      customer_phone: normalizePhone(customer_phone),
      customer_email: normalizeString(customer_email) || null,

      fulfilment_type,
      delivery_address:
        normalizeString(delivery_address) || null,
      delivery_notes:
        normalizeString(delivery_notes) || null,

      delivery_fee_kes: deliveryFee,
      subtotal_kes: subtotal,
      total_kes: total,

      discount_total_kes: productDiscount + couponDiscount,
      coupon_code: couponCode,
      coupon_discount_kes: couponDiscount,

      points_earned: pointsEarned,
      points_redeemed: pointsRedeemed,
      points_value_kes: pointsValueKes,

      payment_method,
      payment_status: 'pending',
      order_status:
        payment_method === 'cash_on_delivery'
          ? 'confirmed'
          : 'pending',

      notes: normalizeString(notes) || null,

      items: lineItems.map((item) => ({
        product_id: item.product._id,
        product_name: item.product.name,
        sku: item.product.sku,
        quantity: item.quantity,
        unit_price_kes: item.unit_price,
        original_price_kes: item.original_price,
        discount_percent: item.discount_percent,
        line_total_kes: item.line_total
      }))
    });

    createdOrder = order;

    // Reserve points only after the order exists.
    if (pointsRedeemed > 0 && userId) {
      await reservePoints(
        userId,
        order._id,
        pointsRedeemed,
        order.order_number
      );

      // Set only after reservePoints has completed successfully.
      pointsReserved = true;
    }

    // Consume promo usage.
    if (couponCode) {
      await consumePromoCode(couponCode);
      promoConsumed = true;
    }

    // COD orders reserve stock at checkout.
    if (payment_method === 'cash_on_delivery') {
      await deductStockForOrder(order);
    }

    return res.status(201).json({
      order: serialize(order),
      points_earned: pointsEarned,
      points_redeemed: pointsRedeemed,
      coupon_discount_kes: couponDiscount,
      message:
        payment_method === 'cash_on_delivery'
          ? 'Order placed. Pay when your order is delivered or collected.'
          : 'Order created. Complete payment to confirm your order and earn reward points.'
    });
  } catch (err) {
    console.error('Create order error:', err);

    // Reverse points only if the reservation actually succeeded.
    if (pointsReserved && createdOrder && userId) {
      try {
        await reverseCheckoutPoints(userId, createdOrder);
      } catch (rollbackError) {
        console.error(
          'Reward points rollback failed:',
          rollbackError
        );
      }
    }

    // Reverse promo usage if it was consumed.
    if (promoConsumed && createdOrder?.coupon_code) {
      try {
        await reversePromoUsage(createdOrder.coupon_code);
      } catch (rollbackError) {
        console.error(
          'Promo usage rollback failed:',
          rollbackError
        );
      }
    }

    // Remove the incomplete order.
    if (createdOrder?._id) {
      try {
        await Order.deleteOne({
          _id: createdOrder._id
        });
      } catch (deleteError) {
        console.error(
          'Failed to remove incomplete order:',
          deleteError
        );
      }
    }

    return res.status(400).json({
      error: getErrorMessage(err, 'Failed to create order.')
    });
  }
};

exports.getByNumber = async (req, res) => {
  try {
    const orderNumber = normalizeString(req.params.orderNumber);

    if (!orderNumber) {
      return res.status(400).json({
        error: 'Order number is required.'
      });
    }

    const order = await Order.findOne({
      order_number: orderNumber
    });

    if (!order) {
      return res.status(404).json({
        error: 'Order not found.'
      });
    }

    if (req.query.phone) {
      const storedPhone = normalizePhone(order.customer_phone);
      const suppliedPhone = normalizePhone(req.query.phone);

      if (
        !storedPhone ||
        !suppliedPhone ||
        storedPhone !== suppliedPhone
      ) {
        return res.status(403).json({
          error: 'Phone does not match this order.'
        });
      }
    }

    return res.json({
      order: serialize(order)
    });
  } catch (err) {
    console.error('Order tracking error:', err);

    return res.status(500).json({
      error: 'Failed to load order.'
    });
  }
};

exports.getCustomerStatus = async (req, res) => {
  try {
    const orderId = req.params.id;
    const userId = getUserId(req);

    if (!isValidObjectId(orderId)) {
      return res.status(400).json({
        error: 'Invalid order ID.'
      });
    }

    if (!userId) {
      return res.status(401).json({
        error: 'Authentication required.'
      });
    }

    const order = await Order.findOne({
      _id: orderId,
      user_id: userId
    }).select(
      'order_number payment_status order_status payment_method total_kes created_at'
    );

    if (!order) {
      return res.status(404).json({
        error: 'Order not found.'
      });
    }

    return res.json({
      order: serialize(order)
    });
  } catch (err) {
    console.error('Customer order status error:', err);

    return res.status(500).json({
      error: 'Unable to check order status.'
    });
  }
};

exports.cancelCustomerOrder = async (req, res) => {
  try {
    const orderId = req.params.id;
    const userId = getUserId(req);

    if (!isValidObjectId(orderId)) {
      return res.status(400).json({
        error: 'Invalid order ID.'
      });
    }

    const order = await Order.findOne({
      _id: orderId,
      user_id: userId
    });

    if (!order) {
      return res.status(404).json({
        error: 'Order not found.'
      });
    }

    if (isOrderCancelled(order)) {
      return res.json({
        order: serialize(order),
        message: 'This order is already cancelled.'
      });
    }

    if (order.payment_status === 'paid') {
      return res.status(400).json({
        error: 'This order has already been paid. Please contact the bookshop to arrange a refund or cancellation.'
      });
    }

    if (!['pending', 'confirmed'].includes(order.order_status)) {
      return res.status(400).json({
        error: 'This order can no longer be cancelled online. Please contact the bookshop.'
      });
    }

    // Restore any stock already deducted.
    await restoreStockForOrder(order);

    // Return any points redeemed at checkout.
    await refundRedeemedPoints(order);

    order.order_status = 'cancelled';

    await order.save();

    return res.json({
      order: serialize(order),
      message: 'Your order has been cancelled. Redeemed points have been returned to your account.'
    });
  } catch (err) {
    console.error('Customer cancellation error:', err);

    return res.status(500).json({
      error: 'Unable to cancel this order.'
    });
  }
};

exports.listAdmin = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);

    const filter = {};

    if (req.query.status) {
      if (!ALLOWED_ORDER_STATUSES.includes(req.query.status)) {
        return res.status(400).json({
          error: 'Invalid order status filter.'
        });
      }

      filter.order_status = req.query.status;
    }

    if (req.query.payment_status) {
      if (!ALLOWED_PAYMENT_STATUSES.includes(req.query.payment_status)) {
        return res.status(400).json({
          error: 'Invalid payment status filter.'
        });
      }

      filter.payment_status = req.query.payment_status;
    }

    if (req.query.q) {
      const search = escapeRegex(
        normalizeString(req.query.q).slice(0, 100)
      );

      if (search) {
        filter.$or = [
          { order_number: new RegExp(search, 'i') },
          { customer_name: new RegExp(search, 'i') },
          { customer_phone: new RegExp(search, 'i') }
        ];
      }
    }

    const [total, orders] = await Promise.all([
      Order.countDocuments(filter),

      Order.find(filter)
        .sort({
          created_at: -1,
          _id: -1
        })
        .skip(skip)
        .limit(limit)
    ]);

    return res.json({
      orders: serializeMany(orders),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1
      }
    });
  } catch (err) {
    console.error('Admin order listing error:', err);

    return res.status(500).json({
      error: 'Failed to list orders.'
    });
  }
};

exports.getAdmin = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        error: 'Invalid order ID.'
      });
    }

    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        error: 'Order not found.'
      });
    }

    return res.json({
      order: serialize(order)
    });
  } catch (err) {
    console.error('Admin order details error:', err);

    return res.status(500).json({
      error: 'Failed to load order.'
    });
  }
};

exports.updateStatus = async (req, res) => {
  try {
    const orderId = req.params.id;

    if (!isValidObjectId(orderId)) {
      return res.status(400).json({
        error: 'Invalid order ID.'
      });
    }

    const {
      order_status,
      payment_status,
      notes
    } = req.body;

    if (
      order_status &&
      !ALLOWED_ORDER_STATUSES.includes(order_status)
    ) {
      return res.status(400).json({
        error: 'Invalid order status.'
      });
    }

    if (
      payment_status &&
      !ALLOWED_PAYMENT_STATUSES.includes(payment_status)
    ) {
      return res.status(400).json({
        error: 'Invalid payment status.'
      });
    }

    let order = await Order.findById(orderId);

    if (!order) {
      return res.status(404).json({
        error: 'Order not found.'
      });
    }

    if (
      payment_status === 'paid' &&
      order.payment_status !== 'paid'
    ) {
      await exports.markPaid(order._id);
      order = await Order.findById(order._id);

      if (!order || order.payment_status !== 'paid') {
        return res.status(400).json({
          error: 'Unable to mark order as paid.'
        });
      }
    } else if (
      payment_status &&
      payment_status !== 'paid'
    ) {
      order.payment_status = payment_status;
    }

    if (
      order_status === 'cancelled' &&
      order.order_status !== 'cancelled'
    ) {
      if (order.payment_status === 'paid') {
        return res.status(400).json({
          error: 'Paid orders require the refund workflow before cancellation.'
        });
      }

      await restoreStockForOrder(order);
      await refundRedeemedPoints(order);
    }

    if (order_status) {
      order.order_status = order_status;
    }

    if (notes !== undefined) {
      order.notes = normalizeString(notes) || null;
    }

    await order.save();

    return res.json({
      order: serialize(order)
    });
  } catch (err) {
    console.error('Admin order update error:', err);

    return res.status(500).json({
      error: getErrorMessage(err, 'Failed to update order.')
    });
  }
};

exports.markPaid = async (orderId, paymentMeta = {}) => {
  if (!isValidObjectId(orderId)) {
    throw new Error('Invalid order ID.');
  }

  const order = await Order.findById(orderId);

  if (!order) {
    return null;
  }

  // Idempotency guard for ordinary repeated payment callbacks.
  if (order.payment_status === 'paid') {
    return serialize(order);
  }

  if (isOrderCancelled(order)) {
    throw new Error('Cancelled orders cannot be marked paid.');
  }

  // Save payment references only when supplied by a trusted caller.
  if (paymentMeta.mpesa_receipt) {
    order.mpesa_receipt = paymentMeta.mpesa_receipt;
  }

  if (paymentMeta.card_reference) {
    order.card_reference = paymentMeta.card_reference;
  }

  if (paymentMeta.payment_reference) {
    order.payment_reference = paymentMeta.payment_reference;
  }

  // Deduct stock before saving paid status. If stock deduction fails,
  // the order remains unpaid and can be investigated or retried.
  if (order.payment_method !== 'cash_on_delivery') {
    await deductStockForOrder(order);
  }

  order.payment_status = 'paid';

  if (order.order_status === 'pending') {
    order.order_status = 'confirmed';
  }

  await order.save();

  // Award points only after successful payment.
  if (order.user_id && Number(order.points_earned) > 0) {
    await awardPoints(
      order.user_id,
      order,
      order.points_earned
    );
  }

  // Receipt failure must not reverse a successful payment.
  await sendReceiptSafely(order);

  return serialize(order);
};

// -----------------------------------------------------------------------------
// Exports for other controllers
// -----------------------------------------------------------------------------

exports.awardPoints = awardPoints;
exports.deductStockForOrder = deductStockForOrder;
exports.restoreStockForOrder = restoreStockForOrder;
exports.reservePoints = reservePoints;
exports.refundRedeemedPoints = refundRedeemedPoints;
exports.sendReceiptSafely = sendReceiptSafely;
exports.getDeliveryFee = getDeliveryFee;