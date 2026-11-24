
'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;

const RECEIPT_EMAIL_STATUSES = Object.freeze([
  'pending',
  'sent',
  'failed'
]);

const receiptEmailLogSchema = new Schema(
  {
    order_id: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      index: true
    },

    customer_email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      validate: {
        validator(value) {
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
        },
        message: 'Please provide a valid customer email address.'
      }
    },

    status: {
      type: String,
      enum: RECEIPT_EMAIL_STATUSES,
      default: 'pending',
      required: true,
      lowercase: true,
      trim: true,
      index: true
    },

    brevo_message_id: {
      type: String,
      default: null,
      trim: true,
      maxlength: 255
    },

    error_message: {
      type: String,
      default: null,
      trim: true,
      maxlength: 5000
    },

    attempts: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'Email attempts must be a whole number.'
      }
    },

    sent_at: {
      type: Date,
      default: null
    },

    last_attempt_at: {
      type: Date,
      default: null
    },

    next_retry_at: {
      type: Date,
      default: null,
      index: true
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at'
    },

    collection: 'receipt_email_logs',
    versionKey: false,
    strict: true,
    minimize: false,

    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      }
    }
  }
);

/*
|--------------------------------------------------------------------------
| Virtuals
|--------------------------------------------------------------------------
*/

receiptEmailLogSchema.virtual('is_sent').get(function () {
  return this.status === 'sent';
});

receiptEmailLogSchema.virtual('can_retry').get(function () {
  return this.status === 'failed' || this.status === 'pending';
});

/*
|--------------------------------------------------------------------------
| Validation Middleware
|--------------------------------------------------------------------------
*/

receiptEmailLogSchema.pre('validate', function () {
  if (this.status === 'sent') {
    this.sent_at = this.sent_at || new Date();
    this.error_message = null;
    this.next_retry_at = null;
  } else {
    this.sent_at = null;
  }

  if (this.status !== 'failed') {
    this.next_retry_at = null;
  }

  if (this.status !== 'pending') {
    this.error_message = this.error_message || null;
  }
});

/*
|--------------------------------------------------------------------------
| Instance Methods
|--------------------------------------------------------------------------
*/

receiptEmailLogSchema.methods.recordAttempt = function () {
  this.attempts += 1;
  this.last_attempt_at = new Date();
  this.status = 'pending';
  this.error_message = null;
  this.next_retry_at = null;

  return this.save();
};

receiptEmailLogSchema.methods.markAsSent = function (messageId = null) {
  this.status = 'sent';
  this.brevo_message_id = messageId;
  this.sent_at = new Date();
  this.error_message = null;
  this.next_retry_at = null;

  return this.save();
};

receiptEmailLogSchema.methods.markAsFailed = function (
  error,
  retryAt = null
) {
  this.status = 'failed';
  this.error_message = error
    ? String(error.message || error).slice(0, 5000)
    : 'Receipt email delivery failed.';

  this.sent_at = null;
  this.next_retry_at = retryAt instanceof Date ? retryAt : null;

  return this.save();
};

/*
|--------------------------------------------------------------------------
| Static Methods
|--------------------------------------------------------------------------
*/

receiptEmailLogSchema.statics.findByOrder = function (orderId) {
  return this.find({ order_id: orderId })
    .sort({ created_at: -1 });
};

receiptEmailLogSchema.statics.findPending = function (limit = 100) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || 100, 1),
    1000
  );

  return this.find({
    status: 'pending'
  })
    .sort({ created_at: 1 })
    .limit(safeLimit);
};

receiptEmailLogSchema.statics.findRetryable = function (limit = 100) {
  const now = new Date();

  const safeLimit = Math.min(
    Math.max(Number(limit) || 100, 1),
    1000
  );

  return this.find({
    status: 'failed',
    $or: [
      { next_retry_at: null },
      { next_retry_at: { $lte: now } }
    ]
  })
    .sort({ next_retry_at: 1, updated_at: 1 })
    .limit(safeLimit);
};

/*
|--------------------------------------------------------------------------
| Indexes
|--------------------------------------------------------------------------
*/

// Efficient order and status lookups.
receiptEmailLogSchema.index(
  {
    order_id: 1,
    status: 1
  },
  {
    name: 'receipt_email_order_status'
  }
);

// Prevent multiple pending receipt email records for one order.
receiptEmailLogSchema.index(
  {
    order_id: 1
  },
  {
    unique: true,
    partialFilterExpression: {
      status: 'pending'
    },
    name: 'one_pending_receipt_email_per_order'
  }
);

// Efficient email delivery history.
receiptEmailLogSchema.index(
  {
    customer_email: 1,
    created_at: -1
  },
  {
    name: 'receipt_email_customer_history'
  }
);

// Efficient retry processing.
receiptEmailLogSchema.index(
  {
    status: 1,
    next_retry_at: 1,
    updated_at: 1
  },
  {
    name: 'receipt_email_retry_queue'
  }
);

/*
|--------------------------------------------------------------------------
| Model Export
|--------------------------------------------------------------------------
*/

module.exports =
  mongoose.models.ReceiptEmailLog ||
  mongoose.model('ReceiptEmailLog', receiptEmailLogSchema);