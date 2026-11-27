
'use strict';

const fs = require('fs/promises');
const path = require('path');
const mongoose = require('mongoose');

const {
  Product,
  Category,
  StockLedger,
  Order,
  OrderItem
} = require('../models');

const {
  slugify,
  parsePagination,
  serialize,
  serializeMany,
  enrichProductPricing
} = require('../utils/helpers');

const {
  cloudinaryConfigured,
  getCloudinary
} = require('../middleware/upload');

const DEFAULT_ADMIN_LIMIT = 50;
const MAX_ADMIN_LIMIT = 1000;
const MAX_PUBLIC_LIMIT = 100;
const MAX_LEDGER_LIMIT = 100;
const DEFAULT_LOW_STOCK_THRESHOLD = 5;

const SORT_OPTIONS = {
  name: { name: 1 },
  price_asc: { price_kes: 1, name: 1 },
  price_desc: { price_kes: -1, name: 1 },
  newest: { created_at: -1, _id: -1 }
};

const logError = (context, error) => {
  console.error(`[ProductController] ${context}`, {
    message: error?.message,
    name: error?.name
  });
};

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isObjectId = (value) =>
  mongoose.Types.ObjectId.isValid(String(value || '')) &&
  String(new mongoose.Types.ObjectId(String(value))) === String(value);

const toBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;

  return fallback;
};

const toNumber = (value, fieldName, options = {}) => {
  const {
    required = false,
    min = 0,
    integer = false
  } = options;

  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new Error(`${fieldName} is required`);
    }

    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error(`${fieldName} must be a valid number`);
  }

  if (number < min) {
    throw new Error(`${fieldName} cannot be less than ${min}`);
  }

  if (integer && !Number.isInteger(number)) {
    throw new Error(`${fieldName} must be a whole number`);
  }

  return number;
};

const cleanString = (value, fallback = null) => {
  if (value === undefined || value === null) return fallback;

  const result = String(value).trim();
  return result || fallback;
};

const getActorId = (req) => {
  const id = req.user?.id || req.user?._id;
  return isObjectId(id) ? id : null;
};

const validateProductId = (req, res) => {
  if (!isObjectId(req.params.id)) {
    res.status(400).json({ error: 'Invalid product ID' });
    return false;
  }

  return true;
};

const validateCategoryId = (value) =>
  !value || isObjectId(value);

const parseAdminPagination = (query = {}) => {
  const pageValue = Number.parseInt(query.page, 10);
  const limitValue = Number.parseInt(query.limit, 10);

  const page = Number.isInteger(pageValue) && pageValue > 0
    ? pageValue
    : 1;

  const limit = Number.isInteger(limitValue) && limitValue > 0
    ? Math.min(limitValue, MAX_ADMIN_LIMIT)
    : DEFAULT_ADMIN_LIMIT;

  return {
    page,
    limit,
    skip: (page - 1) * limit
  };
};

const getPublicPagination = (query = {}) => {
  const pagination = parsePagination(query);

  const page = Math.max(1, Number(pagination.page) || 1);
  const limit = Math.min(
    MAX_PUBLIC_LIMIT,
    Math.max(1, Number(pagination.limit) || 20)
  );

  return {
    page,
    limit,
    skip: (page - 1) * limit
  };
};

const buildPagination = (page, limit, total) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit) || 1,
  has_next: page * limit < total,
  has_previous: page > 1
});

const buildSearchRegex = (value) => {
  const query = cleanString(value, '');

  return query ? new RegExp(escapeRegex(query), 'i') : null;
};

const buildSaleFields = (source = {}) => {
  const fields = {};

  if (source.discount_percent !== undefined) {
    fields.discount_percent = toNumber(
      source.discount_percent,
      'Discount percentage',
      { min: 0 }
    );

    if (fields.discount_percent > 100) {
      throw new Error('Discount percentage cannot exceed 100');
    }
  }

  if (source.discount_price_kes !== undefined) {
    fields.discount_price_kes = toNumber(
      source.discount_price_kes,
      'Discount price',
      { min: 0 }
    );
  }

  if (source.sale_label !== undefined) {
    fields.sale_label = cleanString(source.sale_label);
  }

  if (source.sale_ends_at !== undefined) {
    if (!source.sale_ends_at) {
      fields.sale_ends_at = null;
    } else {
      const date = new Date(source.sale_ends_at);

      if (Number.isNaN(date.getTime())) {
        throw new Error('Invalid sale end date');
      }

      fields.sale_ends_at = date;
    }
  }

  return fields;
};

const getImageUrl = (req) => {
  if (req.imageUrl) return req.imageUrl;

  if (req.file?.filename) {
    return `/uploads/${path.basename(req.file.filename)}`;
  }

  return null;
};

const getImagePublicId = (req) =>
  cleanString(req.cloudinaryPublicId, null);

const getCategoryId = async (value) => {
  if (!value) return null;

  if (!isObjectId(value)) {
    throw new Error('Invalid category ID');
  }

  const category = await Category.findById(value)
    .select('_id')
    .lean();

  if (!category) {
    throw new Error('Category not found');
  }

  return category._id;
};

const generateUniqueSlug = async (name, excludeId = null) => {
  const baseSlug = slugify(name) || `product-${Date.now()}`;

  let slug = baseSlug;
  let counter = 1;

  while (true) {
    const filter = { slug };

    if (excludeId) {
      filter._id = { $ne: excludeId };
    }

    const existing = await Product.exists(filter);

    if (!existing) return slug;

    slug = `${baseSlug}-${counter}`;
    counter += 1;
  }
};

const withCategory = async (product) => {
  if (!product) return null;

  const output = serialize(product);
  const categoryValue = product.category_id;

  if (categoryValue) {
    let category = null;

    if (
      typeof categoryValue === 'object' &&
      categoryValue.name
    ) {
      category = categoryValue;
    } else {
      category = await Category.findById(categoryValue)
        .select('name slug')
        .lean();
    }

    if (category) {
      output.category_name = category.name;
      output.category_slug = category.slug;
      output.category_id = String(category._id || category.id);
    } else {
      output.category_name = null;
      output.category_slug = null;
    }
  } else {
    output.category_name = null;
    output.category_slug = null;
  }

  return enrichProductPricing(output, product);
};

const withCategoryList = async (products) => {
  const list = await Promise.all(
    products.map((product) => withCategory(product))
  );

  return list;
};

const deleteImage = async (image = {}) => {
  const publicId = image.image_public_id;
  const imageUrl = image.image_url || '';

  if (publicId && cloudinaryConfigured()) {
    try {
      const cloudinary = getCloudinary();

      await cloudinary.uploader.destroy(publicId, {
        resource_type: 'image',
        invalidate: true
      });
    } catch (error) {
      logError('Cloudinary image deletion failed', error);
    }

    return;
  }

  if (!imageUrl.startsWith('/uploads/')) return;

  const filename = path.basename(imageUrl);
  const uploadDirectory = path.resolve(__dirname, '..', 'uploads');
  const filePath = path.resolve(uploadDirectory, filename);

  if (!filePath.startsWith(`${uploadDirectory}${path.sep}`)) {
    return;
  }

  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logError('Local image deletion failed', error);
    }
  }
};

const replaceImage = async (document, req) => {
  const newImageUrl = getImageUrl(req);

  if (!newImageUrl) return null;

  const previousImage = {
    image_url: document.image_url,
    image_public_id: document.image_public_id
  };

  document.image_url = newImageUrl;
  document.image_public_id = getImagePublicId(req) || '';

  return previousImage;
};

const hasSalesHistory = async (productId) => {
  if (
    OrderItem &&
    await OrderItem.exists({ product_id: productId })
  ) {
    return true;
  }

  if (
    Order &&
    await Order.exists({ 'items.product_id': productId })
  ) {
    return true;
  }

  return false;
};

const createStockLedgerEntry = async ({
  productId,
  changeQty,
  balanceAfter,
  reason,
  referenceType = 'manual',
  userId = null,
  notes = null
}) => {
  return StockLedger.create({
    product_id: productId,
    change_qty: changeQty,
    balance_after: balanceAfter,
    reason,
    reference_type: referenceType,
    ...(userId ? { user_id: userId } : {}),
    notes
  });
};

const validatePriceFields = (body) => {
  const price = toNumber(body.price_kes, 'Selling price', {
    required: true,
    min: 0
  });

  const cost = body.cost_kes === undefined || body.cost_kes === ''
    ? 0
    : toNumber(body.cost_kes, 'Cost price', { min: 0 });

  return { price, cost };
};

exports.categories = async (req, res) => {
  try {
    const categories = await Category.find({
      is_active: true
    })
      .sort({ sort_order: 1, name: 1 })
      .lean();

    return res.json({
      categories: serializeMany(categories)
    });
  } catch (error) {
    logError('Failed to load public categories', error);

    return res.status(500).json({
      error: 'Failed to load categories'
    });
  }
};

exports.listCategoriesAdmin = async (req, res) => {
  try {
    const categories = await Category.find({})
      .sort({ sort_order: 1, name: 1 })
      .lean();

    return res.json({
      categories: serializeMany(categories)
    });
  } catch (error) {
    logError('Failed to load admin categories', error);

    return res.status(500).json({
      error: 'Failed to load categories'
    });
  }
};

exports.uploadCategoryImage = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({
        error: 'Invalid category ID'
      });
    }

    const imageUrl = getImageUrl(req);

    if (!req.file || !imageUrl) {
      return res.status(400).json({
        error: 'Please select a category image'
      });
    }

    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        error: 'Category not found'
      });
    }

    const previousImage = {
      image_url: category.image_url,
      image_public_id: category.image_public_id
    };

    category.image_url = imageUrl;
    category.image_public_id = getImagePublicId(req) || '';
    category.image_alt = cleanString(
      req.body?.image_alt,
      category.name
    );

    await category.save();

    await deleteImage(previousImage);

    return res.json({
      message: 'Category image uploaded successfully',
      category: serialize(category)
    });
  } catch (error) {
    logError('Category image upload failed', error);

    return res.status(500).json({
      error: 'Failed to upload category image'
    });
  }
};

exports.removeCategoryImage = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({
        error: 'Invalid category ID'
      });
    }

    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        error: 'Category not found'
      });
    }

    const previousImage = {
      image_url: category.image_url,
      image_public_id: category.image_public_id
    };

    category.image_url = '';
    category.image_public_id = '';
    category.image_alt = '';

    await category.save();

    await deleteImage(previousImage);

    return res.json({
      message: 'Category image removed successfully',
      category: serialize(category)
    });
  } catch (error) {
    logError('Category image removal failed', error);

    return res.status(500).json({
      error: 'Failed to remove category image'
    });
  }
};

exports.listPublic = async (req, res) => {
  try {
    const { page, limit, skip } = getPublicPagination(req.query);
    const filter = {
      is_active: true
    };

    const categoryQuery = cleanString(req.query.category);
    const searchQuery = cleanString(req.query.q);
    const sort = cleanString(req.query.sort, 'name');

    if (categoryQuery) {
      const categoryFilter = {
        $or: [{ slug: categoryQuery }]
      };

      if (isObjectId(categoryQuery)) {
        categoryFilter.$or.push({ _id: categoryQuery });
      }

      const category = await Category.findOne(categoryFilter)
        .select('_id')
        .lean();

      filter.category_id = category ? category._id : null;
    }

    const regex = buildSearchRegex(searchQuery);

    if (regex) {
      filter.$or = [
        { name: regex },
        { description: regex },
        { sku: regex },
        { barcode: regex }
      ];
    }

    const sortOption = SORT_OPTIONS[sort] || SORT_OPTIONS.name;

    const [products, total] = await Promise.all([
      Product.find(filter)
        .populate('category_id', 'name slug')
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        .lean(),

      Product.countDocuments(filter)
    ]);

    return res.json({
      products: await withCategoryList(products),
      pagination: buildPagination(page, limit, total)
    });
  } catch (error) {
    logError('Public product listing failed', error);

    return res.status(500).json({
      error: 'Failed to list products'
    });
  }
};

exports.getBySlug = async (req, res) => {
  try {
    const slug = cleanString(req.params.slug);

    if (!slug) {
      return res.status(400).json({
        error: 'Product slug is required'
      });
    }

    const product = await Product.findOne({
      slug,
      is_active: true
    })
      .populate('category_id', 'name slug')
      .lean();

    if (!product) {
      return res.status(404).json({
        error: 'Product not found'
      });
    }

    return res.json({
      product: await withCategory(product)
    });
  } catch (error) {
    logError('Failed to load product by slug', error);

    return res.status(500).json({
      error: 'Failed to load product'
    });
  }
};

exports.listAdmin = async (req, res) => {
  try {
    const { page, limit, skip } = parseAdminPagination(req.query);
    const filter = {};

    const regex = buildSearchRegex(req.query.q);

    if (regex) {
      filter.$or = [
        { name: regex },
        { sku: regex },
        { barcode: regex }
      ];
    }

    if (req.query.low_stock === '1') {
      filter.$expr = {
        $lte: ['$stock_qty', '$low_stock_threshold']
      };
    }

    if (req.query.is_active !== undefined) {
      filter.is_active = toBoolean(req.query.is_active);
    }

    if (req.query.category_id) {
      if (!isObjectId(req.query.category_id)) {
        return res.status(400).json({
          error: 'Invalid category ID'
        });
      }

      filter.category_id = req.query.category_id;
    }

    const [products, total] = await Promise.all([
      Product.find(filter)
        .populate('category_id', 'name slug')
        .sort({ updated_at: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      Product.countDocuments(filter)
    ]);

    return res.json({
      products: await withCategoryList(products),
      pagination: buildPagination(page, limit, total)
    });
  } catch (error) {
    logError('Admin product listing failed', error);

    return res.status(500).json({
      error: 'Failed to list products'
    });
  }
};

exports.create = async (req, res) => {
  let createdProduct = null;

  try {
    const body = req.body || {};
    const name = cleanString(body.name);

    if (!name) {
      return res.status(400).json({
        error: 'Product name is required'
      });
    }

    const { price, cost } = validatePriceFields(body);

    const quantity = body.stock_qty === undefined || body.stock_qty === ''
      ? 0
      : toNumber(body.stock_qty, 'Stock quantity', {
          min: 0,
          integer: true
        });

    const threshold = body.low_stock_threshold === undefined ||
      body.low_stock_threshold === ''
      ? DEFAULT_LOW_STOCK_THRESHOLD
      : toNumber(body.low_stock_threshold, 'Low stock threshold', {
          min: 0,
          integer: true
        });

    const sku = cleanString(body.sku);
    const barcode = cleanString(body.barcode);

    const duplicateChecks = [];

    if (sku) duplicateChecks.push(Product.exists({ sku }));
    if (barcode) duplicateChecks.push(Product.exists({ barcode }));

    const duplicateResults = await Promise.all(duplicateChecks);

    if (duplicateResults.some(Boolean)) {
      return res.status(409).json({
        error: 'SKU or barcode already exists'
      });
    }

    const categoryId = await getCategoryId(body.category_id);
    const slug = await generateUniqueSlug(name);

    const product = await Product.create({
      sku,
      barcode,
      name,
      slug,
      description: cleanString(body.description),
      category_id: categoryId,
      price_kes: price,
      cost_kes: cost,
      stock_qty: quantity,
      low_stock_threshold: threshold,
      image_url: getImageUrl(req),
      image_public_id: getImagePublicId(req) || '',
      is_active: toBoolean(body.is_active, true),
      discount_percent: 0,
      discount_price_kes: null,
      sale_label: null,
      sale_ends_at: null,
      ...buildSaleFields(body)
    });

    createdProduct = product;

    if (quantity > 0) {
      await createStockLedgerEntry({
        productId: product._id,
        changeQty: quantity,
        balanceAfter: quantity,
        reason: 'initial_stock',
        referenceType: 'manual',
        userId: getActorId(req),
        notes: 'Initial stock recorded during product creation'
      });
    }

    const populated = await Product.findById(product._id)
      .populate('category_id', 'name slug')
      .lean();

    return res.status(201).json({
      product: await withCategory(populated)
    });
  } catch (error) {
    logError('Product creation failed', error);

    if (createdProduct) {
      try {
        await Product.deleteOne({ _id: createdProduct._id });
        await StockLedger.deleteMany({
          product_id: createdProduct._id
        });
      } catch (cleanupError) {
        logError('Product creation cleanup failed', cleanupError);
      }
    }

    if (error.code === 11000) {
      return res.status(409).json({
        error: 'A product with this SKU, barcode or slug already exists'
      });
    }

    if (
      error.message?.includes('required') ||
      error.message?.includes('cannot') ||
      error.message?.includes('Invalid') ||
      error.message?.includes('must be') ||
      error.message?.includes('Category')
    ) {
      return res.status(400).json({
        error: error.message
      });
    }

    return res.status(500).json({
      error: 'Failed to create product'
    });
  }
};

exports.update = async (req, res) => {
  try {
    if (!validateProductId(req, res)) return;

    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        error: 'Product not found'
      });
    }

    const body = req.body || {};

    if (body.stock_qty !== undefined) {
      return res.status(400).json({
        error: 'Use the stock adjustment endpoint to change stock quantity'
      });
    }

    if (body.name !== undefined) {
      const name = cleanString(body.name);

      if (!name) {
        return res.status(400).json({
          error: 'Product name cannot be empty'
        });
      }

      if (name !== product.name) {
        product.name = name;
        product.slug = await generateUniqueSlug(name, product._id);
      }
    }

    if (body.sku !== undefined) {
      const sku = cleanString(body.sku);

      if (
        sku &&
        await Product.exists({
          sku,
          _id: { $ne: product._id }
        })
      ) {
        return res.status(409).json({
          error: 'SKU already exists'
        });
      }

      product.sku = sku;
    }

    if (body.barcode !== undefined) {
      const barcode = cleanString(body.barcode);

      if (
        barcode &&
        await Product.exists({
          barcode,
          _id: { $ne: product._id }
        })
      ) {
        return res.status(409).json({
          error: 'Barcode already exists'
        });
      }

      product.barcode = barcode;
    }

    if (body.description !== undefined) {
      product.description = cleanString(body.description);
    }

    if (body.category_id !== undefined) {
      product.category_id = await getCategoryId(body.category_id);
    }

    if (body.price_kes !== undefined && body.price_kes !== '') {
      product.price_kes = toNumber(
        body.price_kes,
        'Selling price',
        { min: 0 }
      );
    }

    if (body.cost_kes !== undefined && body.cost_kes !== '') {
      product.cost_kes = toNumber(
        body.cost_kes,
        'Cost price',
        { min: 0 }
      );
    }

    if (
      body.low_stock_threshold !== undefined &&
      body.low_stock_threshold !== ''
    ) {
      product.low_stock_threshold = toNumber(
        body.low_stock_threshold,
        'Low stock threshold',
        { min: 0, integer: true }
      );
    }

    if (body.is_active !== undefined) {
      product.is_active = toBoolean(
        body.is_active,
        product.is_active
      );
    }

    const previousImage = await replaceImage(product, req);

    Object.assign(product, buildSaleFields(body));

    await product.save();

    if (previousImage) {
      await deleteImage(previousImage);
    }

    const populated = await Product.findById(product._id)
      .populate('category_id', 'name slug')
      .lean();

    return res.json({
      product: await withCategory(populated)
    });
  } catch (error) {
    logError('Product update failed', error);

    if (error.code === 11000) {
      return res.status(409).json({
        error: 'SKU, barcode or slug already exists'
      });
    }

    if (
      error.message?.includes('required') ||
      error.message?.includes('cannot') ||
      error.message?.includes('Invalid') ||
      error.message?.includes('must be') ||
      error.message?.includes('Category')
    ) {
      return res.status(400).json({
        error: error.message
      });
    }

    return res.status(500).json({
      error: 'Failed to update product'
    });
  }
};

exports.remove = async (req, res) => {
  try {
    if (!validateProductId(req, res)) return;

    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        error: 'Product not found'
      });
    }

    if (await hasSalesHistory(product._id)) {
      product.is_active = false;
      await product.save();

      return res.json({
        archived: true,
        message: 'Product archived because it has sales history'
      });
    }

    const image = {
      image_url: product.image_url,
      image_public_id: product.image_public_id
    };

    await StockLedger.deleteMany({
      product_id: product._id
    });

    await product.deleteOne();

    await deleteImage(image);

    return res.json({
      deleted: true,
      message: 'Product deleted successfully'
    });
  } catch (error) {
    logError('Product deletion failed', error);

    return res.status(500).json({
      error: 'Failed to delete product'
    });
  }
};

exports.adjustStock = async (req, res) => {
  try {
    if (!validateProductId(req, res)) return;

    const body = req.body || {};

    if (
      body.change_qty === undefined ||
      body.change_qty === '' ||
      !cleanString(body.reason)
    ) {
      return res.status(400).json({
        error: 'change_qty and reason are required'
      });
    }

    const delta = toNumber(
      body.change_qty,
      'Stock adjustment',
      { integer: true }
    );

    if (delta === 0) {
      return res.status(400).json({
        error: 'Stock adjustment must be a non-zero whole number'
      });
    }

    const reason = cleanString(body.reason);
    const notes = cleanString(body.notes);
    const productId = req.params.id;

    const stockFilter = {
      _id: productId
    };

    if (delta < 0) {
      stockFilter.stock_qty = {
        $gte: Math.abs(delta)
      };
    }

    const product = await Product.findOneAndUpdate(
      stockFilter,
      {
        $inc: {
          stock_qty: delta
        }
      },
      {
        new: true,
        runValidators: true
      }
    );

    if (!product) {
      const exists = await Product.exists({ _id: productId });

      if (!exists) {
        return res.status(404).json({
          error: 'Product not found'
        });
      }

      return res.status(400).json({
        error: 'Insufficient stock for this adjustment'
      });
    }

    try {
      await createStockLedgerEntry({
        productId: product._id,
        changeQty: delta,
        balanceAfter: product.stock_qty,
        reason,
        referenceType: 'manual',
        userId: getActorId(req),
        notes
      });
    } catch (ledgerError) {

      await Product.updateOne(
        {
          _id: product._id,
          stock_qty: product.stock_qty
        },
        {
          $inc: {
            stock_qty: -delta
          }
        }
      );

      throw ledgerError;
    }

    return res.json({
      message: 'Stock adjusted successfully',
      product: serialize(product),
      stock: {
        change_qty: delta,
        balance_after: product.stock_qty
      }
    });
  } catch (error) {
    logError('Stock adjustment failed', error);

    if (
      error.message?.includes('must be') ||
      error.message?.includes('required')
    ) {
      return res.status(400).json({
        error: error.message
      });
    }

    return res.status(500).json({
      error: 'Stock adjustment failed'
    });
  }
};

exports.stockLedger = async (req, res) => {
  try {
    if (!validateProductId(req, res)) return;

    const exists = await Product.exists({
      _id: req.params.id
    });

    if (!exists) {
      return res.status(404).json({
        error: 'Product not found'
      });
    }

    const limitValue = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(limitValue) && limitValue > 0
      ? Math.min(limitValue, MAX_LEDGER_LIMIT)
      : MAX_LEDGER_LIMIT;

    const rows = await StockLedger.find({
      product_id: req.params.id
    })
      .sort({ created_at: -1, _id: -1 })
      .limit(limit)
      .populate('user_id', 'full_name')
      .lean();

    const ledger = rows.map((row) => {
      const output = serialize(row);

      output.user_name = row.user_id?.full_name || null;

      return output;
    });

    return res.json({
      ledger,
      count: ledger.length
    });
  } catch (error) {
    logError('Failed to load stock ledger', error);

    return res.status(500).json({
      error: 'Failed to load ledger'
    });
  }
};

exports.bulkImport = async (req, res) => {
  try {
    const items = req.body?.products || req.body?.items;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: 'A non-empty products array is required'
      });
    }

    if (items.length > 1000) {
      return res.status(400).json({
        error: 'Maximum import size is 1000 products per request'
      });
    }

    let created = 0;
    let skipped = 0;

    const errors = [];
    const actorId = getActorId(req);

    for (let index = 0; index < items.length; index += 1) {
      const row = items[index] || {};
      let product = null;

      try {
        const name = cleanString(row.name);

        if (!name) {
          skipped += 1;
          errors.push({
            row: index + 1,
            product: 'Unnamed',
            error: 'Product name is required'
          });
          continue;
        }

        const { price, cost } = validatePriceFields(row);

        const quantity = row.stock_qty === undefined ||
          row.stock_qty === ''
          ? 0
          : toNumber(row.stock_qty, 'Stock quantity', {
              min: 0,
              integer: true
            });

        const threshold = row.low_stock_threshold === undefined ||
          row.low_stock_threshold === ''
          ? DEFAULT_LOW_STOCK_THRESHOLD
          : toNumber(row.low_stock_threshold, 'Low stock threshold', {
              min: 0,
              integer: true
            });

        const sku = cleanString(row.sku);
        const barcode = cleanString(row.barcode);

        const duplicateFilters = [];

        if (sku) duplicateFilters.push({ sku });
        if (barcode) duplicateFilters.push({ barcode });

        if (
          duplicateFilters.length &&
          await Product.exists({ $or: duplicateFilters })
        ) {
          skipped += 1;
          errors.push({
            row: index + 1,
            product: name,
            error: 'SKU or barcode already exists'
          });
          continue;
        }

        let categoryId = null;

        if (row.category_id) {
          categoryId = await getCategoryId(row.category_id);
        } else if (row.category_slug) {
          const category = await Category.findOne({
            slug: cleanString(row.category_slug)
          })
            .select('_id')
            .lean();

          categoryId = category?._id || null;
        }

        const slug = await generateUniqueSlug(name);

        product = await Product.create({
          sku,
          barcode,
          name,
          slug,
          description: cleanString(row.description),
          category_id: categoryId,
          price_kes: price,
          cost_kes: cost,
          stock_qty: quantity,
          low_stock_threshold: threshold,
          is_active: toBoolean(row.is_active, true),
          discount_percent: 0,
          discount_price_kes: null,
          sale_label: null,
          sale_ends_at: null,
          ...buildSaleFields(row)
        });

        if (quantity > 0) {
          await createStockLedgerEntry({
            productId: product._id,
            changeQty: quantity,
            balanceAfter: quantity,
            reason: 'initial_stock',
            referenceType: 'import',
            userId: actorId,
            notes: `Initial stock imported from row ${index + 1}`
          });
        }

        created += 1;
      } catch (error) {

        if (product?._id) {
          try {
            await Product.deleteOne({ _id: product._id });
            await StockLedger.deleteMany({
              product_id: product._id
            });
          } catch (cleanupError) {
            logError('Bulk import cleanup failed', cleanupError);
          }
        }

        skipped += 1;

        errors.push({
          row: index + 1,
          product: cleanString(row.name, 'Unnamed'),
          error: error.message || 'Import failed'
        });
      }
    }

    return res.json({
      message: 'Product import completed',
      total: items.length,
      created,
      skipped,
      failed: errors.length,
      errors
    });
  } catch (error) {
    logError('Bulk product import failed', error);

    return res.status(500).json({
      error: 'Import failed'
    });
  }
};