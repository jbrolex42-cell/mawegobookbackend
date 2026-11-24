
'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;

const receiptOrderSchema = new Schema(
  {
    receipt_number: {
      type: String,
      default: null,
      trim: true,
      maxlength: 100,
      index: true
    }
  },
  {
    collection: 'orders',

    // Preserve compatibility with the existing Order documents.
    strict: false,

    // Do not automatically add timestamps to existing documents.
    timestamps: false,

    versionKey: false,
    minimize: false
  }
);

/*
|--------------------------------------------------------------------------
| Virtual Properties
|--------------------------------------------------------------------------
*/

receiptOrderSchema.virtual('has_receipt').get(function () {
  return Boolean(
    this.receipt_number &&
    this.receipt_number.trim()
  );
});

/*
|--------------------------------------------------------------------------
| Instance Methods
|--------------------------------------------------------------------------
*/

receiptOrderSchema.methods.setReceiptNumber = function (receiptNumber) {
  if (
    typeof receiptNumber !== 'string' ||
    !receiptNumber.trim()
  ) {
    throw new Error('A valid receipt number is required.');
  }

  this.receipt_number = receiptNumber.trim();

  return this.save();
};

receiptOrderSchema.methods.clearReceiptNumber = function () {
  this.receipt_number = null;

  return this.save();
};

/*
|--------------------------------------------------------------------------
| Static Methods
|--------------------------------------------------------------------------
*/

receiptOrderSchema.statics.findByReceiptNumber = function (
  receiptNumber
) {
  if (
    typeof receiptNumber !== 'string' ||
    !receiptNumber.trim()
  ) {
    return Promise.resolve(null);
  }

  return this.findOne({
    receipt_number: receiptNumber.trim()
  });
};

receiptOrderSchema.statics.findWithReceipt = function (limit = 100) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || 100, 1),
    1000
  );

  return this.find({
    receipt_number: {
      $type: 'string',
      $ne: ''
    }
  })
    .sort({ _id: -1 })
    .limit(safeLimit);
};

/*
|--------------------------------------------------------------------------
| Model Registration
|--------------------------------------------------------------------------
*/

module.exports =
  mongoose.models.ReceiptOrder ||
  mongoose.model('ReceiptOrder', receiptOrderSchema);