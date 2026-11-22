const { Order, Product, StockLedger, User, PointsLedger } = require('../models');
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

const FREE_DELIVERY_THRESHOLD = Number(process.env.FREE_DELIVERY_THRESHOLD_KES) || 2000;
const DEFAULT_DELIVERY_FEE = Number(process.env.DEFAULT_DELIVERY_FEE_KES) || 200;

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
    if (!product) continue;
    const newQty = Math.max(0, product.stock_qty - item.quantity);
    product.stock_qty = newQty;
    await product.save();
    await StockLedger.create({
      product_id: product._id,
      change_qty: -item.quantity,
      balance_after: newQty,
      reason: 'sale',
      reference_type: 'order',
      reference_id: String(order._id),
      notes: order.order_number
    });
  }
}

async function restoreStockForOrder(order) {
  const already = await StockLedger.findOne({
    reference_type: 'order',
    reference_id: String(order._id),
    reason: 'sale_cancel'
  });
  if (already) return;

  for (const item of order.items || []) {
    const product = await Product.findById(item.product_id);
    if (!product) continue;
    const newQty = product.stock_qty + item.quantity;
    product.stock_qty = newQty;
    await product.save();
    await StockLedger.create({
      product_id: product._id,
      change_qty: item.quantity,
      balance_after: newQty,
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
  user.reward_points = (user.reward_points || 0) + points;
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

exports.awardPoints = awardPoints;

exports.create = async (req, res) => {
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

    if (!items || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Cart is empty' });
    }
    if (!customer_name || !customer_phone) {
      return res.status(400).json({ error: 'Customer name and phone are required' });
    }
    if (!['delivery', 'collection'].includes(fulfilment_type)) {
      return res.status(400).json({ error: 'Invalid fulfilment type' });
    }
    if (fulfilment_type === 'delivery' && !delivery_address) {
      return res.status(400).json({ error: 'Delivery address is required' });
    }
    if (!['mpesa', 'card', 'cash_on_delivery'].includes(payment_method)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    const lineItems = [];
    let subtotal = 0;
    let discountTotal = 0;

    for (const item of items) {
      const product = await Product.findOne({ _id: item.product_id, is_active: true });
      if (!product) {
        return res.status(400).json({ error: `Product not found: ${item.product_id}` });
      }
      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      if (product.stock_qty < qty) {
        return res.status(400).json({
          error: `Insufficient stock for "${product.name}". Available: ${product.stock_qty}`
        });
      }
      const original = Number(product.price_kes);
      const unit = effectivePrice(product);
      const lineTotal = unit * qty;
      const lineDiscount = (original - unit) * qty;
      subtotal += lineTotal;
      discountTotal += lineDiscount;
      lineItems.push({
        product,
        quantity: qty,
        unit_price: unit,
        original_price: original,
        line_total: lineTotal,
        discount_percent: isSaleActive(product)
          ? (original > 0 ? Math.round((1 - unit / original) * 100) : 0)
          : 0
      });
    }

    // Redeem reward points (logged-in customers only)
    let pointsRedeemed = Math.max(0, parseInt(req.body.points_redeemed, 10) || 0);
    let pointsValueKes = 0;
    if (pointsRedeemed > 0) {
      if (!req.user) {
        return res.status(400).json({ error: 'Login required to redeem reward points' });
      }
      const user = await User.findById(req.user.id);
      if (!user) return res.status(400).json({ error: 'User not found' });
      if (pointsRedeemed < MIN_REDEEM_POINTS) {
        return res.status(400).json({ error: `Minimum ${MIN_REDEEM_POINTS} points to redeem` });
      }
      if (pointsRedeemed > (user.reward_points || 0)) {
        return res.status(400).json({ error: 'Not enough reward points' });
      }
      pointsValueKes = pointsToKes(pointsRedeemed);
      // Cap redeem value at subtotal
      if (pointsValueKes > subtotal) {
        pointsValueKes = subtotal;
        pointsRedeemed = Math.ceil(pointsValueKes / 0.5);
      }
    }

    const deliveryFee = getDeliveryFee(subtotal, fulfilment_type);
    const total = Math.max(0, subtotal + deliveryFee - pointsValueKes);
    const pointsEarned = pointsEarnedFromKes(subtotal); // earn on product subtotal
    const orderNumber = generateOrderNumber();
    const orderStatus = payment_method === 'cash_on_delivery' ? 'confirmed' : 'pending';

    const order = await Order.create({
      order_number: orderNumber,
      user_id: req.user ? req.user.id : null,
      customer_name: customer_name.trim(),
      customer_phone: customer_phone.trim(),
      customer_email: customer_email || null,
      fulfilment_type,
      delivery_address: delivery_address || null,
      delivery_notes: delivery_notes || null,
      delivery_fee_kes: deliveryFee,
      subtotal_kes: subtotal,
      total_kes: total,
      discount_total_kes: discountTotal,
      points_earned: pointsEarned,
      points_redeemed: pointsRedeemed,
      points_value_kes: pointsValueKes,
      payment_method,
      payment_status: 'pending',
      order_status: orderStatus,
      notes: notes || null,
      items: lineItems.map((li) => ({
        product_id: li.product._id,
        product_name: li.product.name,
        sku: li.product.sku,
        quantity: li.quantity,
        unit_price_kes: li.unit_price,
        original_price_kes: li.original_price,
        discount_percent: li.discount_percent,
        line_total_kes: li.line_total
      }))
    });

    // Deduct redeemed points immediately
    if (pointsRedeemed > 0 && req.user) {
      const user = await User.findById(req.user.id);
      user.reward_points = Math.max(0, (user.reward_points || 0) - pointsRedeemed);
      await user.save();
      await PointsLedger.create({
        user_id: user._id,
        order_id: order._id,
        change: -pointsRedeemed,
        balance_after: user.reward_points,
        reason: 'redeem',
        notes: order.order_number
      });
    }

    if (payment_method === 'cash_on_delivery') {
      await deductStockForOrder(order);
      // Award points on COD when order is placed (confirmed)
      if (req.user && pointsEarned > 0) {
        await awardPoints(req.user.id, order, pointsEarned);
      }
    }

    res.status(201).json({
      order: serialize(order),
      points_earned: pointsEarned,
      points_redeemed: pointsRedeemed,
      message:
        payment_method === 'cash_on_delivery'
          ? `Order placed. Pay cash on delivery or collection.${pointsEarned ? ' You earned ' + pointsEarned + ' reward points!' : ''}`
          : 'Order created. Complete payment to confirm and earn reward points.'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create order' });
  }
};

exports.getByNumber = async (req, res) => {
  try {
    const order = await Order.findOne({ order_number: req.params.orderNumber });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (req.query.phone) {
      const a = order.customer_phone.replace(/\s/g, '');
      const b = String(req.query.phone).replace(/\s/g, '');
      if (a !== b) return res.status(403).json({ error: 'Phone does not match this order' });
    }
    res.json({ order: serialize(order) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load order' });
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
    const orders = await Order.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit);
    res.json({
      orders: serializeMany(orders),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list orders' });
  }
};

exports.getAdmin = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order: serialize(order) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load order' });
  }
};

exports.updateStatus = async (req, res) => {
  try {
    const { order_status, payment_status, notes } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const allowedOrder = [
      'pending',
      'confirmed',
      'processing',
      'ready',
      'out_for_delivery',
      'completed',
      'cancelled'
    ];
    const allowedPay = ['pending', 'paid', 'failed', 'refunded'];
    if (order_status && !allowedOrder.includes(order_status)) {
      return res.status(400).json({ error: 'Invalid order status' });
    }
    if (payment_status && !allowedPay.includes(payment_status)) {
      return res.status(400).json({ error: 'Invalid payment status' });
    }

    if (payment_status === 'paid' && order.payment_status !== 'paid' && order.payment_method !== 'cash_on_delivery') {
      await deductStockForOrder(order);
    }
    if (order_status === 'cancelled' && order.order_status !== 'cancelled') {
      if (order.payment_status === 'paid' || order.payment_method === 'cash_on_delivery') {
        await restoreStockForOrder(order);
      }
    }

    if (order_status) order.order_status = order_status;
    if (payment_status) order.payment_status = payment_status;
    if (notes !== undefined) order.notes = notes;
    await order.save();

    res.json({ order: serialize(order) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update order' });
  }
};

exports.markPaid = async (orderId, paymentMeta = {}) => {
  const order = await Order.findById(orderId);
  if (!order || order.payment_status === 'paid') return order ? serialize(order) : null;

  order.payment_status = 'paid';
  if (order.order_status === 'pending') order.order_status = 'confirmed';
  if (paymentMeta.mpesa_receipt) order.mpesa_receipt = paymentMeta.mpesa_receipt;
  if (paymentMeta.card_reference) order.card_reference = paymentMeta.card_reference;
  if (paymentMeta.payment_reference) order.payment_reference = paymentMeta.payment_reference;
  await order.save();

  if (order.payment_method !== 'cash_on_delivery') {
    await deductStockForOrder(order);
  }
  // Award reward points when payment is confirmed
  if (order.user_id && order.points_earned > 0) {
    await awardPoints(order.user_id, order, order.points_earned);
  }
  return serialize(order);
};

module.exports.deductStockForOrder = deductStockForOrder;
