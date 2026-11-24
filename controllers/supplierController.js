
'use strict';

const mongoose = require('mongoose');

const {
  Supplier,
  PurchaseOrder,
  Product,
  StockLedger
} = require('../models');

const {
  generatePoNumber,
  parsePagination,
  serialize,
  serializeMany
} = require('../utils/helpers');

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const PURCHASE_ORDER_STATUSES = [
  'ordered',
  'received',
  'cancelled'
];

/* -------------------------------------------------------------------------- */
/* General Helpers                                                            */
/* -------------------------------------------------------------------------- */

const logError = (context, error) => {
  console.error(`[PurchasingController] ${context}`, {
    message: error?.message,
    name: error?.name
  });
};

const cleanString = (value) => {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
};

const nullableString = (value) => {
  const result = cleanString(value);
  return result || null;
};

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
};

const roundMoney = (value) => {
  return Math.round((value + Number.EPSILON) * 100) / 100;
};

const isValidObjectId = (value) => {
  return /^[a-f\d]{24}$/i.test(String(value || ''));
};

const getUserId = (req) => {
  const id = req.user?.id || req.user?._id;

  return isValidObjectId(id) ? String(id) : null;
};

const parseBoolean = (value) => {
  if (typeof value === 'boolean') return value;

  if (value === 'true' || value === 1 || value === '1') {
    return true;
  }

  if (value === 'false' || value === 0 || value === '0') {
    return false;
  }

  throw new Error('Invalid boolean value.');
};

const escapeRegex = (value) => {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const getPagination = (query = {}) => {
  const parsed = parsePagination(query);

  const page = Math.max(1, Number(parsed.page) || 1);
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number(parsed.limit) || DEFAULT_PAGE_SIZE)
  );

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
  pages: Math.max(1, Math.ceil(total / limit))
});

const validateSupplierId = (id) => {
  return isValidObjectId(id);
};

/* -------------------------------------------------------------------------- */
/* Supplier Helpers                                                           */
/* -------------------------------------------------------------------------- */

const validateSupplierData = (body, existing = null) => {
  const data = {};

  const name = body.name !== undefined
    ? cleanString(body.name)
    : existing?.name;

  if (!name) {
    throw new Error('Supplier name is required.');
  }

  if (name.length > 150) {
    throw new Error('Supplier name cannot exceed 150 characters.');
  }

  data.name = name;

  const fields = [
    'contact_person',
    'phone',
    'email',
    'address',
    'notes'
  ];

  for (const field of fields) {
    if (body[field] !== undefined) {
      data[field] = nullableString(body[field]);
    } else if (existing) {
      data[field] = existing[field];
    } else {
      data[field] = null;
    }
  }

  if (data.email) {
    data.email = data.email.toLowerCase();

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailPattern.test(data.email)) {
      throw new Error('Enter a valid supplier email address.');
    }
  }

  if (body.is_active !== undefined) {
    data.is_active = parseBoolean(body.is_active);
  } else {
    data.is_active = existing
      ? existing.is_active
      : true;
  }

  return data;
};

/* -------------------------------------------------------------------------- */
/* Purchase Order Helpers                                                     */
/* -------------------------------------------------------------------------- */

const validatePurchaseOrderItems = async (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('At least one purchase order item is required.');
  }

  if (items.length > 500) {
    throw new Error('A purchase order cannot contain more than 500 items.');
  }

  const normalizedItems = [];
  const productIds = new Set();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (!item || typeof item !== 'object') {
      throw new Error(`Invalid purchase order item at row ${index + 1}.`);
    }

    if (!isValidObjectId(item.product_id)) {
      throw new Error(`Invalid product ID at row ${index + 1}.`);
    }

    const quantity = toNumber(item.quantity);
    const unitCost = toNumber(item.unit_cost_kes);

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(
        `Quantity at row ${index + 1} must be a positive whole number.`
      );
    }

    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw new Error(
        `Unit cost at row ${index + 1} must be a valid non-negative amount.`
      );
    }

    const productId = String(item.product_id);

    if (productIds.has(productId)) {
      throw new Error(
        `Duplicate product at row ${index + 1}. Combine duplicate product lines.`
      );
    }

    productIds.add(productId);

    normalizedItems.push({
      product_id: productId,
      quantity,
      unit_cost_kes: roundMoney(unitCost),
      received_qty: 0
    });
  }

  const products = await Product.find({
    _id: {
      $in: [...productIds]
    }
  })
    .select('_id name is_active')
    .lean();

  const productMap = new Map(
    products.map((product) => [
      String(product._id),
      product
    ])
  );

  for (const item of normalizedItems) {
    const product = productMap.get(item.product_id);

    if (!product) {
      throw new Error(
        `Product ${item.product_id} does not exist.`
      );
    }

    if (product.is_active === false) {
      throw new Error(
        `Product "${product.name}" is inactive and cannot be ordered.`
      );
    }
  }

  return normalizedItems;
};

const calculatePurchaseOrderTotal = (items) => {
  return roundMoney(
    items.reduce(
      (total, item) =>
        total + item.quantity * item.unit_cost_kes,
      0
    )
  );
};

const populatePurchaseOrder = async (id) => {
  return PurchaseOrder.findById(id)
    .populate('supplier_id', 'name contact_person phone email')
    .populate('ordered_by', 'full_name email')
    .lean();
};

/* -------------------------------------------------------------------------- */
/* List Suppliers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/purchasing/suppliers
 */
exports.listSuppliers = async (req, res) => {
  try {
    const filter = {
      is_active: true
    };

    if (req.query.search) {
      const search = escapeRegex(cleanString(req.query.search));

      if (search) {
        filter.$or = [
          { name: { $regex: search, $options: 'i' } },
          { contact_person: { $regex: search, $options: 'i' } },
          { phone: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ];
      }
    }

    const suppliers = await Supplier.find(filter)
      .sort({
        name: 1,
        _id: 1
      })
      .lean();

    return res.json({
      suppliers: serializeMany(suppliers)
    });
  } catch (error) {
    logError('Failed to list suppliers', error);

    return res.status(500).json({
      error: 'Failed to list suppliers.'
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Create Supplier                                                            */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/purchasing/suppliers
 */
exports.createSupplier = async (req, res) => {
  try {
    const supplierData = validateSupplierData(req.body || {});

    const supplier = await Supplier.create(supplierData);

    return res.status(201).json({
      message: 'Supplier created successfully.',
      supplier: serialize(supplier)
    });
  } catch (error) {
    logError('Failed to create supplier', error);

    if (
      error.message?.includes('required') ||
      error.message?.includes('valid') ||
      error.message?.includes('exceed')
    ) {
      return res.status(400).json({
        error: error.message
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        error: 'A supplier with these details already exists.'
      });
    }

    return res.status(500).json({
      error: 'Failed to create supplier.'
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Update Supplier                                                            */
/* -------------------------------------------------------------------------- */

/**
 * PUT /api/purchasing/suppliers/:id
 */
exports.updateSupplier = async (req, res) => {
  try {
    const { id } = req.params;

    if (!validateSupplierId(id)) {
      return res.status(400).json({
        error: 'Invalid supplier ID.'
      });
    }

    const supplier = await Supplier.findById(id);

    if (!supplier) {
      return res.status(404).json({
        error: 'Supplier not found.'
      });
    }

    const supplierData = validateSupplierData(
      req.body || {},
      supplier
    );

    Object.assign(supplier, supplierData);

    await supplier.save();

    return res.json({
      message: 'Supplier updated successfully.',
      supplier: serialize(supplier)
    });
  } catch (error) {
    logError('Failed to update supplier', error);

    if (
      error.message?.includes('required') ||
      error.message?.includes('valid') ||
      error.message?.includes('exceed')
    ) {
      return res.status(400).json({
        error: error.message
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        error: 'A supplier with these details already exists.'
      });
    }

    return res.status(500).json({
      error: 'Failed to update supplier.'
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Create Purchase Order                                                      */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/purchasing/orders
 */
exports.createPurchaseOrder = async (req, res) => {
  try {
    const { supplier_id, items, notes } = req.body || {};

    if (!validateSupplierId(supplier_id)) {
      return res.status(400).json({
        error: 'A valid supplier_id is required.'
      });
    }

    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        error: 'Authentication is required to create a purchase order.'
      });
    }

    const supplier = await Supplier.findById(supplier_id)
      .select('_id name is_active')
      .lean();

    if (!supplier) {
      return res.status(404).json({
        error: 'Supplier not found.'
      });
    }

    if (supplier.is_active === false) {
      return res.status(400).json({
        error: 'Cannot create a purchase order for an inactive supplier.'
      });
    }

    const normalizedItems = await validatePurchaseOrderItems(items);

    const total = calculatePurchaseOrderTotal(normalizedItems);

    const po = await PurchaseOrder.create({
      supplier_id: supplier._id,
      po_number: generatePoNumber(),
      status: 'ordered',
      total_kes: total,
      notes: nullableString(notes),
      ordered_by: userId,
      ordered_at: new Date(),
      items: normalizedItems
    });

    const populated = await populatePurchaseOrder(po._id);

    return res.status(201).json({
      message: 'Purchase order created successfully.',
      purchase_order: serialize(populated)
    });
  } catch (error) {
    logError('Failed to create purchase order', error);

    if (
      error.message?.includes('required') ||
      error.message?.includes('valid') ||
      error.message?.includes('positive') ||
      error.message?.includes('Duplicate') ||
      error.message?.includes('more than') ||
      error.message?.includes('does not exist') ||
      error.message?.includes('inactive') ||
      error.message?.includes('non-negative')
    ) {
      return res.status(400).json({
        error: error.message
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        error: 'Purchase order number already exists. Please try again.'
      });
    }

    return res.status(500).json({
      error: 'Failed to create purchase order.'
    });
  }
};

/* -------------------------------------------------------------------------- */
/* List Purchase Orders                                                       */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/purchasing/orders?page=1&limit=20&status=ordered
 */
exports.listPurchaseOrders = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);

    const filter = {};

    if (req.query.status) {
      const status = cleanString(req.query.status).toLowerCase();

      if (!PURCHASE_ORDER_STATUSES.includes(status)) {
        return res.status(400).json({
          error: 'Invalid purchase order status.'
        });
      }

      filter.status = status;
    }

    if (req.query.supplier_id) {
      if (!validateSupplierId(req.query.supplier_id)) {
        return res.status(400).json({
          error: 'Invalid supplier ID.'
        });
      }

      filter.supplier_id = req.query.supplier_id;
    }

    if (req.query.search) {
      const search = escapeRegex(cleanString(req.query.search));

      if (search) {
        filter.po_number = {
          $regex: search,
          $options: 'i'
        };
      }
    }

    const [total, purchaseOrders] = await Promise.all([
      PurchaseOrder.countDocuments(filter),

      PurchaseOrder.find(filter)
        .populate('supplier_id', 'name contact_person phone')
        .populate('ordered_by', 'full_name email')
        .sort({
          created_at: -1,
          _id: -1
        })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    return res.json({
      purchase_orders: serializeMany(purchaseOrders),
      pagination: paginationResponse(page, limit, total)
    });
  } catch (error) {
    logError('Failed to list purchase orders', error);

    return res.status(500).json({
      error: 'Failed to list purchase orders.'
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Receive Purchase Order                                                     */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/purchasing/orders/:id/receive
 *
 * Receives all items in a purchase order.
 *
 * IMPORTANT:
 * This implementation uses a MongoDB transaction. MongoDB must run as a
 * replica set or supported sharded cluster for transactions to work.
 */
exports.receivePurchaseOrder = async (req, res) => {
  const userId = getUserId(req);

  if (!userId) {
    return res.status(401).json({
      error: 'Authentication is required to receive stock.'
    });
  }

  const { id } = req.params;

  if (!validateSupplierId(id)) {
    return res.status(400).json({
      error: 'Invalid purchase order ID.'
    });
  }

  const session = await mongoose.startSession();

  try {
    let receivedOrderId = null;

    await session.withTransaction(async () => {
      const po = await PurchaseOrder.findById(id)
        .session(session);

      if (!po) {
        const error = new Error('Purchase order not found.');
        error.statusCode = 404;
        throw error;
      }

      if (po.status === 'received') {
        const error = new Error('Purchase order has already been received.');
        error.statusCode = 400;
        throw error;
      }

      if (po.status === 'cancelled') {
        const error = new Error('Cancelled purchase orders cannot be received.');
        error.statusCode = 400;
        throw error;
      }

      if (!Array.isArray(po.items) || po.items.length === 0) {
        const error = new Error('Purchase order has no items to receive.');
        error.statusCode = 400;
        throw error;
      }

      const productIds = po.items.map((item) =>
        String(item.product_id)
      );

      const uniqueProductIds = [...new Set(productIds)];

      const products = await Product.find({
        _id: {
          $in: uniqueProductIds
        }
      }).session(session);

      const productMap = new Map(
        products.map((product) => [
          String(product._id),
          product
        ])
      );

      /*
       * Validate every product before making any stock changes.
       */
      for (const item of po.items) {
        const product = productMap.get(String(item.product_id));

        if (!product) {
          const error = new Error(
            `Product ${item.product_id} no longer exists. No stock was received.`
          );

          error.statusCode = 400;
          throw error;
        }

        const quantity = toNumber(item.quantity);
        const unitCost = toNumber(item.unit_cost_kes);

        if (
          !Number.isInteger(quantity) ||
          quantity <= 0 ||
          !Number.isFinite(unitCost) ||
          unitCost < 0
        ) {
          const error = new Error(
            'Purchase order contains invalid item quantities or costs.'
          );

          error.statusCode = 400;
          throw error;
        }

        const alreadyReceived = toNumber(item.received_qty);

        if (alreadyReceived > 0) {
          const error = new Error(
            'This purchase order contains previously received quantities. Partial receiving is not supported by this operation.'
          );

          error.statusCode = 400;
          throw error;
        }
      }

      /*
       * Update each product and create its stock ledger entry.
       * All changes are committed together or rolled back together.
       */
      for (const item of po.items) {
        const product = productMap.get(String(item.product_id));

        const quantity = Number(item.quantity);
        const unitCost = Number(item.unit_cost_kes);

        const oldBalance = toNumber(product.stock_qty);
        const newBalance = oldBalance + quantity;

        product.stock_qty = newBalance;
        product.cost_kes = unitCost;

        await product.save({
          session
        });

        await StockLedger.create(
          [
            {
              product_id: product._id,
              change_qty: quantity,
              balance_after: newBalance,
              reason: 'purchase',
              reference_type: 'purchase_order',
              reference_id: String(po._id),
              user_id: userId,
              notes: po.po_number
            }
          ],
          {
            session
          }
        );

        item.received_qty = quantity;
      }

      po.status = 'received';
      po.received_at = new Date();

      await po.save({
        session
      });

      receivedOrderId = po._id;
    });

    const populated = await populatePurchaseOrder(receivedOrderId);

    return res.json({
      message: 'Purchase order received successfully. Stock has been updated.',
      purchase_order: serialize(populated)
    });
  } catch (error) {
    logError('Failed to receive purchase order', error);

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        error: error.message
      });
    }

    /*
     * Transactions require a replica set or supported sharded cluster.
     * Do not silently fall back to non-transactional stock updates.
     */
    if (
      error.code === 20 ||
      error.codeName === 'IllegalOperation' ||
      /transaction numbers are only allowed|replica set|mongos/i.test(
        error.message || ''
      )
    ) {
      return res.status(503).json({
        error: 'Stock receiving requires MongoDB transactions. Configure MongoDB as a replica set or supported sharded cluster.'
      });
    }

    return res.status(500).json({
      error: 'Failed to receive purchase order. No partial stock update should be committed.'
    });
  } finally {
    await session.endSession();
  }
};

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

exports.validatePurchaseOrderItems = validatePurchaseOrderItems;
exports.calculatePurchaseOrderTotal = calculatePurchaseOrderTotal;
exports.getPagination = getPagination;