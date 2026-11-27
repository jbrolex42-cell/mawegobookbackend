
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

const COLLECTION_NAME = 'orders';

const RECEIPT_PREFIX = 'MB';

const DEFAULT_SHOP_DETAILS = Object.freeze({
  name: 'Mawego Bookshop',
  address: 'Kenya',
  phone: '',
  email: '',
  footer: 'Thank you for shopping with Mawego Bookshop.'
});

function getOrdersCollection() {
  if (
    mongoose.connection.readyState !== 1 ||
    !mongoose.connection.db
  ) {
    throw new Error('MongoDB database is not connected.');
  }

  return mongoose.connection.db.collection(COLLECTION_NAME);
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function toNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}

function firstDefined(...values) {
  return values.find(
    value => value !== undefined && value !== null
  );
}

function normalizeText(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim();

  return normalized || fallback;
}

function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');

  if (!digits) {
    return '';
  }

  if (digits.length === 10 && digits.startsWith('0')) {
    digits = `254${digits.slice(1)}`;
  }

  if (
    digits.length === 9 &&
    (digits.startsWith('7') || digits.startsWith('1'))
  ) {
    digits = `254${digits}`;
  }

  return digits;
}

function normalizeDate(value) {
  const date = value ? new Date(value) : new Date();

  return Number.isNaN(date.getTime())
    ? new Date()
    : date;
}

function generateReceiptNumber(order) {
  const date = normalizeDate(
    order.created_at ||
    order.createdAt
  );

  const year = date.getUTCFullYear();

  const orderId = String(order._id)
    .slice(-8)
    .toUpperCase();

  return `${RECEIPT_PREFIX}-${year}-${orderId}`;
}

function isOrderPaid(order) {
  const paymentStatus = normalizeText(
    firstDefined(
      order.payment_status,
      order.paymentStatus
    ),
    'pending'
  ).toLowerCase();

  return paymentStatus === 'paid';
}

function getShopDetails() {
  return {
    name: normalizeText(
      process.env.SHOP_NAME,
      DEFAULT_SHOP_DETAILS.name
    ),

    address: normalizeText(
      process.env.SHOP_ADDRESS,
      DEFAULT_SHOP_DETAILS.address
    ),

    phone: normalizeText(
      process.env.SHOP_PHONE,
      DEFAULT_SHOP_DETAILS.phone
    ),

    email: normalizeText(
      process.env.SHOP_EMAIL,
      DEFAULT_SHOP_DETAILS.email
    ),

    footer: normalizeText(
      process.env.SHOP_RECEIPT_FOOTER,
      DEFAULT_SHOP_DETAILS.footer
    )
  };
}

function normalizeOrderItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map(item => {
    const quantity = Math.max(
      0,
      toNumber(
        firstDefined(item.quantity, item.qty),
        0
      )
    );

    const unitPrice = Math.max(
      0,
      toNumber(
        firstDefined(
          item.price_kes,
          item.unit_price_kes,
          item.price
        ),
        0
      )
    );

    const lineTotal = Math.max(
      0,
      toNumber(
        firstDefined(
          item.line_total_kes,
          item.line_total
        ),
        unitPrice * quantity
      )
    );

    return {
      product_name: normalizeText(
        firstDefined(
          item.product_name,
          item.name,
          item.title
        ),
        'Bookshop item'
      ),

      quantity,

      line_total_kes: lineTotal
    };
  });
}

function normalizeOrder(order) {
  const items = normalizeOrderItems(order.items);

  const subtotal = Math.max(
    0,
    toNumber(
      firstDefined(
        order.subtotal_kes,
        order.subtotal
      ),
      0
    )
  );

  const discount = Math.max(
    0,
    toNumber(
      firstDefined(
        order.discount_total_kes,
        order.discount_total
      ),
      0
    )
  );

  const deliveryFee = Math.max(
    0,
    toNumber(
      firstDefined(
        order.delivery_fee_kes,
        order.delivery_fee
      ),
      0
    )
  );

  const total = Math.max(
    0,
    toNumber(
      firstDefined(
        order.total_kes,
        order.total
      ),
      Math.max(0, subtotal - discount) + deliveryFee
    )
  );

  const customer = order.customer || {};

  return {
    order_number: normalizeText(
      firstDefined(
        order.order_number,
        order.orderNumber
      ),
      String(order._id)
    ),

    created_at: normalizeDate(
      firstDefined(
        order.created_at,
        order.createdAt
      )
    ),

    customer_name: normalizeText(
      firstDefined(
        order.customer_name,
        order.customerName,
        customer.name
      ),
      'Customer'
    ),

    customer_phone: normalizeText(
      firstDefined(
        order.customer_phone,
        order.customerPhone,
        customer.phone
      )
    ),

    customer_email: normalizeText(
      firstDefined(
        order.customer_email,
        order.customerEmail,
        customer.email
      )
    ),

    fulfilment_type: normalizeText(
      firstDefined(
        order.fulfilment_type,
        order.fulfilmentType
      ),
      'collection'
    ),

    delivery_address: normalizeText(
      firstDefined(
        order.delivery_address,
        order.deliveryAddress
      )
    ),

    payment_method: normalizeText(
      firstDefined(
        order.payment_method,
        order.paymentMethod
      ),
      'Not specified'
    ),

    payment_status: normalizeText(
      firstDefined(
        order.payment_status,
        order.paymentStatus
      ),
      'pending'
    ),

    order_status: normalizeText(
      firstDefined(
        order.order_status,
        order.orderStatus
      ),
      'pending'
    ),

    mpesa_receipt: normalizeText(
      firstDefined(
        order.mpesa_receipt,
        order.mpesaReceipt
      )
    ),

    items,

    subtotal_kes: subtotal,

    discount_total_kes: discount,

    delivery_fee_kes: deliveryFee,

    total_kes: total
  };
}

async function ensureReceiptNumber(order) {
  const existingReceiptNumber = normalizeText(
    order.receipt_number
  );

  if (existingReceiptNumber) {
    return existingReceiptNumber;
  }

  const collection = getOrdersCollection();

  const generatedReceiptNumber = generateReceiptNumber(order);

  await collection.updateOne(
    {
      _id: order._id,
      $or: [
        { receipt_number: null },
        { receipt_number: '' },
        { receipt_number: { $exists: false } }
      ]
    },
    {
      $set: {
        receipt_number: generatedReceiptNumber
      }
    }
  );

  const updatedOrder = await collection.findOne(
    { _id: order._id },
    {
      projection: {
        receipt_number: 1
      }
    }
  );

  if (!updatedOrder || !updatedOrder.receipt_number) {
    throw new Error('Could not generate or retrieve receipt number.');
  }

  return updatedOrder.receipt_number;
}

async function buildReceipt(order) {
  if (!order) {
    throw new Error('Order is required to generate a receipt.');
  }

  if (!isOrderPaid(order)) {
    const error = new Error(
      'A receipt cannot be generated for an unpaid order.'
    );

    error.statusCode = 400;

    throw error;
  }

  const receiptNumber = await ensureReceiptNumber(order);

  return {
    receipt: {
      receipt_number: receiptNumber,
      order: normalizeOrder(order),
      shop: getShopDetails()
    }
  };
}

function verifyCustomerPhone(order, suppliedPhone) {
  const phone = normalizePhone(suppliedPhone);

  const customer = order.customer || {};

  const orderPhone = normalizePhone(
    firstDefined(
      order.customer_phone,
      order.customerPhone,
      customer.phone
    )
  );

  return Boolean(
    phone &&
    orderPhone &&
    phone === orderPhone
  );
}

function handleRouteError(res, error, context) {
  console.error(`${context}:`, error);

  const statusCode =
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode < 500
      ? error.statusCode
      : 500;

  return res.status(statusCode).json({
    success: false,
    message: statusCode === 500
      ? 'Unable to retrieve receipt.'
      : error.message
  });
}

router.get('/order/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID.'
      });
    }

    const collection = getOrdersCollection();

    const order = await collection.findOne({
      _id: new mongoose.Types.ObjectId(id)
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found.'
      });
    }

    const result = await buildReceipt(order);

    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    return handleRouteError(
      res,
      error,
      'Receipt lookup by ID failed'
    );
  }
});

router.get('/number/:orderNumber', async (req, res) => {
  try {
    const orderNumber = normalizeText(
      req.params.orderNumber
    );

    const suppliedPhone = req.query.phone;

    if (!orderNumber || orderNumber.length > 150) {
      return res.status(400).json({
        success: false,
        message: 'A valid order number is required.'
      });
    }

    if (
      typeof suppliedPhone !== 'string' ||
      !normalizePhone(suppliedPhone)
    ) {
      return res.status(400).json({
        success: false,
        message: 'A valid customer phone number is required.'
      });
    }

    const collection = getOrdersCollection();

    const order = await collection.findOne({
      $or: [
        { order_number: orderNumber },
        { orderNumber: orderNumber }
      ]
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found.'
      });
    }

    if (!verifyCustomerPhone(order, suppliedPhone)) {
      return res.status(403).json({
        success: false,
        message: 'Order verification failed.'
      });
    }

    const result = await buildReceipt(order);

    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    return handleRouteError(
      res,
      error,
      'Receipt lookup by order number failed'
    );
  }
});

module.exports = router;