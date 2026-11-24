
const express = require("express");
const mongoose = require("mongoose");

const ReceiptOrder = require("../models/ReceiptOrder");
const ReceiptEmailLog = require("../models/ReceiptEmailLog");

const {
  authenticate,
  requireStaff
} = require("../middleware/auth");

const {
  sendOrderReceipt
} = require("../services/orderEmailService");

const router = express.Router();

router.use(authenticate, requireStaff);

router.post("/resend/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID"
      });
    }

    const order = await ReceiptOrder.findById(id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found"
      });
    }

    if (order.payment_status !== "paid") {
      return res.status(400).json({
        success: false,
        message: "Cannot send a receipt for an unpaid order"
      });
    }

    const result = await sendOrderReceipt(order, {
      force: true
    });

    if (result.processing) {
      return res.status(409).json(result);
    }

    return res.json(result);
  } catch (error) {
    console.error("Receipt resend failed:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to resend receipt"
    });
  }
});

router.get("/status/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID"
      });
    }

    const logs = await ReceiptEmailLog.find({
      order_id: id
    })
      .select("-__v")
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      emails: logs
    });
  } catch (error) {
    console.error("Receipt email history failed:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve receipt email history"
    });
  }
});

module.exports = router;