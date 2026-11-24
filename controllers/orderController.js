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

const FREE_DELIVERY_THRESHOLD =
  Number(process.env.FREE_DELIVERY_THRESHOLD_KES) || 2000;

const DEFAULT_DELIVERY_FEE =
  Number(process.env.DEFAULT_DELIVERY_FEE_KES) || 200;

function getDeliveryFee(subtotal, fulfilmentType) {
  if (fulfilmentType === 'collection') return 0;

  if (subtotal >= FREE_DELIVERY_THRESHOLD) return 0;

  return DEFAULT_DELIVERY_FEE;
}

async function deductStockForOrder(order) {
  const already = await StockLedger.findOne({
    reference_type: 'order',
    reference_id: String(order._id),
    reason: 'sale'
  });

  if (already) return;

  for (const item of order.items || []) {
    const product = await Product.findById(item.product_id);

    if (!product) {
      throw new Error(`Product not found for ${item.product_name}.`);
    }

    if (Number(product.stock_qty) < Number(item.quantity)) {
      throw new Error(
        `Insufficient stock for ${item.product_name}.`
      );
    }

    product.stock_qty -= Number(item.quantity);
    await product.save();

    await StockLedger.create({
      product_id: product._id,
      change_qty: -Number(item.quantity),
      balance_after: product.stock_qty,
      reason: 'sale',
      reference_type: 'order',
      reference_id: String(order._id),
      notes: order.order_number
    });
  }
}

async function restoreStockForOrder(order) {
  const saleEntries = await StockLedger.find({
    reference_type: 'order',
    reference_id: String(order._id),
    reason: 'sale'
  });

  if (!saleEntries.length) return;

  const alreadyRestored = await StockLedger.findOne({
    reference_type: 'order',
    reference_id: String(order._id),
    reason: 'sale_cancel'
  });

  if (alreadyRestored) return;

  for (const entry of saleEntries) {
    const product = await Product.findById(entry.product_id);

    if (!product) continue;

    product.stock_qty += Math.abs(Number(entry.change_qty));
    await product.save();

    await StockLedger.create({
      product_id: product._id,
      change_qty: Math.abs(Number(entry.change_qty)),
      balance_after: product.stock_qty,
      reason: 'sale_cancel',
      reference_type: 'order',
      reference_id: String(order._id),
      notes: order.order_number
    });
  }
}

async function awardPoints(userId, order, points) {
  if (!userId || !points || points <= 0) return;

  const already = await PointsLedger.findOne({
    order_id: order._id,
    reason: 'earn'
  });

  if (already) return;

  const user = await User.findById(userId);

  if (!user) return;

  user.reward_points = Number(user.reward_points || 0) + points;
  await user.save();

  await PointsLedger.create({
    user_id: user._id,
    order_id: order._id,
    change: points,
    balance_after: user.reward_points,
    reason: 'earn',
    notes: order.order_number
  });
}

async function reservePoints(userId, orderId, points, orderNumber) {
  if (!userId || !points || points <= 0) return;

  const user = await User.findOneAndUpdate(
    {
      _id: userId,
      reward_points: { $gte: points }
    },
    {
      $inc: { reward_points: -points }
    },
    { new: true }
  );

  if (!user) {
    throw new Error('Your reward points balance changed. Please try again.');
  }

  try {
    await PointsLedger.create({
      user_id: user._id,
      order_id: orderId,
      change: -points,
      balance_after: user.reward_points,
      reason: 'redeem',
      notes: orderNumber
    });
  } catch (err) {
    await User.updateOne(
      { _id: userId },
      { $inc: { reward_points: points } }
    );

    throw err;
  }
}

async function refundRedeemedPoints(order) {
  if (
    !order.user_id ||
    !Number(order.points_redeemed || 0) ||
    order.points_redeemed_refunded
  ) {
    return;
  }

  const already = await PointsLedger.findOne({
    order_id: order._id,
    reason: 'redeem_reversal'
  });

  if (already) {
    order.points_redeemed_refunded = true;
    await order.save();
    return;
  }

  const points = Number(order.points_redeemed);

  const user = await User.findByIdAndUpdate(
    order.user_id,
    { $inc: { reward_points: points } },
    { new: true }
  );

  if (!user) return;

  await PointsLedger.create({
    user_id: user._id,
    order_id: order._id,
    change: points,
    balance_after: user.reward_points,
    reason: 'redeem_reversal',
    notes: `Cancelled order ${order.order_number}`
  });

  order.points_redeemed_refunded = true;
  await order.save();
}

async function sendReceiptSafely(order) {
  try {
    await sendOrderReceipt(order);
  } catch (err) {
    console.error(
      'Receipt email failed for order:',
      order._id,
      err.message
    );
  }
}

exports.awardPoints = awardPoints;
exports.deductStockForOrder = deductStockForOrder;

exports.create = async (req, res) => {
  let reservedPoints = 0;
  let reservedUserId = null;
  let createdOrder = null;

  try {
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

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Your basket is empty.' });
    }

    if (!customer_name || !customer_phone) {
      return res.status(400).json({
        error: 'Customer name and phone are required.'
      });
    }

    if (!['delivery', 'collection'].includes(fulfilment_type)) {
      return res.status(400).json({ error: 'Invalid fulfilment type.' });
    }

    if (fulfilment_type === 'delivery' && !delivery_address) {
      return res.status(400).json({
        error: 'Delivery address is required.'
      });
    }

    if (!['mpesa', 'card', 'cash_on_delivery'].includes(payment_method)) {
      return res.status(400).json({ error: 'Invalid payment method.' });
    }

    const lineItems = [];
    let subtotal = 0;
    let productDiscount = 0;

    for (const item of items) {
      const product = await Product.findOne({
        _id: item.product_id,
        is_active: true
      });

      if (!product) {
        return res.status(400).json({
          error: `Product not found: ${item.product_id}`
        });
      }

      const quantity = Math.floor(Number(item.quantity));

      if (!Number.isFinite(quantity) || quantity < 1) {
        return res.status(400).json({
          error: `Invalid quantity for ${product.name}.`
        });
      }

      if (Number(product.stock_qty) < quantity) {
        return res.status(400).json({
          error: `Insufficient stock for "${product.name}". Available: ${product.stock_qty}`
        });
      }

      const original = Number(product.price_kes);
      const unit = Number(effectivePrice(product));
      const lineTotal = unit * quantity;

      subtotal += lineTotal;
      productDiscount += Math.max(0, original - unit) * quantity;

      lineItems.push({
        product,
        quantity,
        unit_price: unit,
        original_price: original,
        line_total: lineTotal,
        discount_percent: isSaleActive(product) && original > 0
          ? Math.round((1 - unit / original) * 100)
          : 0
      });
    }

    subtotal = Math.round(subtotal);

    let couponCode = null;
    let couponDiscount = 0;

    if (req.body.coupon_code) {
      const promoResult = await validatePromoForCustomer(
        req.body.coupon_code,
        subtotal,
        req.user?.id
      );

      couponCode = promoResult.code;
      couponDiscount = promoResult.discount_kes;
    }

    const afterCoupon = Math.max(0, subtotal - couponDiscount);

    let pointsRedeemed = Math.max(
      0,
      Math.floor(Number(req.body.points_redeemed) || 0)
    );

    let pointsValueKes = 0;

    if (pointsRedeemed > 0) {
      if (!req.user) {
        return res.status(400).json({
          error: 'Sign in to redeem reward points.'
        });
      }

      if (pointsRedeemed < MIN_REDEEM_POINTS) {
        return res.status(400).json({
          error: `You need at least ${MIN_REDEEM_POINTS} points to redeem.`
        });
      }

      const user = await User.findById(req.user.id);

      if (!user) {
        return res.status(401).json({ error: 'User not found.' });
      }

      if (pointsRedeemed > Number(user.reward_points || 0)) {
        return res.status(400).json({
          error: 'You do not have enough reward points.'
        });
      }

      pointsValueKes = pointsToKes(pointsRedeemed);

      if (pointsValueKes > afterCoupon) {
        pointsValueKes = afterCoupon;
        pointsRedeemed = Math.floor(pointsValueKes / 0.5);

        if (pointsRedeemed < MIN_REDEEM_POINTS) {
          pointsRedeemed = 0;
          pointsValueKes = 0;
        }
      }
    }

    const deliveryFee = getDeliveryFee(subtotal, fulfilment_type);

    const total = Math.max(
      0,
      Math.round(afterCoupon + deliveryFee - pointsValueKes)
    );

    const pointsEarned = pointsEarnedFromKes(afterCoupon);

    const order = await Order.create({
      order_number: generateOrderNumber(),
      user_id: req.user?.id || null,
      customer_name: customer_name.trim(),
      customer_phone: customer_phone.trim(),
      customer_email: customer_email || null,
      fulfilment_type,
      delivery_address: delivery_address || null,
      delivery_notes: delivery_notes || null,
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
      order_status: payment_method === 'cash_on_delivery'
        ? 'confirmed'
        : 'pending',
      notes: notes || null,
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

    if (pointsRedeemed > 0 && req.user) {
      reservedPoints = pointsRedeemed;
      reservedUserId = req.user.id;

      await reservePoints(
        req.user.id,
        order._id,
        pointsRedeemed,
        order.order_number
      );
    }

    if (couponCode) {
      const promoUpdate = await PromoCode.findOneAndUpdate(
        {
          code: couponCode,
          is_active: true,
          $or: [
            { usage_limit: null },
            { usage_limit: { $exists: false } },
            { $expr: { $lt: ['$used_count', '$usage_limit'] } }
          ]
        },
        { $inc: { used_count: 1 } },
        { new: true }
      );

      if (!promoUpdate) {
        throw new Error('This promotional code has just reached its usage limit. Please try again.');
      }
    }

    // COD orders reserve stock immediately. Points are earned only
    // after the order is marked paid by the authorised payment flow.
    if (payment_method === 'cash_on_delivery') {
      await deductStockForOrder(order);
    }

    return res.status(201).json({
      order: serialize(order),
      points_earned: pointsEarned,
      points_redeemed: pointsRedeemed,
      coupon_discount_kes: couponDiscount,
      message: payment_method === 'cash_on_delivery'
        ? 'Order placed. Pay when your order is delivered or collected.'
        : 'Order created. Complete payment to confirm your order and earn reward points.'
    });
  } catch (err) {
    console.error('Create order error:', err);

    // Compensate for a points reservation if order creation later fails.
    if (reservedPoints && reservedUserId && createdOrder) {
      try {
        await User.updateOne(
          { _id: reservedUserId },
          { $inc: { reward_points: reservedPoints } }
        );

        await PointsLedger.create({
          user_id: reservedUserId,
          order_id: createdOrder._id,
          change: reservedPoints,
          balance_after: 0,
          reason: 'redeem_reversal',
          notes: 'Automatic reversal after order creation failure'
        });
      } catch (refundError) {
        console.error('Points compensation failed:', refundError);
      }
    }

    if (createdOrder) {
      try {
        await Order.deleteOne({ _id: createdOrder._id });
      } catch (deleteError) {
        console.error('Failed to remove incomplete new order:', deleteError);
      }
    }

    return res.status(400).json({
      error: err.message || 'Failed to create order.'
    });
  }
};

exports.getByNumber = async (req, res) => {
  try {
    const order = await Order.findOne({
      order_number: req.params.orderNumber
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    if (req.query.phone) {
      const stored = String(order.customer_phone || '').replace(/\s/g, '');
      const supplied = String(req.query.phone).replace(/\s/g, '');

      if (stored !== supplied) {
        return res.status(403).json({
          error: 'Phone does not match this order.'
        });
      }
    }

    res.json({ order: serialize(order) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load order.' });
  }
};

// Authenticated customer: only return status for their own order.
exports.getCustomerStatus = async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      user_id: req.user.id
    }).select(
      'order_number payment_status order_status payment_method total_kes'
    );

    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    res.json({ order: serialize(order) });
  } catch (err) {
    res.status(400).json({ error: 'Unable to check order status.' });
  }
};

// Customer cancellation is a status change, not permanent deletion.
exports.cancelCustomerOrder = async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      user_id: req.user.id
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    if (order.order_status === 'cancelled') {
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

    await restoreStockForOrder(order);
    await refundRedeemedPoints(order);

    order.order_status = 'cancelled';
    await order.save();

    res.json({
      order: serialize(order),
      message: 'Your order has been cancelled. Redeemed points have been returned to your account.'
    });
  } catch (err) {
    console.error('Customer cancellation error:', err);
    res.status(500).json({
      error: 'Unable to cancel this order.'
    });
  }
};

exports.listAdmin = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};

    if (req.query.status) filter.order_status = req.query.status;
    if (req.query.payment_status) filter.payment_status = req.query.payment_status;

    if (req.query.q) {
      const q = req.query.q;

      filter.$or = [
        { order_number: new RegExp(q, 'i') },
        { customer_name: new RegExp(q, 'i') },
        { customer_phone: new RegExp(q, 'i') }
      ];
    }

    const total = await Order.countDocuments(filter);

    const orders = await Order.find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      orders: serializeMany(orders),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list orders.' });
  }
};

exports.getAdmin = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    res.json({ order: serialize(order) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load order.' });
  }
};

exports.updateStatus = async (req, res) => {
  try {
    const { order_status, payment_status, notes } = req.body;
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const allowedOrder = [
      'pending',
      'confirmed',
      'processing',
      'ready',
      'out_for_delivery',
      'completed',
      'cancelled'
    ];

    const allowedPayment = [
      'pending',
      'paid',
      'failed',
      'refunded'
    ];

    if (order_status && !allowedOrder.includes(order_status)) {
      return res.status(400).json({ error: 'Invalid order status.' });
    }

    if (payment_status && !allowedPayment.includes(payment_status)) {
      return res.status(400).json({ error: 'Invalid payment status.' });
    }

    if (payment_status === 'paid' && order.payment_status !== 'paid') {
      const paid = await exports.markPaid(order._id);
      if (!paid) {
        return res.status(400).json({ error: 'Unable to mark order paid.' });
      }
    }

    if (order_status === 'cancelled' && order.order_status !== 'cancelled') {
      if (order.payment_status === 'paid') {
        return res.status(400).json({
          error: 'Paid orders require the refund workflow before cancellation.'
        });
      }

      await restoreStockForOrder(order);
      await refundRedeemedPoints(order);
    }

    if (order_status) order.order_status = order_status;
    if (payment_status) order.payment_status = payment_status;
    if (notes !== undefined) order.notes = notes;

    await order.save();

    res.json({ order: serialize(order) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update order.' });
  }
};

exports.markPaid = async (orderId, paymentMeta = {}) => {
  const order = await Order.findById(orderId);

  if (!order || order.payment_status === 'paid') {
    return order ? serialize(order) : null;
  }

  if (order.order_status === 'cancelled') {
    throw new Error('Cancelled orders cannot be marked paid.');
  }

  order.payment_status = 'paid';

  if (order.order_status === 'pending') {
    order.order_status = 'confirmed';
  }

  if (paymentMeta.mpesa_receipt) {
    order.mpesa_receipt = paymentMeta.mpesa_receipt;
  }

  if (paymentMeta.card_reference) {
    order.card_reference = paymentMeta.card_reference;
  }

  if (paymentMeta.payment_reference) {
    order.payment_reference = paymentMeta.payment_reference;
  }

  await order.save();

  if (order.payment_method !== 'cash_on_delivery') {
    await deductStockForOrder(order);
  }

  if (order.user_id && order.points_earned > 0) {
    await awardPoints(
      order.user_id,
      order,
      order.points_earned
    );
  }

  await sendReceiptSafely(order);

  return serialize(order);
};
    if (pointsRedeemed > 0 && req.user) {
      await reservePoints(
        req.user.id,
        order._id,
        pointsRedeemed,
        order.order_number
      );

      reservedPoints = pointsRedeemed;
      reservedUserId = req.user.id;
    }