
const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    audience: {
      type: String,
      enum: ['admin', 'customer'],
      required: true,
      index: true
    },

    user_id: {
      type: mongoose.Schema.Types.ObjectId,
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
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },

    order_number: {
      type: String,
      default: ''
    },

    link: {
      type: String,
      default: ''
    },

    is_read: {
      type: Boolean,
      default: false,
      index: true
    },

    meta: {
      type: mongoose.Schema.Types.Mixed,
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

notificationSchema.index({
  audience: 1,
  user_id: 1,
  is_read: 1,
  created_at: -1
});

module.exports =
  mongoose.models.Notification ||
  mongoose.model('Notification', notificationSchema);