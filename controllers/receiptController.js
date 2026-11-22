const { Order, Setting } = require('../models');
const { serialize } = require('../utils/helpers');

exports.getByOrderId = async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const settings = await loadSettings();
    res.json({ order: serialize(order), settings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load receipt' });
  }
};

exports.getByOrderNumber = async (req, res) => {
  try {
    const order = await Order.findOne({ order_number: req.params.orderNumber });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (req.query.phone) {
      const a = order.customer_phone.replace(/\s/g, '');
      const b = String(req.query.phone).replace(/\s/g, '');
      if (a !== b) return res.status(403).json({ error: 'Phone does not match' });
    }
    const settings = await loadSettings();
    res.json({ order: serialize(order), settings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load receipt' });
  }
};

async function loadSettings() {
  const rows = await Setting.find();
  const settings = {};
  rows.forEach((r) => {
    settings[r.key] = r.value;
  });
  return settings;
}
