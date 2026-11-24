
const ReceiptEmailLog = require("../models/ReceiptEmailLog");
const { generateReceiptPdf } = require("./receiptPdf");
const { sendReceiptEmail } = require("./brevoEmail");

async function sendOrderReceipt(order, options = {}) {
  const force = options.force === true;

  if (!order) {
    throw new Error("Order not found");
  }

  if (order.payment_status !== "paid") {
    throw new Error("Receipt email requires confirmed payment");
  }

  const email = order.customer_email || order.email;

  if (!email || !email.includes("@")) {
    throw new Error("Order has no valid customer email");
  }

  const orderId = order._id;

  if (!force) {
    const existingSent = await ReceiptEmailLog.findOne({
      order_id: orderId,
      status: "sent"
    });

    if (existingSent) {
      return {
        success: true,
        duplicate: true,
        message: "Receipt was already sent"
      };
    }
  }

  let log;

  try {
    log = await ReceiptEmailLog.create({
      order_id: orderId,
      customer_email: email,
      status: "pending",
      attempts: 1
    });
  } catch (error) {

    if (error.code === 11000) {
      return {
        success: false,
        processing: true,
        message: "A receipt email is already being processed"
      };
    }

    throw error;
  }

  try {
    const pdfBuffer = await generateReceiptPdf(order);

    const result = await sendReceiptEmail({
      email,
      customerName: order.customer_name,
      orderNumber: order.order_number || String(orderId),
      pdfBuffer
    });

    log.status = "sent";
    log.brevo_message_id = result.messageId || null;
    log.sent_at = new Date();
    log.error_message = "";

    await log.save();

    return {
      success: true,
      message: "Receipt email accepted by Brevo",
      messageId: result.messageId || null
    };
  } catch (error) {
    log.status = "failed";
    log.error_message = String(error.message || error).slice(0, 2000);

    await log.save();

    throw error;
  }
}

module.exports = { sendOrderReceipt };