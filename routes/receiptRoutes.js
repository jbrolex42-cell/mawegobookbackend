
const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

function getOrdersCollection() {
  if (!mongoose.connection.db) {
    throw new Error("MongoDB database is not connected.");
  }

  return mongoose.connection.db.collection("orders");
}

function generateReceiptNumber(order) {
  const date = new Date(
    order.created_at || order.createdAt || Date.now()
  );

  const year = date.getFullYear();

  return `MB-${year}-${String(order._id).slice(-8).toUpperCase()}`;
}

function normalizeOrder(order) {
  const items = Array.isArray(order.items)
    ? order.items.map(item => {
        const quantity = Number(
          item.quantity ?? item.qty ?? 0
        );

        const price = Number(
          item.price_kes ??
          item.unit_price_kes ??
          item.price ??
          0
        );

        return {
          product_name:
            item.product_name ||
            item.name ||
            item.title ||
            "Bookshop item",

          quantity,

          line_total_kes: Number(
            item.line_total_kes ??
            item.line_total ??
            price * quantity
          )
        };
      })
    : [];

  const subtotal = Number(
    order.subtotal_kes ??
    order.subtotal ??
    0
  );

  const deliveryFee = Number(
    order.delivery_fee_kes ??
    order.delivery_fee ??
    0
  );

  return {
    order_number:
      order.order_number ||
      order.orderNumber ||
      String(order._id),

    created_at:
      order.created_at ||
      order.createdAt ||
      new Date(),

    customer_name:
      order.customer_name ||
      order.customerName ||
      order.customer?.name ||
      "Customer",

    customer_phone:
      order.customer_phone ||
      order.customerPhone ||
      order.customer?.phone ||
      "",

    customer_email:
      order.customer_email ||
      order.customerEmail ||
      "",

    fulfilment_type:
      order.fulfilment_type ||
      order.fulfilmentType ||
      "collection",

    delivery_address:
      order.delivery_address ||
      order.deliveryAddress ||
      "",

    payment_method:
      order.payment_method ||
      order.paymentMethod ||
      "Not specified",

    payment_status:
      order.payment_status ||
      order.paymentStatus ||
      "pending",

    order_status:
      order.order_status ||
      order.orderStatus ||
      "pending",

    mpesa_receipt:
      order.mpesa_receipt ||
      order.mpesaReceipt ||
      "",

    items,

    subtotal_kes: subtotal,

    discount_total_kes: Number(
      order.discount_total_kes || 0
    ),

    delivery_fee_kes: deliveryFee,

    total_kes: Number(
      order.total_kes ??
      order.total ??
      subtotal + deliveryFee
    )
  };
}

function getShopDetails() {
  return {
    name: process.env.SHOP_NAME || "Mawego Bookshop",
    address: process.env.SHOP_ADDRESS || "Kenya",
    phone: process.env.SHOP_PHONE || "",
    email: process.env.SHOP_EMAIL || "",
    footer:
      process.env.SHOP_RECEIPT_FOOTER ||
      "Thank you for shopping with Mawego Bookshop."
  };
}

async function buildReceipt(order) {
  const collection = getOrdersCollection();

  let receiptNumber = order.receipt_number;

  if (!receiptNumber) {
    const generated = generateReceiptNumber(order);

    await collection.updateOne(
      { _id: order._id },
      {
        $set: {
          receipt_number: generated
        }
      }
    );

    const updatedOrder = await collection.findOne({
      _id: order._id
    });

    if (!updatedOrder) {
      throw new Error("Could not reload order for receipt.");
    }

    order = updatedOrder;
    receiptNumber = order.receipt_number || generated;
  }

  return {
    receipt: {
      receipt_number: receiptNumber,
      order: normalizeOrder(order),
      shop: getShopDetails()
    }
  };
}

router.get("/order/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID."
      });
    }

    const collection = getOrdersCollection();

    const order = await collection.findOne({
      _id: new mongoose.Types.ObjectId(id)
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found."
      });
    }

    const result = await buildReceipt(order);

    return res.json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error("Receipt lookup error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve receipt."
    });
  }
});

router.get("/number/:orderNumber", async (req, res) => {
  try {
    const orderNumber = req.params.orderNumber;

    const phone = String(req.query.phone || "")
      .replace(/\D/g, "");

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Customer phone number is required."
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
        message: "Order not found."
      });
    }

    const orderPhone = String(
      order.customer_phone ||
      order.customerPhone ||
      order.customer?.phone ||
      ""
    ).replace(/\D/g, "");

    if (orderPhone !== phone) {
      return res.status(403).json({
        success: false,
        message: "Order verification failed."
      });
    }

    const result = await buildReceipt(order);

    return res.json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error("Receipt lookup error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve receipt."
    });
  }
});

module.exports = router;