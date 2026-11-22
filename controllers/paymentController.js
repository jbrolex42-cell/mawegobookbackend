const { Order, PaymentLog } = require('../models');
const orderController = require('./orderController');
const { serialize } = require('../utils/helpers');

async function logPayment(orderId, provider, eventType, request, response, status) {
  await PaymentLog.create({
    order_id: orderId || null,
    provider,
    event_type: eventType,
    request_payload: request ? JSON.stringify(request) : null,
    response_payload: response ? JSON.stringify(response) : null,
    status: status || null
  });
}

exports.mpesaStkPush = async (req, res) => {
  try {
    const { order_id, phone } = req.body;
    if (!order_id || !phone) return res.status(400).json({ error: 'order_id and phone are required' });

    const order = await Order.findById(order_id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_method !== 'mpesa') {
      return res.status(400).json({ error: 'Order is not set for M-Pesa payment' });
    }
    if (order.payment_status === 'paid') return res.status(400).json({ error: 'Order already paid' });

    if (
      !process.env.MPESA_CONSUMER_KEY ||
      !process.env.MPESA_CONSUMER_SECRET ||
      !process.env.MPESA_SHORTCODE ||
      !process.env.MPESA_PASSKEY
    ) {
      await logPayment(order_id, 'mpesa', 'stk_push_attempt', req.body, { message: 'Credentials missing' }, 'not_configured');
      return res.status(503).json({
        error: 'M-Pesa is not configured',
        message:
          'Add MPESA credentials to .env. Until then, mark orders paid from Admin after manual confirmation.',
        order_id,
        amount: order.total_kes,
        setup_guide: 'https://developer.safaricom.co.ke/'
      });
    }

    let msisdn = String(phone).replace(/\s+/g, '').replace(/^\+/, '');
    if (msisdn.startsWith('0')) msisdn = '254' + msisdn.slice(1);
    if (!msisdn.startsWith('254')) msisdn = '254' + msisdn;

    const amount = Math.round(order.total_kes);
    await logPayment(order_id, 'mpesa', 'stk_push_request', { order_id, msisdn, amount }, null, 'pending_integration');

    res.json({
      success: true,
      message:
        'STK Push endpoint ready. With Daraja credentials the customer will get a prompt. For now use Admin → Mark paid.',
      order_id,
      order_number: order.order_number,
      amount,
      phone: msisdn
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'M-Pesa initiation failed' });
  }
};

exports.mpesaCallback = async (req, res) => {
  try {
    const body = req.body;
    await logPayment(null, 'mpesa', 'callback', body, null, 'received');
    const callback = body?.Body?.stkCallback;
    if (!callback) return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

    const resultCode = callback.ResultCode;
    const metadata = callback.CallbackMetadata?.Item || [];
    let amount, mpesaReceipt;
    for (const item of metadata) {
      if (item.Name === 'Amount') amount = item.Value;
      if (item.Name === 'MpesaReceiptNumber') mpesaReceipt = item.Value;
    }

    if (resultCode === 0 && mpesaReceipt) {
      const order = await Order.findOne({
        payment_method: 'mpesa',
        payment_status: 'pending',
        total_kes: amount
      }).sort({ created_at: -1 });
      if (order) {
        await orderController.markPaid(order._id, {
          mpesa_receipt: mpesaReceipt,
          payment_reference: callback.CheckoutRequestID
        });
        await logPayment(order._id, 'mpesa', 'payment_success', body, { receipt: mpesaReceipt }, 'paid');
      }
    }
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error(err);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
};

exports.cardInitiate = async (req, res) => {
  try {
    const { order_id } = req.body;
    const order = await Order.findById(order_id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_method !== 'card') {
      return res.status(400).json({ error: 'Order is not set for card payment' });
    }
    if (!process.env.PESAPAL_CONSUMER_KEY) {
      await logPayment(order_id, 'card', 'initiate', req.body, { message: 'Not configured' }, 'not_configured');
      return res.status(503).json({
        error: 'Card payments not configured',
        message: 'Set PESAPAL keys in .env, or mark paid from Admin.',
        order_id,
        amount: order.total_kes
      });
    }
    res.json({
      success: true,
      message: 'Card gateway endpoint ready.',
      order_id,
      order_number: order.order_number,
      amount: order.total_kes
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Card payment initiation failed' });
  }
};

exports.cardCallback = async (req, res) => {
  await logPayment(null, 'card', 'callback', req.body || req.query, null, 'received');
  res.json({ status: 'ok' });
};

exports.adminMarkPaid = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const { mpesa_receipt, payment_reference } = req.body || {};
    const updated = await orderController.markPaid(order._id, {
      mpesa_receipt: mpesa_receipt || null,
      payment_reference: payment_reference || `manual-${Date.now()}`
    });
    await logPayment(order._id, 'manual', 'admin_mark_paid', req.body, null, 'paid');
    res.json({ order: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark paid' });
  }
};
