const { Product, Category, StockLedger, Order, OrderItem } = require('../models');
const { slugify, parsePagination, serialize, serializeMany, enrichProductPricing } = require('../utils/helpers');
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isObjectId = (v) => /^[a-f\d]{24}$/i.test(String(v || ''));
const toBool = (v) => v === true || v === 1 || v === '1' || v === 'true';
const toNumberOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const fs = require('fs');
const path = require('path');

const {
  cloudinaryConfigured,
  getCloudinary
} = require('../middleware/upload');

/** Admin lists need more rows than the public pagination helper allows. */
function parseAdminPagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(1000, Math.max(1, parseInt(query.limit, 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

/** Sale fields shared by create, update and import. Returns only fields that were sent. */
function pickSaleFields(src) {
  const out = {};
  if (src.discount_percent !== undefined) out.discount_percent = Number(src.discount_percent) || 0;
  if (src.discount_price_kes !== undefined) out.discount_price_kes = toNumberOrNull(src.discount_price_kes);
  if (src.sale_label !== undefined) out.sale_label = src.sale_label || null;
  if (src.sale_ends_at !== undefined) out.sale_ends_at = src.sale_ends_at || null;
  return out;
}

async function withCategory(product) {
  const o = serialize(product);
  if (product.category_id) {
    const cat =
      typeof product.category_id === 'object' && product.category_id.name
        ? product.category_id
        : await Category.findById(product.category_id);
    if (cat) {
      o.category_name = cat.name;
      o.category_slug = cat.slug;
      o.category_id = String(cat._id || cat.id);
    }
  }
  return enrichProductPricing(o, product);
}

async function withCategoryList(products) {
  const list = [];
  for (const p of products) list.push(await withCategory(p));
  return list;
}

/** True if any order line references this product. */
async function hasSalesHistory(productId) {
  if (OrderItem && (await OrderItem.exists({ product_id: productId }))) return true;
  if (Order && (await Order.exists({ 'items.product_id': productId }))) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Public                                                              */
/* ------------------------------------------------------------------ */

exports.categories = async (req, res) => {
  try {
    const categories = await Category.find({ is_active: true }).sort({ sort_order: 1, name: 1 });
    res.json({ categories: serializeMany(categories) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load categories' });
  }
};

// ======================================================
// CATEGORY IMAGE MANAGEMENT
// ======================================================

exports.listCategoriesAdmin = async (req, res) => {
  try {
    const categories = await Category.find({})
      .sort({ sort_order: 1, name: 1 });

    res.json({
      categories: serializeMany(categories)
    });
  } catch (err) {
    console.error('Admin categories error:', err);

    res.status(500).json({
      error: 'Failed to load categories'
    });
  }
};

async function deleteCategoryImage(category) {
  // Delete from Cloudinary when a Cloudinary public ID exists.
  if (category.image_public_id && cloudinaryConfigured()) {
    try {
      const cloudinary = getCloudinary();

      await cloudinary.uploader.destroy(
        category.image_public_id,
        { resource_type: 'image' }
      );
    } catch (err) {
      console.error('Cloudinary category image deletion failed:', err.message);
    }
  }

  // Delete local uploads safely when the image is stored locally.
  const imageUrl = category.image_url || '';

  if (imageUrl.startsWith('/uploads/')) {
    const filename = path.basename(imageUrl);
    const filepath = path.join(__dirname, '..', 'uploads', filename);

    if (fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
      } catch (err) {
        console.error('Local category image deletion failed:', err.message);
      }
    }
  }
}

exports.uploadCategoryImage = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid category ID' });
    }

    if (!req.file || !req.imageUrl) {
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

    // Preserve the old image until the new upload has succeeded.
    const oldImage = {
      image_url: category.image_url,
      image_public_id: category.image_public_id
    };

    category.image_url = req.imageUrl;
    category.image_public_id = req.cloudinaryPublicId || '';
    category.image_alt = String(req.body.image_alt || category.name).trim();

    await category.save();

    // Remove the previous image only after the database update succeeds.
    await deleteCategoryImage(oldImage);

    res.json({
      message: 'Category image uploaded successfully',
      category: serialize(category)
    });
  } catch (err) {
    console.error('Category image upload error:', err);

    res.status(500).json({
      error: 'Failed to upload category image'
    });
  }
};

exports.removeCategoryImage = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid category ID' });
    }

    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        error: 'Category not found'
      });
    }

    const oldImage = {
      image_url: category.image_url,
      image_public_id: category.image_public_id
    };

    category.image_url = '';
    category.image_public_id = '';
    category.image_alt = '';

    await category.save();

    await deleteCategoryImage(oldImage);

    res.json({
      message: 'Category image removed successfully',
      category: serialize(category)
    });
  } catch (err) {
    console.error('Category image removal error:', err);

    res.status(500).json({
      error: 'Failed to remove category image'
    });
  }
};

exports.listPublic = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const category = req.query.category;
    const q = (req.query.q || '').trim();
    const sort = req.query.sort || 'name';

    const filter = { is_active: true };

    if (category) {
      const cat = await Category.findOne({
        $or: [{ slug: category }, ...(isObjectId(category) ? [{ _id: category }] : [])]
      });
      filter.category_id = cat ? cat._id : null;
    }

    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ name: rx }, { description: rx }, { sku: rx }, { barcode: rx }];
    }

    let sortOpt = { name: 1 };
    if (sort === 'price_asc') sortOpt = { price_kes: 1 };
    else if (sort === 'price_desc') sortOpt = { price_kes: -1 };
    else if (sort === 'newest') sortOpt = { created_at: -1 };

    const total = await Product.countDocuments(filter);
    const products = await Product.find(filter)
      .populate('category_id', 'name slug')
      .sort(sortOpt)
      .skip(skip)
      .limit(limit);

    res.json({
      products: await withCategoryList(products),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list products' });
  }
};

exports.getBySlug = async (req, res) => {
  try {
    const product = await Product.findOne({ slug: req.params.slug, is_active: true })
      .populate('category_id', 'name slug');
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ product: await withCategory(product) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load product' });
  }
};

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

/** Lists every product, including inactive and archived ones. */
exports.listAdmin = async (req, res) => {
  try {
    const { page, limit, skip } = parseAdminPagination(req.query);
    const q = (req.query.q || '').trim();
    const filter = {};

    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ name: rx }, { sku: rx }, { barcode: rx }];
    }
    if (req.query.low_stock === '1') {
      filter.$expr = { $lte: ['$stock_qty', '$low_stock_threshold'] };
    }
    if (req.query.category_id && isObjectId(req.query.category_id)) {
      filter.category_id = req.query.category_id;
    }

    const total = await Product.countDocuments(filter);
    const products = await Product.find(filter)
      .populate('category_id', 'name slug')
      .sort({ updated_at: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      products: await withCategoryList(products),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list products' });
  }
};

exports.create = async (req, res) => {
  try {
    const b = req.body;
    if (!b.name || !String(b.name).trim() || b.price_kes == null || b.price_kes === '') {
      return res.status(400).json({ error: 'Name and selling price are required' });
    }
    if (Number(b.price_kes) < 0 || Number(b.cost_kes || 0) < 0 || Number(b.stock_qty || 0) < 0) {
      return res.status(400).json({ error: 'Prices and quantity cannot be negative' });
    }

    const sku = b.sku ? String(b.sku).trim() : null;
    const barcode = b.barcode ? String(b.barcode).trim() : null;
    if (sku && (await Product.findOne({ sku }))) {
      return res.status(409).json({ error: 'SKU already exists' });
    }
    if (barcode && (await Product.findOne({ barcode }))) {
      return res.status(409).json({ error: 'Barcode already exists' });
    }

    let slug = slugify(b.name);
    if (await Product.findOne({ slug })) slug = `${slug}-${Date.now().toString(36)}`;

    const image_url =
      req.imageUrl || (req.file && req.file.filename ? `/uploads/${req.file.filename}` : null);
    const qty = Math.floor(Number(b.stock_qty)) || 0;
    const threshold = b.low_stock_threshold === undefined || b.low_stock_threshold === ''
      ? 5
      : Number(b.low_stock_threshold) || 0;

    const product = await Product.create({
      sku,
      barcode,
      name: String(b.name).trim(),
      slug,
      description: b.description || null,
      category_id: b.category_id || null,
      price_kes: Number(b.price_kes),
      cost_kes: Number(b.cost_kes) || 0,
      stock_qty: qty,
      low_stock_threshold: threshold,
      image_url,
      is_active: b.is_active === undefined ? true : toBool(b.is_active),
      discount_percent: 0,
      discount_price_kes: null,
      sale_label: null,
      sale_ends_at: null,
      ...pickSaleFields(b)
    });

    if (qty > 0) {
      await StockLedger.create({
        product_id: product._id,
        change_qty: qty,
        balance_after: qty,
        reason: 'initial_stock',
        reference_type: 'manual',
        user_id: req.user.id,
        notes: 'Product created'
      });
    }

    const populated = await Product.findById(product._id).populate('category_id', 'name slug');
    res.status(201).json({ product: await withCategory(populated) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create product' });
  }
};

/** Updates details only. Quantity changes go through adjustStock so the ledger stays accurate. */
exports.update = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const b = req.body;

    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
      if (name !== product.name) {
        let slug = slugify(name);
        if (await Product.findOne({ slug, _id: { $ne: product._id } })) slug = `${slug}-${product._id}`;
        product.slug = slug;
        product.name = name;
      }
    }

    if (b.sku !== undefined) {
      const sku = String(b.sku).trim() || null;
      if (sku && (await Product.findOne({ sku, _id: { $ne: product._id } }))) {
        return res.status(409).json({ error: 'SKU already exists' });
      }
      product.sku = sku;
    }
    if (b.barcode !== undefined) {
      const barcode = String(b.barcode).trim() || null;
      if (barcode && (await Product.findOne({ barcode, _id: { $ne: product._id } }))) {
        return res.status(409).json({ error: 'Barcode already exists' });
      }
      product.barcode = barcode;
    }

    if (b.description !== undefined) product.description = b.description || null;
    if (b.category_id !== undefined) product.category_id = b.category_id || null;
    if (b.price_kes !== undefined && b.price_kes !== '') {
      if (Number(b.price_kes) < 0) return res.status(400).json({ error: 'Price cannot be negative' });
      product.price_kes = Number(b.price_kes);
    }
    if (b.cost_kes !== undefined && b.cost_kes !== '') {
      if (Number(b.cost_kes) < 0) return res.status(400).json({ error: 'Cost cannot be negative' });
      product.cost_kes = Number(b.cost_kes);
    }
    if (b.low_stock_threshold !== undefined && b.low_stock_threshold !== '') {
      product.low_stock_threshold = Number(b.low_stock_threshold) || 0;
    }
    if (b.is_active !== undefined) product.is_active = toBool(b.is_active);

    if (req.imageUrl) product.image_url = req.imageUrl;
    else if (req.file && req.file.filename) product.image_url = `/uploads/${req.file.filename}`;

    Object.assign(product, pickSaleFields(b));

    await product.save();
    const populated = await Product.findById(product._id).populate('category_id', 'name slug');
    res.json({ product: await withCategory(populated) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update product' });
  }
};

/** Products with sales history are archived (hidden); all others are deleted. */
exports.remove = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid product id' });

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    if (await hasSalesHistory(product._id)) {
      product.is_active = false;
      await product.save();
      return res.json({ archived: true });
    }

    await StockLedger.deleteMany({ product_id: product._id });
    await product.deleteOne();
    res.json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
};

exports.adjustStock = async (req, res) => {
  try {
    const { change_qty, reason, notes } = req.body;
    if (change_qty == null || change_qty === '' || !reason) {
      return res.status(400).json({ error: 'change_qty and reason are required' });
    }
    const delta = Math.trunc(Number(change_qty));
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ error: 'change_qty must be a non-zero whole number' });
    }

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const newBalance = product.stock_qty + delta;
    if (newBalance < 0) {
      return res.status(400).json({ error: 'Insufficient stock for this adjustment' });
    }

    product.stock_qty = newBalance;
    await product.save();
    await StockLedger.create({
      product_id: product._id,
      change_qty: delta,
      balance_after: newBalance,
      reason,
      reference_type: 'manual',
      user_id: req.user.id,
      notes: notes || null
    });

    res.json({ product: serialize(product) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Stock adjustment failed' });
  }
};

exports.stockLedger = async (req, res) => {
  try {
    const rows = await StockLedger.find({ product_id: req.params.id })
      .sort({ created_at: -1 })
      .limit(100)
      .populate('user_id', 'full_name');
    const ledger = rows.map((r) => {
      const o = serialize(r);
      o.user_name = r.user_id ? r.user_id.full_name : null;
      return o;
    });
    res.json({ ledger });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load ledger' });
  }
};

exports.bulkImport = async (req, res) => {
  try {
    const items = req.body.products || req.body.items || [];
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'products array required' });
    }

    let created = 0;
    let skipped = 0;
    const errors = [];

    for (const row of items) {
      try {
        if (!row.name || row.price_kes == null) { skipped++; continue; }
        if (row.sku && (await Product.findOne({ sku: row.sku }))) { skipped++; continue; }
        if (row.barcode && (await Product.findOne({ barcode: row.barcode }))) { skipped++; continue; }

        let categoryId = isObjectId(row.category_id) ? row.category_id : null;
        if (!categoryId && row.category_slug) {
          const cat = await Category.findOne({ slug: row.category_slug });
          if (cat) categoryId = cat._id;
        }

        let slug = slugify(row.name);
        if (await Product.findOne({ slug })) slug = `${slug}-${Date.now().toString(36)}`;
        const qty = Math.floor(Number(row.stock_qty)) || 0;

        const product = await Product.create({
          sku: row.sku || null,
          barcode: row.barcode || null,
          name: String(row.name).trim(),
          slug,
          description: row.description || null,
          category_id: categoryId,
          price_kes: Number(row.price_kes),
          cost_kes: Number(row.cost_kes) || 0,
          stock_qty: qty,
          low_stock_threshold: Number(row.low_stock_threshold) || 5,
          is_active: true,
          discount_percent: 0,
          discount_price_kes: null,
          sale_label: null,
          sale_ends_at: null,
          ...pickSaleFields(row)
        });

        if (qty > 0) {
          await StockLedger.create({
            product_id: product._id,
            change_qty: qty,
            balance_after: qty,
            reason: 'initial_stock',
            reference_type: 'import',
            user_id: req.user ? req.user.id : undefined
          });
        }
        created++;
      } catch (e) {
        errors.push(`${row.name || 'Unnamed'}: ${e.message}`);
      }
    }

    res.json({ created, skipped, errors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Import failed' });
  }
};
