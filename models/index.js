
'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;

// ============================================================
// SHARED HELPERS
// ============================================================

const MODEL_OPTIONS = {
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
};

function registerModel(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

function trimmedString(options = {}) {
  return {
    type: String,
    trim: true,
    ...options
  };
}

function nonNegativeNumber(options = {}) {
  return {
    type: Number,
    min: 0,
    ...options
  };
}

function positiveNumber(options = {}) {
  return {
    type: Number,
    min: Number.EPSILON,
    ...options
  };
}

// ============================================================
// M-PESA TRANSACTION
// ============================================================

const MpesaTransactionSchema = new Schema(
  {
    order_id: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      index: true
    },

    phone: {
      ...trimmedString({ required: true }),
      maxlength: 30
    },

    amount_kes: {
      ...positiveNumber({ required: true })
    },

    account_reference: trimmedString(),
    merchant_request_id: trimmedString(),

    checkout_request_id: {
      ...trimmedString(),
      unique: true,
      sparse: true
    },

    mpesa_receipt: {
      ...trimmedString(),
      index: true
    },

    status: {
      type: String,
      enum: ['initiated', 'pending', 'success', 'failed'],
      default: 'initiated',
      index: true
    },

    result_code: Schema.Types.Mixed,
    result_description: String,

    request_response: Schema.Types.Mixed,
    callback_payload: Schema.Types.Mixed,

    completed_at: Date
  },
  {
    ...MODEL_OPTIONS,
    collection: 'mpesa_transactions'
  }
);

MpesaTransactionSchema.index({
  order_id: 1,
  created_at: -1
});

MpesaTransactionSchema.index({
  status: 1,
  created_at: -1
});

// ============================================================
// USER
// ============================================================

const UserSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
      index: true
    },

    password_hash: {
      type: String,
      required: true,
      select: false
    },

    full_name: {
      ...trimmedString({ required: true }),
      maxlength: 150
    },

    phone: {
      ...trimmedString(),
      maxlength: 30
    },

    role: {
      type: String,
      enum: ['customer', 'staff', 'manager', 'owner'],
      default: 'customer',
      index: true
    },

    permissions: {
      type: [String],
      default: []
    },

    is_active: {
      type: Boolean,
      default: true,
      index: true
    },

    reward_points: {
      ...nonNegativeNumber(),
      default: 0
    },

    password_reset_token_hash: {
      type: String,
      default: null,
      select: false
    },

    password_reset_expires: {
      type: Date,
      default: null,
      select: false
    },

    welcome_email_sent_at: {
      type: Date,
      default: null
    }
  },
  MODEL_OPTIONS
);

UserSchema.index({
  role: 1,
  is_active: 1
});

// ============================================================
// CATEGORY
// ============================================================

const CategorySchema = new Schema(
  {
    name: {
      ...trimmedString({ required: true }),
      maxlength: 120
    },

    slug: {
      ...trimmedString({ required: true }),
      lowercase: true,
      unique: true,
      maxlength: 160
    },

    description: {
      type: String,
      trim: true,
      maxlength: 2000
    },

    image_url: {
      type: String,
      trim: true,
      default: ''
    },

    image_public_id: {
      type: String,
      trim: true,
      default: ''
    },

    image_alt: {
      type: String,
      trim: true,
      default: '',
      maxlength: 250
    },

    sort_order: {
      type: Number,
      default: 0
    },

    is_active: {
      type: Boolean,
      default: true,
      index: true
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: false
    }
  }
);

CategorySchema.index({
  is_active: 1,
  sort_order: 1,
  name: 1
});

// ============================================================
// PRODUCT
// ============================================================

const ProductSchema = new Schema(
  {
    sku: {
      ...trimmedString(),
      uppercase: true,
      maxlength: 80
    },

    barcode: {
      ...trimmedString(),
      maxlength: 100
    },

    name: {
      ...trimmedString({ required: true }),
      maxlength: 200
    },

    slug: {
      ...trimmedString({ required: true }),
      lowercase: true,
      unique: true,
      maxlength: 220
    },

    description: {
      type: String,
      trim: true,
      maxlength: 10000
    },

    category_id: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
      index: true
    },

    price_kes: {
      ...nonNegativeNumber({ required: true })
    },

    cost_kes: {
      ...nonNegativeNumber(),
      default: 0
    },

    stock_qty: {
      ...nonNegativeNumber(),
      default: 0
    },

    low_stock_threshold: {
      ...nonNegativeNumber(),
      default: 5
    },

    image_url: {
      type: String,
      trim: true,
      default: ''
    },

    is_active: {
      type: Boolean,
      default: true,
      index: true
    },

    discount_percent: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    },

    discount_price_kes: {
      type: Number,
      min: 0,
      default: null
    },

    sale_label: {
      type: String,
      trim: true,
      default: null,
      maxlength: 80
    },

    sale_ends_at: {
      type: Date,
      default: null
    }
  },
  MODEL_OPTIONS
);

ProductSchema.index(
  { sku: 1 },
  {
    unique: true,
    sparse: true
  }
);

ProductSchema.index(
  { barcode: 1 },
  {
    unique: true,
    sparse: true
  }
);

ProductSchema.index({
  is_active: 1,
  category_id: 1,
  created_at: -1
});

ProductSchema.index({
  stock_qty: 1,
  low_stock_threshold: 1
});

ProductSchema.index({
  name: 'text',
  description: 'text',
  sku: 'text'
});

// ============================================================
// STOCK LEDGER
// ============================================================

const StockLedgerSchema = new Schema(
  {
    product_id: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true
    },

    change_qty: {
      type: Number,
      required: true,
      validate: {
        validator: Number.isFinite,
        message: 'Stock change must be a valid number'
      }
    },

    balance_after: {
      ...nonNegativeNumber({ required: true })
    },

    reason: {
      ...trimmedString({ required: true }),
      maxlength: 100
    },

    reference_type: {
      ...trimmedString(),
      maxlength: 100
    },

    reference_id: Schema.Types.Mixed,

    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true
    },

    notes: {
      type: String,
      trim: true,
      maxlength: 2000
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: false
    }
  }
);

StockLedgerSchema.index({
  product_id: 1,
  created_at: -1
});

StockLedgerSchema.index({
  reference_type: 1,
  reference_id: 1
});

// ============================================================
// ORDER ITEMS
// ============================================================

const OrderItemSchema = new Schema(
  {
    product_id: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      default: null
    },

    product_name: {
      ...trimmedString(),
      maxlength: 200
    },

    sku: {
      ...trimmedString(),
      maxlength: 80
    },

    quantity: {
      ...positiveNumber()
    },

    unit_price_kes: nonNegativeNumber(),

    original_price_kes: nonNegativeNumber(),

    line_total_kes: nonNegativeNumber(),

    discount_percent: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    }
  },
  {
    _id: false
  }
);

// ============================================================
// ORDER
// ============================================================

const OrderSchema = new Schema(
  {
    order_number: {
      ...trimmedString({ required: true }),
      unique: true,
      index: true,
      maxlength: 80
    },

    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true
    },

    customer_name: {
      ...trimmedString({ required: true }),
      maxlength: 150
    },

    customer_phone: {
      ...trimmedString({ required: true }),
      maxlength: 30
    },

    customer_email: {
      type: String,
      lowercase: true,
      trim: true,
      maxlength: 254
    },

    fulfilment_type: {
      type: String,
      enum: ['delivery', 'collection'],
      required: true,
      index: true
    },

    delivery_address: {
      type: String,
      trim: true,
      maxlength: 1000
    },

    delivery_notes: {
      type: String,
      trim: true,
      maxlength: 2000
    },

    delivery_fee_kes: {
      ...nonNegativeNumber(),
      default: 0
    },

    subtotal_kes: {
      ...nonNegativeNumber({ required: true })
    },

    total_kes: {
      ...nonNegativeNumber({ required: true })
    },

    payment_method: {
      type: String,
      enum: ['mpesa', 'card', 'cash_on_delivery'],
      required: true,
      index: true
    },

    payment_status: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
      index: true
    },

    order_status: {
      type: String,
      enum: [
        'pending',
        'confirmed',
        'processing',
        'ready',
        'out_for_delivery',
        'completed',
        'cancelled'
      ],
      default: 'pending',
      index: true
    },

    mpesa_receipt: {
      ...trimmedString(),
      maxlength: 100
    },

    card_reference: {
      ...trimmedString(),
      maxlength: 150
    },

    payment_reference: {
      ...trimmedString(),
      maxlength: 150
    },

    notes: {
      type: String,
      trim: true,
      maxlength: 3000
    },

    items: {
      type: [OrderItemSchema],
      default: []
    },

    discount_total_kes: {
      ...nonNegativeNumber(),
      default: 0
    },

    points_earned: {
      ...nonNegativeNumber(),
      default: 0
    },

    points_redeemed: {
      ...nonNegativeNumber(),
      default: 0
    },

    points_value_kes: {
      ...nonNegativeNumber(),
      default: 0
    },

    coupon_code: {
      type: String,
      default: null,
      uppercase: true,
      trim: true,
      maxlength: 80
    },

    coupon_discount_kes: {
      ...nonNegativeNumber(),
      default: 0
    },

    points_redeemed_refunded: {
      type: Boolean,
      default: false
    }
  },
  MODEL_OPTIONS
);

OrderSchema.index({
  created_at: -1
});

OrderSchema.index({
  payment_status: 1,
  order_status: 1,
  created_at: -1
});

OrderSchema.index({
  user_id: 1,
  created_at: -1
});

OrderSchema.index({
  customer_phone: 1,
  created_at: -1
});

// ============================================================
// SUPPLIER
// ============================================================

const SupplierSchema = new Schema(
  {
    name: {
      ...trimmedString({ required: true }),
      maxlength: 200
    },

    contact_person: {
      ...trimmedString(),
      maxlength: 150
    },

    phone: {
      ...trimmedString(),
      maxlength: 30
    },

    email: {
      type: String,
      lowercase: true,
      trim: true,
      maxlength: 254
    },

    address: {
      type: String,
      trim: true,
      maxlength: 1000
    },

    notes: {
      type: String,
      trim: true,
      maxlength: 3000
    },

    is_active: {
      type: Boolean,
      default: true,
      index: true
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: false
    }
  }
);

SupplierSchema.index({
  is_active: 1,
  name: 1
});

// ============================================================
// PURCHASE ORDER ITEMS
// ============================================================

const PurchaseOrderItemSchema = new Schema(
  {
    product_id: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },

    quantity: {
      ...positiveNumber({ required: true })
    },

    unit_cost_kes: {
      ...nonNegativeNumber({ required: true })
    },

    received_qty: {
      ...nonNegativeNumber(),
      default: 0,
      validate: {
        validator(value) {
          return value <= this.quantity;
        },
        message: 'Received quantity cannot exceed ordered quantity'
      }
    }
  },
  {
    _id: true
  }
);

// ============================================================
// PURCHASE ORDER
// ============================================================

const PurchaseOrderSchema = new Schema(
  {
    supplier_id: {
      type: Schema.Types.ObjectId,
      ref: 'Supplier',
      required: true,
      index: true
    },

    po_number: {
      ...trimmedString(),
      unique: true,
      sparse: true,
      maxlength: 80
    },

    status: {
      type: String,
      enum: ['draft', 'ordered', 'received', 'cancelled'],
      default: 'draft',
      index: true
    },

    total_kes: {
      ...nonNegativeNumber(),
      default: 0
    },

    notes: {
      type: String,
      trim: true,
      maxlength: 3000
    },

    ordered_by: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },

    ordered_at: Date,
    received_at: Date,

    items: {
      type: [PurchaseOrderItemSchema],
      default: []
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: false
    }
  }
);

PurchaseOrderSchema.index({
  status: 1,
  created_at: -1
});

PurchaseOrderSchema.index({
  supplier_id: 1,
  created_at: -1
});

// ============================================================
// PAYMENT LOG
// ============================================================

const PaymentLogSchema = new Schema(
  {
    order_id: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      index: true
    },

    provider: {
      ...trimmedString(),
      maxlength: 100
    },

    event_type: {
      ...trimmedString(),
      maxlength: 150
    },

    request_payload: String,
    response_payload: String,

    status: {
      ...trimmedString(),
      maxlength: 100,
      index: true
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: false
    }
  }
);

PaymentLogSchema.index({
  order_id: 1,
  created_at: -1
});

// ============================================================
// DELIVERY ZONE
// ============================================================

const DeliveryZoneSchema = new Schema(
  {
    name: {
      ...trimmedString(),
      maxlength: 150
    },

    fee_kes: nonNegativeNumber(),

    min_order_kes: {
      ...nonNegativeNumber(),
      default: 0
    },

    is_active: {
      type: Boolean,
      default: true,
      index: true
    }
  },
  MODEL_OPTIONS
);

DeliveryZoneSchema.index({
  is_active: 1,
  name: 1
});

// ============================================================
// SHOP SETTINGS
// ============================================================

const SettingSchema = new Schema(
  {
    key: {
      ...trimmedString({ required: true }),
      unique: true,
      maxlength: 150
    },

    value: {
      type: String,
      default: ''
    },

    updated_at: {
      type: Date,
      default: Date.now
    }
  },
  {
    versionKey: false
  }
);

// ============================================================
// EXPENSE
// ============================================================

const ExpenseSchema = new Schema(
  {
    category: {
      ...trimmedString(),
      maxlength: 150
    },

    amount_kes: {
      ...nonNegativeNumber()
    },

    description: {
      type: String,
      trim: true,
      maxlength: 3000
    },

    expense_date: {
      type: String,
      trim: true,
      maxlength: 30,
      index: true
    },

    recorded_by: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: false
    }
  }
);

ExpenseSchema.index({
  category: 1,
  expense_date: -1
});

// ============================================================
// ACTIVITY LOG
// ============================================================

const ActivityLogSchema = new Schema(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true
    },

    action: {
      ...trimmedString(),
      maxlength: 150
    },

    entity_type: {
      ...trimmedString(),
      maxlength: 100
    },

    entity_id: Schema.Types.Mixed,

    details: {
      type: String,
      trim: true,
      maxlength: 5000
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: false
    }
  }
);

ActivityLogSchema.index({
  entity_type: 1,
  entity_id: 1,
  created_at: -1
});

ActivityLogSchema.index({
  created_at: -1
});

// ============================================================
// REWARDS POINTS LEDGER
// ============================================================

const PointsLedgerSchema = new Schema(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },

    order_id: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      index: true
    },

    change: {
      type: Number,
      required: true,
      validate: {
        validator: Number.isFinite,
        message: 'Points change must be a valid number'
      }
    },

    balance_after: {
      ...nonNegativeNumber({ required: true })
    },

    reason: {
      ...trimmedString({ required: true }),
      maxlength: 150
    },

    notes: {
      type: String,
      trim: true,
      maxlength: 2000
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: false
    }
  }
);

PointsLedgerSchema.index({
  user_id: 1,
  created_at: -1
});

// ============================================================
// PROMO CODE
// ============================================================

const PromoCodeSchema = new Schema(
  {
    code: {
      ...trimmedString({ required: true }),
      uppercase: true,
      unique: true,
      maxlength: 80
    },

    discount_type: {
      type: String,
      enum: ['percent', 'fixed'],
      required: true
    },

    discount_value: {
      ...nonNegativeNumber({ required: true })
    },

    min_order_kes: {
      ...nonNegativeNumber(),
      default: 0
    },

    max_discount_kes: {
      type: Number,
      min: 0,
      default: null
    },

    usage_limit: {
      type: Number,
      min: 1,
      default: null
    },

    used_count: {
      ...nonNegativeNumber(),
      default: 0
    },

    per_user_limit: {
      type: Number,
      min: 0,
      default: 1
    },

    starts_at: {
      type: Date,
      default: null
    },

    expires_at: {
      type: Date,
      default: null
    },

    is_active: {
      type: Boolean,
      default: true,
      index: true
    },

    description: {
      type: String,
      trim: true,
      default: '',
      maxlength: 1000
    },

    created_by: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null
    }
  },
  {
    ...MODEL_OPTIONS,
    collection: 'promo_codes'
  }
);

PromoCodeSchema.index({
  is_active: 1,
  starts_at: 1,
  expires_at: 1
});

// ============================================================
// NOTIFICATION
// ============================================================

const NotificationSchema = new Schema(
  {
    audience: {
      type: String,
      enum: ['admin', 'customer'],
      required: true,
      index: true
    },

    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true
    },

    type: {
      ...trimmedString(),
      required: true,
      default: 'general',
      maxlength: 100
    },

    title: {
      ...trimmedString({ required: true }),
      maxlength: 200
    },

    body: {
      type: String,
      trim: true,
      default: '',
      maxlength: 5000
    },

    order_id: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      default: null,
      index: true
    },

    order_number: {
      ...trimmedString(),
      default: '',
      maxlength: 80
    },

    link: {
      ...trimmedString(),
      default: '',
      maxlength: 1000
    },

    is_read: {
      type: Boolean,
      default: false,
      index: true
    },

    meta: {
      type: Schema.Types.Mixed,
      default: () => ({})
    }
  },
  {
    ...MODEL_OPTIONS,
    collection: 'notifications'
  }
);

NotificationSchema.index({
  audience: 1,
  user_id: 1,
  is_read: 1,
  created_at: -1
});

NotificationSchema.index({
  order_id: 1,
  created_at: -1
});

// ============================================================
// REGISTER AND EXPORT MODELS
// ============================================================

const User = registerModel('User', UserSchema);
const Category = registerModel('Category', CategorySchema);
const Product = registerModel('Product', ProductSchema);
const StockLedger = registerModel('StockLedger', StockLedgerSchema);
const Order = registerModel('Order', OrderSchema);
const MpesaTransaction = registerModel(
  'MpesaTransaction',
  MpesaTransactionSchema
);
const Supplier = registerModel('Supplier', SupplierSchema);
const PurchaseOrder = registerModel('PurchaseOrder', PurchaseOrderSchema);
const PaymentLog = registerModel('PaymentLog', PaymentLogSchema);
const DeliveryZone = registerModel('DeliveryZone', DeliveryZoneSchema);
const Setting = registerModel('Setting', SettingSchema);
const Expense = registerModel('Expense', ExpenseSchema);
const ActivityLog = registerModel('ActivityLog', ActivityLogSchema);
const PointsLedger = registerModel('PointsLedger', PointsLedgerSchema);
const PromoCode = registerModel('PromoCode', PromoCodeSchema);
const Notification = registerModel('Notification', NotificationSchema);

module.exports = {
  User,
  Category,
  Product,
  StockLedger,
  Order,
  MpesaTransaction,
  Supplier,
  PurchaseOrder,
  PaymentLog,
  DeliveryZone,
  Setting,
  Expense,
  ActivityLog,
  PointsLedger,
  PromoCode,
  Notification
};