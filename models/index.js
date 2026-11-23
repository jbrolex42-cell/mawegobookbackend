const mongoose = require('mongoose');

const { Schema } = mongoose;

// ======================================================
// M-PESA TRANSACTION MODEL
// ======================================================

const MpesaTransactionSchema = new Schema(
  {
    order_id: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      index: true
    },

    phone: {
      type: String,
      required: true
    },

    amount_kes: {
      type: Number,
      required: true
    },

    account_reference: String,

    merchant_request_id: String,

    checkout_request_id: {
      type: String,
      unique: true,
      sparse: true
    },

    mpesa_receipt: String,

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
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at'
    },
    collection: 'mpesa_transactions'
  }
);

MpesaTransactionSchema.index({
  order_id: 1,
  created_at: -1
});

// ======================================================
// USER MODEL
// ======================================================

const UserSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },

    password_hash: {
      type: String,
      required: true
    },

    full_name: {
      type: String,
      required: true
    },

    phone: String,

    role: {
      type: String,
      enum: ['customer', 'staff', 'manager', 'owner'],
      default: 'customer'
    },

    permissions: {
      type: [String],
      default: []
    },

    is_active: {
      type: Boolean,
      default: true
    },

    reward_points: {
      type: Number,
      default: 0
    },

    // Password recovery
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

    // Welcome email tracking
    welcome_email_sent_at: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at'
    }
  }
);

// ======================================================
// CATEGORY MODEL
// ======================================================


// ======================================================
// CATEGORY MODEL
// ======================================================

const CategorySchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },

    slug: {
      type: String,
      required: true,
      unique: true
    },

    description: String,

    // Category display image (Cloudinary URL)
    image_url: {
      type: String,
      default: ''
    },

    // Cloudinary public ID, used when replacing or deleting images
    image_public_id: {
      type: String,
      default: ''
    },

    image_alt: {
      type: String,
      default: ''
    },

    sort_order: {
      type: Number,
      default: 0
    },

    is_active: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: false
    }
  }
);


// ======================================================
// PRODUCT MODEL
// ======================================================

const ProductSchema = new Schema(
  {
    sku: {
      type: String,
      sparse: true
    },

    barcode: String,

    name: {
      type: String,
      required: true
    },

    slug: {
      type: String,
      required: true,
      unique: true
    },

    description: String,

    category_id: {
      type: Schema.Types.ObjectId,
      ref: 'Category'
    },

    price_kes: {
      type: Number,
      required: true
    },

    cost_kes: {
      type: Number,
      default: 0
    },

    stock_qty: {
      type: Number,
      default: 0
    },

    low_stock_threshold: {
      type: Number,
      default: 5
    },

    image_url: String,

    is_active: {
      type: Boolean,
      default: true
    },

    discount_percent: {
      type: Number,
      default: 0
    },

    discount_price_kes: {
      type: Number,
      default: null
    },

    sale_label: {
      type: String,
      default: null
    },

    sale_ends_at: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at'
    }
  }
);

ProductSchema.index({
  name: 'text',
  description: 'text',
  sku: 'text'
});

// ======================================================
// STOCK LEDGER MODEL
// ======================================================

const StockLedgerSchema = new Schema(
  {
    product_id: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },

    change_qty: {
      type: Number,
      required: true
    },

    balance_after: {
      type: Number,
      required: true
    },

    reason: {
      type: String,
      required: true
    },

    reference_type: String,

    reference_id: Schema.Types.Mixed,

    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },

    notes: String
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: false
    }
  }
);

// ======================================================
// ORDER ITEM MODEL
// ======================================================

const OrderItemSchema = new Schema(
  {
    product_id: {
      type: Schema.Types.ObjectId,
      ref: 'Product'
    },

    product_name: String,

    sku: String,

    quantity: Number,

    unit_price_kes: Number,

    original_price_kes: Number,

    line_total_kes: Number,

    discount_percent: {
      type: Number,
      default: 0
    }
  },
  {
    _id: false
  }
);

// ======================================================
// ORDER MODEL
// ======================================================

const OrderSchema = new Schema(
  {
    order_number: {
      type: String,
      required: true,
      unique: true
    },

    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },

    customer_name: {
      type: String,
      required: true
    },

    customer_phone: {
      type: String,
      required: true
    },

    customer_email: String,

    fulfilment_type: {
      type: String,
      enum: ['delivery', 'collection'],
      required: true
    },

    delivery_address: String,

    delivery_notes: String,

    delivery_fee_kes: {
      type: Number,
      default: 0
    },

    subtotal_kes: {
      type: Number,
      required: true
    },

    total_kes: {
      type: Number,
      required: true
    },

    payment_method: {
      type: String,
      enum: ['mpesa', 'card', 'cash_on_delivery'],
      required: true
    },

    payment_status: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending'
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
      default: 'pending'
    },

    mpesa_receipt: String,

    card_reference: String,

    payment_reference: String,

    notes: String,

    items: [OrderItemSchema],

    discount_total_kes: {
      type: Number,
      default: 0
    },

    points_earned: {
      type: Number,
      default: 0
    },

    points_redeemed: {
      type: Number,
      default: 0
    },

    points_value_kes: {
      type: Number,
      default: 0
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at'
    }
  }
);

// ======================================================
// SUPPLIER MODEL
// ======================================================

const SupplierSchema = new Schema(
  {
    name: {
      type: String,
      required: true
    },

    contact_person: String,

    phone: String,

    email: String,

    address: String,

    notes: String,

    is_active: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: false
    }
  }
);

// ======================================================
// PURCHASE ORDER ITEM MODEL
// ======================================================

const PurchaseOrderItemSchema = new Schema(
  {
    product_id: {
      type: Schema.Types.ObjectId,
      ref: 'Product'
    },

    quantity: Number,

    unit_cost_kes: Number,

    received_qty: {
      type: Number,
      default: 0
    }
  },
  {
    _id: true
  }
);

// ======================================================
// PURCHASE ORDER MODEL
// ======================================================

const PurchaseOrderSchema = new Schema(
  {
    supplier_id: {
      type: Schema.Types.ObjectId,
      ref: 'Supplier'
    },

    po_number: {
      type: String,
      unique: true
    },

    status: {
      type: String,
      enum: ['draft', 'ordered', 'received', 'cancelled'],
      default: 'draft'
    },

    total_kes: {
      type: Number,
      default: 0
    },

    notes: String,

    ordered_by: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },

    ordered_at: Date,

    received_at: Date,

    items: [PurchaseOrderItemSchema]
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: false
    }
  }
);

// ======================================================
// PAYMENT LOG MODEL
// ======================================================

const PaymentLogSchema = new Schema(
  {
    order_id: {
      type: Schema.Types.ObjectId,
      ref: 'Order'
    },

    provider: String,

    event_type: String,

    request_payload: String,

    response_payload: String,

    status: String
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: false
    }
  }
);

// ======================================================
// DELIVERY ZONE MODEL
// ======================================================

const DeliveryZoneSchema = new Schema({
  name: String,

  fee_kes: Number,

  min_order_kes: {
    type: Number,
    default: 0
  },

  is_active: {
    type: Boolean,
    default: true
  }
});

// ======================================================
// SETTINGS MODEL
// ======================================================

const SettingSchema = new Schema({
  key: {
    type: String,
    unique: true,
    required: true
  },

  value: String,

  updated_at: {
    type: Date,
    default: Date.now
  }
});

// ======================================================
// EXPENSE MODEL
// ======================================================

const ExpenseSchema = new Schema(
  {
    category: String,

    amount_kes: Number,

    description: String,

    expense_date: String,

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

// ======================================================
// ACTIVITY LOG MODEL
// ======================================================

const ActivityLogSchema = new Schema(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },

    action: String,

    entity_type: String,

    entity_id: Schema.Types.Mixed,

    details: String
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: false
    }
  }
);

// ======================================================
// POINTS LEDGER MODEL
// ======================================================

const PointsLedgerSchema = new Schema(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    order_id: {
      type: Schema.Types.ObjectId,
      ref: 'Order'
    },

    change: {
      type: Number,
      required: true
    },

    balance_after: {
      type: Number,
      required: true
    },

    reason: {
      type: String,
      required: true
    },

    notes: String
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: false
    }
  }
);

// ======================================================
// NOTIFICATION MODEL
// ======================================================

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
      type: String,
      required: true,
      default: 'general'
    },

    title: {
      type: String,
      required: true,
      trim: true
    },

    body: {
      type: String,
      default: ''
    },

    order_id: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      default: null
    },

    order_number: String,

    link: String,

    is_read: {
      type: Boolean,
      default: false,
      index: true
    },

    meta: {
      type: Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at'
    },
    collection: 'notifications'
  }
);

NotificationSchema.index({
  audience: 1,
  user_id: 1,
  is_read: 1,
  created_at: -1
});

// ======================================================
// MODEL REGISTRATION
// ======================================================

function model(name, schema) {
  return mongoose.models[name] ||
    mongoose.model(name, schema);
}

// ======================================================
// EXPORT ALL MODELS
// ======================================================

module.exports = {
  User: model('User', UserSchema),
  Category: model('Category', CategorySchema),
  Product: model('Product', ProductSchema),
  StockLedger: model('StockLedger', StockLedgerSchema),
  Order: model('Order', OrderSchema),
  MpesaTransaction: model('MpesaTransaction', MpesaTransactionSchema),
  Supplier: model('Supplier', SupplierSchema),
  PurchaseOrder: model('PurchaseOrder', PurchaseOrderSchema),
  PaymentLog: model('PaymentLog', PaymentLogSchema),
  DeliveryZone: model('DeliveryZone', DeliveryZoneSchema),
  Setting: model('Setting', SettingSchema),
  Expense: model('Expense', ExpenseSchema),
  ActivityLog: model('ActivityLog', ActivityLogSchema),
  PointsLedger: model('PointsLedger', PointsLedgerSchema),
  Notification: model('Notification', NotificationSchema)
};