
const mongoose = require("mongoose");

const receiptOrderSchema = new mongoose.Schema(
  {
    receipt_number: {
      type: String,
      default: null
    }
  },
  {
    strict: false,
    collection: "orders"
  }
);

module.exports =
  mongoose.models.ReceiptOrder ||
  mongoose.model("ReceiptOrder", receiptOrderSchema);