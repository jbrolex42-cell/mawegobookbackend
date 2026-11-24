
'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;

// =============================================================================
// CONSTANTS
// =============================================================================

const AUDIENCES = Object.freeze([
  'admin',
  'customer'
]);

const NOTIFICATION_TYPES = Object.freeze([
  'general',
  'order',
  'payment',
  'shipping',
  'delivery',
  'inventory',
  'promotion',
  'system',
  'security',
  'account',
  'support'
]);

const MAX_TITLE_LENGTH = 180;
const MAX_BODY_LENGTH = 5000;
const MAX_LINK_LENGTH = 1000;
const MAX_ORDER_NUMBER_LENGTH = 100;

// =============================================================================
// SUBDOCUMENT SCHEMA
// =============================================================================

const notificationSchema = new Schema(
  {
    // -------------------------------------------------------------------------
    // RECIPIENT
    // -------------------------------------------------------------------------

    audience: {
      type: String,
      enum: {
        values: AUDIENCES,
        message: 'Invalid notification audience.'
      },
      required: [true, 'Notification audience is required.'],
      lowercase: true,
      trim: true,
      index: true
    },

    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true
    },

    // -------------------------------------------------------------------------
    // NOTIFICATION CLASSIFICATION
    // -------------------------------------------------------------------------

    type: {
      type: String,
      enum: {
        values: NOTIFICATION_TYPES,
        message: 'Invalid notification type.'
      },
      default: 'general',
      required: true,
      lowercase: true,
      trim: true,
      index: true
    },

    // -------------------------------------------------------------------------
    // NOTIFICATION CONTENT
    // -------------------------------------------------------------------------

    title: {
      type: String,
      required: [true, 'Notification title is required.'],
      trim: true,
      maxlength: [
        MAX_TITLE_LENGTH,
        `Notification title cannot exceed ${MAX_TITLE_LENGTH} characters.`
      ]
    },

    body: {
      type: String,
      default: '',
      trim: true,
      maxlength: [
        MAX_BODY_LENGTH,
        `Notification body cannot exceed ${MAX_BODY_LENGTH} characters.`
      ]
    },

    // -------------------------------------------------------------------------
    // RELATED ORDER
    // -------------------------------------------------------------------------

    order_id: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      default: null,
      index: true
    },

    order_number: {
      type: String,
      default: '',
      trim: true,
      maxlength: [
        MAX_ORDER_NUMBER_LENGTH,
        'Order number is too long.'
      ]
    },

    // -------------------------------------------------------------------------
    // NAVIGATION
    // -------------------------------------------------------------------------

    link: {
      type: String,
      default: '',
      trim: true,
      maxlength: [
        MAX_LINK_LENGTH,
        'Notification link is too long.'
      ],
      validate: {
        validator(value) {
          if (!value) return true;

          // Allow relative application paths and HTTP(S) URLs.
          // Reject javascript:, data:, and other unsafe protocols.
          if (value.startsWith('/')) {
            return !value.startsWith('//');
          }

          try {
            const url = new URL(value);

            return ['http:', 'https:'].includes(url.protocol);
          } catch (err) {
            return false;
          }
        },
        message: 'Notification link must be a valid relative path or HTTP(S) URL.'
      }
    },

    // -------------------------------------------------------------------------
    // READ STATUS
    // -------------------------------------------------------------------------

    is_read: {
      type: Boolean,
      default: false,
      index: true
    },

    read_at: {
      type: Date,
      default: null
    },

    // -------------------------------------------------------------------------
    // ADDITIONAL DATA
    // -------------------------------------------------------------------------

    meta: {
      type: Schema.Types.Mixed,
      default: () => ({})
    },

    // -------------------------------------------------------------------------
    // EXPIRATION
    // -------------------------------------------------------------------------

    expires_at: {
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

    collection: 'notifications',

    versionKey: false,

    minimize: false,

    strict: true,

    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      }
    },

    toObject: {
      virtuals: true
    }
  }
);

// =============================================================================
// VIRTUALS
// =============================================================================

notificationSchema.virtual('is_expired').get(function () {
  return Boolean(
    this.expires_at &&
    this.expires_at.getTime() <= Date.now()
  );
});

notificationSchema.virtual('age').get(function () {
  if (!this.created_at) return null;

  return Math.max(
    0,
    Date.now() - this.created_at.getTime()
  );
});

// =============================================================================
// VALIDATION
// =============================================================================

notificationSchema.pre('validate', function (next) {
  // Admin notifications should not accidentally be assigned to a customer.
  if (this.audience === 'admin') {
    this.user_id = null;
  }

  // Customer notifications should always have a recipient.
  if (this.audience === 'customer' && !this.user_id) {
    this.invalidate(
      'user_id',
      'A customer notification must have a user ID.'
    );
  }

  // Keep read status and read timestamp synchronized.
  if (this.is_read && !this.read_at) {
    this.read_at = new Date();
  }

  if (!this.is_read) {
    this.read_at = null;
  }

  next();
});

// =============================================================================
// INSTANCE METHODS
// =============================================================================

notificationSchema.methods.markAsRead = async function () {
  if (this.is_read) {
    return this;
  }

  this.is_read = true;
  this.read_at = new Date();

  return this.save();
};

notificationSchema.methods.markAsUnread = async function () {
  if (!this.is_read) {
    return this;
  }

  this.is_read = false;
  this.read_at = null;

  return this.save();
};

// =============================================================================
// STATIC METHODS
// =============================================================================

notificationSchema.statics.markAllAsRead = function (
  audience,
  userId = null
) {
  const filter = {
    audience,
    is_read: false
  };

  if (audience === 'customer') {
    filter.user_id = userId;
  }

  return this.updateMany(
    filter,
    {
      $set: {
        is_read: true,
        read_at: new Date()
      }
    }
  );
};

notificationSchema.statics.countUnread = function (
  audience,
  userId = null
) {
  const filter = {
    audience,
    is_read: false
  };

  if (audience === 'customer') {
    filter.user_id = userId;
  }

  return this.countDocuments(filter);
};

notificationSchema.statics.getRecent = function (
  audience,
  userId = null,
  limit = 20
) {
  const safeLimit = Math.min(
    100,
    Math.max(1, Number(limit) || 20)
  );

  const filter = { audience };

  if (audience === 'customer') {
    filter.user_id = userId;
  }

  return this.find(filter)
    .sort({
      created_at: -1,
      _id: -1
    })
    .limit(safeLimit)
    .lean();
};

// =============================================================================
// INDEXES
// =============================================================================

// Efficient customer/admin notification feeds.
notificationSchema.index({
  audience: 1,
  user_id: 1,
  created_at: -1
});

// Efficient unread notification queries.
notificationSchema.index({
  audience: 1,
  user_id: 1,
  is_read: 1,
  created_at: -1
});

// Efficient order-related notification lookups.
notificationSchema.index({
  order_id: 1,
  created_at: -1
});

// Efficient notification type filtering.
notificationSchema.index({
  audience: 1,
  type: 1,
  created_at: -1
});

// Automatically remove expired notifications.
// Documents with expires_at: null are not expired by this index.
notificationSchema.index(
  { expires_at: 1 },
  {
    expireAfterSeconds: 0,
    partialFilterExpression: {
      expires_at: { $type: 'date' }
    }
  }
);

// =============================================================================
// MODEL EXPORT
// =============================================================================

module.exports =
  mongoose.models.Notification ||
  mongoose.model('Notification', notificationSchema);