
'use strict';

const mongoose = require('mongoose');

const { Notification } = require('../models');

const {
  serialize,
  serializeMany,
  parsePagination
} = require('../utils/helpers');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const ADMIN_ROLE = 'admin';
const CUSTOMER_ROLE = 'customer';

const NOTIFICATION_AUDIENCES = {
  ADMIN: 'admin',
  CUSTOMER: 'customer'
};

const NOTIFICATION_TYPES = {
  ORDER_PLACED: 'order_placed',
  ORDER_STATUS: 'order_status'
};

function getId(value) {
  if (!value) return null;

  if (typeof value === 'object' && value._id) {
    return String(value._id);
  }

  return String(value);
}

function getUserId(req) {
  return getId(req.user?.id || req.user?._id);
}

function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value);
}

function formatCurrency(amount) {
  const value = Number(amount);

  if (!Number.isFinite(value)) {
    return 'KES 0';
  }

  return `KES ${value.toLocaleString('en-KE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  })}`;
}

function getTrackingLink(orderNumber) {
  return `/pages/track.html?order=${encodeURIComponent(
    String(orderNumber || '')
  )}`;
}

function getOrderId(order) {
  return order?._id || order?.id || null;
}

function validateOrder(order) {
  if (!order || typeof order !== 'object') {
    throw new Error('A valid order is required to create a notification.');
  }

  if (!getOrderId(order)) {
    throw new Error('Order ID is required.');
  }

  if (!order.order_number) {
    throw new Error('Order number is required.');
  }

  if (!Number.isFinite(Number(order.total_kes))) {
    throw new Error('A valid order total is required.');
  }
}

function handleError(res, err, message) {
  console.error(`[NotificationController] ${message}:`, err);

  return res.status(500).json({
    error: message
  });
}

function scopeFilter(req) {
  if (!req.user) {
    return null;
  }

  const role = String(req.user.role || '').toLowerCase();

  if (role === CUSTOMER_ROLE) {
    const userId = getUserId(req);

    if (!userId || !isValidObjectId(userId)) {
      return null;
    }

    return {
      audience: NOTIFICATION_AUDIENCES.CUSTOMER,
      user_id: userId
    };
  }

  if (role === ADMIN_ROLE) {
    return {
      audience: NOTIFICATION_AUDIENCES.ADMIN
    };
  }

  return null;
}

function getScopedFilter(req, extra = {}) {
  const scope = scopeFilter(req);

  if (!scope) {
    return null;
  }

  return {
    ...scope,
    ...extra
  };
}

function getPagination(query) {
  const parsed = parsePagination(query || {});

  const page = Math.max(
    1,
    Number.isFinite(Number(parsed.page))
      ? Math.floor(Number(parsed.page))
      : DEFAULT_PAGE
  );

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(
      1,
      Number.isFinite(Number(parsed.limit))
        ? Math.floor(Number(parsed.limit))
        : DEFAULT_LIMIT
    )
  );

  return {
    page,
    limit,
    skip: (page - 1) * limit
  };
}

async function notifyOrderPlaced(order) {
  validateOrder(order);

  const orderId = getOrderId(order);
  const orderNumber = String(order.order_number);
  const total = Number(order.total_kes);

  const customerName = String(
    order.customer_name || 'A customer'
  ).trim();

  const fulfilment =
    order.fulfilment_type === 'delivery'
      ? 'Delivery'
      : 'Collection';

  const notifications = [
    {
      audience: NOTIFICATION_AUDIENCES.ADMIN,
      user_id: null,
      type: NOTIFICATION_TYPES.ORDER_PLACED,
      title: 'New order',
      body: `${customerName} placed ${orderNumber} · ${formatCurrency(total)} · ${fulfilment}`,
      order_id: orderId,
      order_number: orderNumber,
      link: '/pages/admin.html#orders',
      is_read: false,
      meta: {
        payment_method: order.payment_method || null,
        total_kes: total,
        fulfilment_type: order.fulfilment_type || null
      }
    }
  ];

  if (order.user_id) {
    notifications.push({
      audience: NOTIFICATION_AUDIENCES.CUSTOMER,
      user_id: order.user_id,
      type: NOTIFICATION_TYPES.ORDER_PLACED,
      title: 'Order received',
      body: `Your order ${orderNumber} was placed successfully. Total ${formatCurrency(total)}.`,
      order_id: orderId,
      order_number: orderNumber,
      link: getTrackingLink(orderNumber),
      is_read: false,
      meta: {
        total_kes: total
      }
    });
  }

  await Notification.insertMany(notifications, {
    ordered: true
  });

  return true;
}

async function notifyOrderStatus(order, statusLabel) {
  if (!order || !order.user_id) {
    return false;
  }

  if (!getOrderId(order) || !order.order_number) {
    throw new Error('A valid order is required for a status notification.');
  }

  const normalizedStatus = String(statusLabel || '').trim();

  if (!normalizedStatus) {
    throw new Error('Order status label is required.');
  }

  await Notification.create({
    audience: NOTIFICATION_AUDIENCES.CUSTOMER,
    user_id: order.user_id,
    type: NOTIFICATION_TYPES.ORDER_STATUS,
    title: 'Order update',
    body: `Order ${order.order_number} is now: ${normalizedStatus}`,
    order_id: getOrderId(order),
    order_number: String(order.order_number),
    link: getTrackingLink(order.order_number),
    is_read: false,
    meta: {
      status: normalizedStatus
    }
  });

  return true;
}

exports.list = async (req, res) => {
  try {
    const filter = getScopedFilter(req);

    if (!filter) {
      return res.status(403).json({
        error: 'You are not authorized to view these notifications.'
      });
    }

    const { page, limit, skip } = getPagination(req.query);

    if (req.query.unread === '1') {
      filter.is_read = false;
    }

    const [total, rows] = await Promise.all([
      Notification.countDocuments(filter),

      Notification.find(filter)
        .sort({
          created_at: -1,
          _id: -1
        })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    return res.json({
      notifications: serializeMany(rows),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1
      }
    });
  } catch (err) {
    return handleError(
      res,
      err,
      'Failed to load notifications'
    );
  }
};

exports.unreadCount = async (req, res) => {
  try {
    const filter = getScopedFilter(req, {
      is_read: false
    });

    if (!filter) {
      return res.status(403).json({
        error: 'You are not authorized to view these notifications.'
      });
    }

    const count = await Notification.countDocuments(filter);

    return res.json({
      count
    });
  } catch (err) {
    return handleError(
      res,
      err,
      'Failed to count notifications'
    );
  }
};

exports.markRead = async (req, res) => {
  try {
    const notificationId = req.params.id;

    if (!isValidObjectId(notificationId)) {
      return res.status(400).json({
        error: 'Invalid notification ID.'
      });
    }

    const filter = getScopedFilter(req, {
      _id: notificationId
    });

    if (!filter) {
      return res.status(403).json({
        error: 'You are not authorized to update these notifications.'
      });
    }

    const notification = await Notification.findOneAndUpdate(
      filter,
      {
        $set: {
          is_read: true
        }
      },
      {
        new: true,
        runValidators: true
      }
    ).lean();

    if (!notification) {
      return res.status(404).json({
        error: 'Notification not found.'
      });
    }

    return res.json({
      notification: serialize(notification)
    });
  } catch (err) {
    return handleError(
      res,
      err,
      'Failed to mark as read'
    );
  }
};

exports.markAllRead = async (req, res) => {
  try {
    const filter = getScopedFilter(req, {
      is_read: false
    });

    if (!filter) {
      return res.status(403).json({
        error: 'You are not authorized to update these notifications.'
      });
    }

    const result = await Notification.updateMany(
      filter,
      {
        $set: {
          is_read: true
        }
      },
      {
        runValidators: true
      }
    );

    return res.json({
      updated: result.modifiedCount ?? result.nModified ?? 0
    });
  } catch (err) {
    return handleError(
      res,
      err,
      'Failed to mark all notifications as read'
    );
  }
};

exports.clearRead = async (req, res) => {
  try {
    const filter = getScopedFilter(req, {
      is_read: true
    });

    if (!filter) {
      return res.status(403).json({
        error: 'You are not authorized to clear these notifications.'
      });
    }

    const result = await Notification.deleteMany(filter);

    return res.json({
      deleted: result.deletedCount || 0
    });
  } catch (err) {
    return handleError(
      res,
      err,
      'Failed to clear read notifications'
    );
  }
};

exports.clearAll = async (req, res) => {
  try {
    const filter = getScopedFilter(req);

    if (!filter) {
      return res.status(403).json({
        error: 'You are not authorized to clear these notifications.'
      });
    }

    const result = await Notification.deleteMany(filter);

    return res.json({
      deleted: result.deletedCount || 0
    });
  } catch (err) {
    return handleError(
      res,
      err,
      'Failed to clear notifications'
    );
  }
};

exports.notifyOrderPlaced = notifyOrderPlaced;
exports.notifyOrderStatus = notifyOrderStatus;