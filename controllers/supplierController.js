const { Supplier, PurchaseOrder, Product, StockLedger } = require('../models');
const { generatePoNumber, parsePagination, serialize, serializeMany } = require('../utils/helpers');

exports.listSuppliers = async (req, res) => {
  try {
    const suppliers = await Supplier.find({ is_active: true }).sort({ name: 1 });
    res.json({ suppliers: serializeMany(suppliers) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list suppliers' });
  }
};

exports.createSupplier = async (req, res) => {
  try {
    const { name, contact_person, phone, email, address, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const supplier = await Supplier.create({
      name: name.trim(),
      contact_person: contact_person || null,
      phone: phone || null,
      email: email || null,
      address: address || null,
      notes: notes || null,
      is_active: true
    });
    res.status(201).json({ supplier: serialize(supplier) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create supplier' });
  }
};

exports.updateSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    const { name, contact_person, phone, email, address, notes, is_active } = req.body;
    if (name) supplier.name = name;
    if (contact_person !== undefined) supplier.contact_person = contact_person;
    if (phone !== undefined) supplier.phone = phone;
    if (email !== undefined) supplier.email = email;
    if (address !== undefined) supplier.address = address;
    if (notes !== undefined) supplier.notes = notes;
    if (is_active !== undefined) supplier.is_active = !!is_active;
    await supplier.save();
    res.json({ supplier: serialize(supplier) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update supplier' });
  }
};

exports.createPurchaseOrder = async (req, res) => {
  try {
    const { supplier_id, items, notes } = req.body;
    if (!supplier_id || !items || !items.length) {
      return res.status(400).json({ error: 'supplier_id and items required' });
    }
    let total = 0;
    for (const item of items) {
      if (!item.product_id || !item.quantity || item.unit_cost_kes == null) {
        return res.status(400).json({ error: 'Each item needs product_id, quantity, unit_cost_kes' });
      }
      total += Number(item.quantity) * Number(item.unit_cost_kes);
    }

    const po = await PurchaseOrder.create({
      supplier_id,
      po_number: generatePoNumber(),
      status: 'ordered',
      total_kes: total,
      notes: notes || null,
      ordered_by: req.user.id,
      ordered_at: new Date(),
      items: items.map((i) => ({
        product_id: i.product_id,
        quantity: Number(i.quantity),
        unit_cost_kes: Number(i.unit_cost_kes),
        received_qty: 0
      }))
    });

    const populated = await PurchaseOrder.findById(po._id).populate('supplier_id', 'name');
    res.status(201).json({ purchase_order: serialize(populated) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create purchase order' });
  }
};

exports.listPurchaseOrders = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const total = await PurchaseOrder.countDocuments();
    const list = await PurchaseOrder.find()
      .populate('supplier_id', 'name')
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit);
    res.json({
      purchase_orders: serializeMany(list),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list purchase orders' });
  }
};

exports.receivePurchaseOrder = async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.status === 'received') return res.status(400).json({ error: 'Already received' });
    if (po.status === 'cancelled') return res.status(400).json({ error: 'PO is cancelled' });

    for (const item of po.items) {
      const product = await Product.findById(item.product_id);
      if (!product) continue;
      const qty = item.quantity;
      const newBalance = product.stock_qty + qty;
      product.stock_qty = newBalance;
      product.cost_kes = item.unit_cost_kes;
      await product.save();
      await StockLedger.create({
        product_id: product._id,
        change_qty: qty,
        balance_after: newBalance,
        reason: 'purchase',
        reference_type: 'purchase_order',
        reference_id: String(po._id),
        user_id: req.user.id,
        notes: po.po_number
      });
      item.received_qty = qty;
    }
    po.status = 'received';
    po.received_at = new Date();
    await po.save();

    const populated = await PurchaseOrder.findById(po._id).populate('supplier_id', 'name');
    res.json({ purchase_order: serialize(populated) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to receive purchase order' });
  }
};
