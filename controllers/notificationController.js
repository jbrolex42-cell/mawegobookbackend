/**
 * Order notifications — admin + customer
 * Separate module: list, unread count, mark read, mark all read, clear
 */
const { Notification } = require('../models');
const { serialize, serializeMany, parsePagination } = require('../utils/helpers');

/** Create notifications when an order is placed (call from orderController) */
async function notifyOrderPlaced(order) {
  const orderId = order._id || order.id;
  const number = order.order_number;
  const total = order.total_kes;
  const name = order.customer_name;
  const fulfilment = order.fulfilment_type === 'delivery' ? 'Delivery' : 'Collection';

  await Notification.create({
    audience: 'admin',
    user_id: null,
    type: 'order_placed',
    title: 'New order',
    body: `${name} placed ${number} · KES ${Number(total).toLocaleString('en-KE')} · ${fulfilment}`,
    order_id: orderId,
    order_number: number,
    link: '/pages/admin.html#orders',
    is_read: false,
    meta: {
      payment_method: order.payment_method,
      total_kes: total
    }
  });

  if (order.user_id) {
    await Notification.create({
      audience: 'customer',
      user_id: order.user_id,
      type: 'order_placed',
      title: 'Order received',
      body: `Your order ${number} was placed successfully. Total KES ${Number(total).toLocaleString('en-KE')}.`,
      order_id: orderId,
      order_number: number,
      link: `/pages/track.html?order=${encodeURIComponent(number)}`,
      is_read: false
    });
  }

  return true;
}

async function notifyOrderStatus(order, statusLabel) {
  if (!order.user_id) return;
  await Notification.create({
    audience: 'customer',
    user_id: order.user_id,
    type: 'order_status',
    title: 'Order update',
    body: `Order ${order.order_number} is now: ${statusLabel}`,
    order_id: order._id,
    order_number: order.order_number,
    link: `/pages/track.html?order=${encodeURIComponent(order.order_number)}`,
    is_read: false
  });
}

function scopeFilter(req) {
  const role = req.user.role;
  if (role === 'customer') {
    return { audience: 'customer', user_id: req.user.id };
  }

  return { audience: 'admin' };
}

exports.notifyOrderPlaced = notifyOrderPlaced;
exports.notifyOrderStatus = notifyOrderStatus;

exports.list = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = scopeFilter(req);
    if (req.query.unread === '1') filter.is_read = false;

    const total = await Notification.countDocuments(filter);
    const rows = await Notification.find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      notifications: serializeMany(rows),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
};

exports.unreadCount = async (req, res) => {
  try {
    const filter = { ...scopeFilter(req), is_read: false };
    const count = await Notification.countDocuments(filter);
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to count notifications' });
  }
};

exports.markRead = async (req, res) => {
  try {
    const filter = { _id: req.params.id, ...scopeFilter(req) };
    const n = await Notification.findOneAndUpdate(filter, { is_read: true }, { new: true });
    if (!n) return res.status(404).json({ error: 'Notification not found' });
    res.json({ notification: serialize(n) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark as read' });
  }
};

exports.markAllRead = async (req, res) => {
  try {
    const filter = { ...scopeFilter(req), is_read: false };
    const result = await Notification.updateMany(filter, { is_read: true });
    res.json({ updated: result.modifiedCount || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
};

exports.clearRead = async (req, res) => {
  try {
    const filter = { ...scopeFilter(req), is_read: true };
    const result = await Notification.deleteMany(filter);
    res.json({ deleted: result.deletedCount || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear notifications' });
  }
};

exports.clearAll = async (req, res) => {
  try {
    const filter = scopeFilter(req);
    const result = await Notification.deleteMany(filter);
    res.json({ deleted: result.deletedCount || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear notifications' });
  }
};