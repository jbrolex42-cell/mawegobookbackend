
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const {
  authenticate,
  optionalAuth,
  requireStaff,
  requireManager
} = require('../middleware/auth');

const {
  productImage,
  resolveImageUrl
} = require('../middleware/upload');

const authCtrl = require('../controllers/authController');
const productCtrl = require('../controllers/productController');
const orderCtrl = require('../controllers/orderController');
const paymentCtrl = require('../controllers/paymentController');
const mpesaCtrl = require('../controllers/mpesaController');
const reportCtrl = require('../controllers/reportController');
const supplierCtrl = require('../controllers/supplierController');
const expenseCtrl = require('../controllers/expenseController');
const pointsCtrl = require('../controllers/pointsController');
const promoCtrl = require('../controllers/promoController');
const notificationCtrl = require('../controllers/notificationController');

const router = express.Router();

/*
|--------------------------------------------------------------------------
| Rate Limiters
|--------------------------------------------------------------------------
*/

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many password reset attempts. Please try again later.'
  }
});

/*
|--------------------------------------------------------------------------
| Controller Registry
|--------------------------------------------------------------------------
*/

const controllers = {
  authCtrl,
  productCtrl,
  orderCtrl,
  paymentCtrl,
  mpesaCtrl,
  reportCtrl,
  supplierCtrl,
  expenseCtrl,
  pointsCtrl,
  promoCtrl,
  notificationCtrl
};

/*
|--------------------------------------------------------------------------
| Controller Method Validation
|--------------------------------------------------------------------------
|
| Check all methods used by this router before registering routes.
| This prevents undefined controller handlers from causing runtime errors.
|
*/

const requiredMethods = {
  authCtrl: [
    'register',
    'login',
    'forgotPassword',
    'resetPassword',
    'me',
    'myOrders',
    'createStaff',
    'listStaff',
    'updateStaff'
  ],

  productCtrl: [
    'categories',
    'listCategoriesAdmin',
    'uploadCategoryImage',
    'removeCategoryImage',
    'listPublic',
    'getBySlug',
    'listAdmin',
    'create',
    'update',
    'remove',
    'adjustStock',
    'stockLedger',
    'bulkImport'
  ],

  orderCtrl: [
    'create',
    'getByNumber',
    'getCustomerStatus',
    'cancelCustomerOrder',
    'listAdmin',
    'getAdmin',
    'updateStatus',
    'markPaid'
  ],

  paymentCtrl: [
    'cardInitiate',
    'cardCallback',
    'adminMarkPaid'
  ],

  mpesaCtrl: [
    'initiateStk',
    'callback'
  ],

  reportCtrl: [
    'dashboard',
    'salesReport',
    'inventoryReport',
    'profitLoss'
  ],

  supplierCtrl: [
    'listSuppliers',
    'createSupplier',
    'updateSupplier',
    'listPurchaseOrders',
    'createPurchaseOrder',
    'receivePurchaseOrder'
  ],

  expenseCtrl: [
    'categories',
    'list',
    'create',
    'update',
    'remove'
  ],

  pointsCtrl: [
    'balance',
    'history'
  ],

  promoCtrl: [
    'validate',
    'create',
    'list'
  ],

  notificationCtrl: [
    'list',
    'unreadCount',
    'markRead',
    'markAllRead',
    'clearRead',
    'clearAll'
  ]
};

function validateControllers() {
  const missingMethods = [];

  for (const [controllerName, methods] of Object.entries(requiredMethods)) {
    const controller = controllers[controllerName];

    for (const method of methods) {
      if (
        !controller ||
        typeof controller[method] !== 'function'
      ) {
        missingMethods.push(`${controllerName}.${method}`);
      }
    }
  }

  if (missingMethods.length > 0) {
    console.error('\nController validation failed.');

    for (const method of missingMethods) {
      console.error(` - ${method}`);
    }

    throw new Error(
      `Missing controller functions: ${missingMethods.join(', ')}`
    );
  }
}

validateControllers();

/*
|--------------------------------------------------------------------------
| Authentication Routes
|--------------------------------------------------------------------------
*/

// Customer registration.
router.post(
  '/auth/register',
  authCtrl.register
);

// Customer and staff login.
router.post(
  '/auth/login',
  authCtrl.login
);

// Password recovery.
router.post(
  '/auth/forgot-password',
  passwordResetLimiter,
  authCtrl.forgotPassword
);

router.post(
  '/auth/reset-password',
  passwordResetLimiter,
  authCtrl.resetPassword
);

// Authenticated user profile.
router.get(
  '/auth/me',
  authenticate,
  authCtrl.me
);

// Authenticated customer order history.
router.get(
  '/auth/my-orders',
  authenticate,
  authCtrl.myOrders
);

/*
|--------------------------------------------------------------------------
| Staff Management Routes
|--------------------------------------------------------------------------
*/

router.post(
  '/auth/staff',
  authenticate,
  requireManager,
  authCtrl.createStaff
);

router.get(
  '/auth/staff',
  authenticate,
  requireManager,
  authCtrl.listStaff
);

router.patch(
  '/auth/staff/:id',
  authenticate,
  requireManager,
  authCtrl.updateStaff
);

/*
|--------------------------------------------------------------------------
| Category Routes
|--------------------------------------------------------------------------
*/

// Public categories.
router.get(
  '/categories',
  productCtrl.categories
);

// Administrative category listing.
router.get(
  '/admin/categories',
  authenticate,
  requireStaff,
  productCtrl.listCategoriesAdmin
);

// Upload category image.
router.post(
  '/admin/categories/:id/image',
  authenticate,
  requireStaff,
  (req, res, next) => {
    req.uploadFolder = 'mawego-bookshop/categories';
    next();
  },
  productImage(),
  resolveImageUrl,
  productCtrl.uploadCategoryImage
);

// Remove category image.
router.delete(
  '/admin/categories/:id/image',
  authenticate,
  requireStaff,
  productCtrl.removeCategoryImage
);

/*
|--------------------------------------------------------------------------
| Public Product Routes
|--------------------------------------------------------------------------
*/

router.get(
  '/products',
  productCtrl.listPublic
);

router.get(
  '/products/:slug',
  productCtrl.getBySlug
);

/*
|--------------------------------------------------------------------------
| Administrative Product Routes
|--------------------------------------------------------------------------
*/

// Product listing.
router.get(
  '/admin/products',
  authenticate,
  requireStaff,
  productCtrl.listAdmin
);

// Create product.
router.post(
  '/admin/products',
  authenticate,
  requireStaff,
  productImage(),
  resolveImageUrl,
  productCtrl.create
);

// Update product.
router.put(
  '/admin/products/:id',
  authenticate,
  requireStaff,
  productImage(),
  resolveImageUrl,
  productCtrl.update
);

// Adjust stock.
router.post(
  '/admin/products/:id/stock',
  authenticate,
  requireStaff,
  productCtrl.adjustStock
);

// Stock movement history.
router.get(
  '/admin/products/:id/ledger',
  authenticate,
  requireStaff,
  productCtrl.stockLedger
);

// Delete product.
router.delete(
  '/admin/products/:id',
  authenticate,
  requireManager,
  productCtrl.remove
);

// Bulk product import.
router.post(
  '/admin/products/import',
  authenticate,
  requireManager,
  productCtrl.bulkImport
);

/*
|--------------------------------------------------------------------------
| Promotion Routes
|--------------------------------------------------------------------------
*/

// Validate promotion code.
router.post(
  '/promos/validate',
  optionalAuth,
  promoCtrl.validate
);

// Administrative promotion listing.
router.get(
  '/admin/promos',
  authenticate,
  requireManager,
  promoCtrl.list
);

// Create promotion.
router.post(
  '/admin/promos',
  authenticate,
  requireManager,
  promoCtrl.create
);

/*
|--------------------------------------------------------------------------
| Customer Order Routes
|--------------------------------------------------------------------------
*/

// Create an order.
router.post(
  '/orders',
  optionalAuth,
  orderCtrl.create
);

// Public order tracking.
router.get(
  '/orders/track/:orderNumber',
  orderCtrl.getByNumber
);

// Authenticated customer order status.
router.get(
  '/orders/:id/status',
  authenticate,
  orderCtrl.getCustomerStatus
);

// Customer order cancellation.
router.post(
  '/orders/:id/cancel',
  authenticate,
  orderCtrl.cancelCustomerOrder
);

/*
|--------------------------------------------------------------------------
| Administrative Order Routes
|--------------------------------------------------------------------------
*/

// Order listing.
router.get(
  '/admin/orders',
  authenticate,
  requireStaff,
  orderCtrl.listAdmin
);

// Individual order details.
router.get(
  '/admin/orders/:id',
  authenticate,
  requireStaff,
  orderCtrl.getAdmin
);

// Update order status.
router.patch(
  '/admin/orders/:id',
  authenticate,
  requireStaff,
  orderCtrl.updateStatus
);

// Manually mark order as paid.
router.post(
  '/admin/orders/:id/mark-paid',
  authenticate,
  requireStaff,
  paymentCtrl.adminMarkPaid
);

/*
|--------------------------------------------------------------------------
| Receipt Routes
|--------------------------------------------------------------------------
*/

router.use(
  '/receipts',
  require('./receiptRoutes')
);

/*
|--------------------------------------------------------------------------
| M-Pesa Payment Routes
|--------------------------------------------------------------------------
*/

// Initiate M-Pesa STK Push.
router.post(
  '/payments/mpesa/stk',
  optionalAuth,
  mpesaCtrl.initiateStk
);

// Safaricom Daraja callback.
// Do not require customer authentication on gateway callbacks.
router.post(
  '/payments/mpesa/callback',
  mpesaCtrl.callback
);

/*
|--------------------------------------------------------------------------
| Card Payment Routes
|--------------------------------------------------------------------------
*/

// Initiate card payment.
router.post(
  '/payments/card/initiate',
  paymentCtrl.cardInitiate
);

// Card payment callback.
router.get(
  '/payments/card/callback',
  paymentCtrl.cardCallback
);

router.post(
  '/payments/card/callback',
  paymentCtrl.cardCallback
);

/*
|--------------------------------------------------------------------------
| Loyalty Points Routes
|--------------------------------------------------------------------------
*/

router.get(
  '/points/balance',
  authenticate,
  pointsCtrl.balance
);

router.get(
  '/points/history',
  authenticate,
  pointsCtrl.history
);

/*
|--------------------------------------------------------------------------
| Notification Routes
|--------------------------------------------------------------------------
*/

// Notification listing.
router.get(
  '/notifications',
  authenticate,
  notificationCtrl.list
);

// Unread notification count.
router.get(
  '/notifications/unread-count',
  authenticate,
  notificationCtrl.unreadCount
);

// Mark one notification as read.
router.patch(
  '/notifications/:id/read',
  authenticate,
  notificationCtrl.markRead
);

// Mark all notifications as read.
router.post(
  '/notifications/read-all',
  authenticate,
  notificationCtrl.markAllRead
);

// Clear read notifications.
router.delete(
  '/notifications/clear-read',
  authenticate,
  notificationCtrl.clearRead
);

// Clear all notifications.
router.delete(
  '/notifications/clear-all',
  authenticate,
  notificationCtrl.clearAll
);

/*
|--------------------------------------------------------------------------
| Dashboard and Reporting Routes
|--------------------------------------------------------------------------
*/

// Main administrative dashboard.
router.get(
  '/admin/dashboard',
  authenticate,
  requireStaff,
  reportCtrl.dashboard
);

// Sales report.
router.get(
  '/admin/reports/sales',
  authenticate,
  requireManager,
  reportCtrl.salesReport
);

// Inventory report.
router.get(
  '/admin/reports/inventory',
  authenticate,
  requireStaff,
  reportCtrl.inventoryReport
);

// Profit and loss report.
router.get(
  '/admin/reports/profit-loss',
  authenticate,
  requireManager,
  reportCtrl.profitLoss
);

/*
|--------------------------------------------------------------------------
| Supplier Management Routes
|--------------------------------------------------------------------------
*/

// Supplier listing.
router.get(
  '/admin/suppliers',
  authenticate,
  requireStaff,
  supplierCtrl.listSuppliers
);

// Create supplier.
router.post(
  '/admin/suppliers',
  authenticate,
  requireManager,
  supplierCtrl.createSupplier
);

// Update supplier.
router.put(
  '/admin/suppliers/:id',
  authenticate,
  requireManager,
  supplierCtrl.updateSupplier
);

/*
|--------------------------------------------------------------------------
| Purchase Order Routes
|--------------------------------------------------------------------------
*/

// Purchase order listing.
router.get(
  '/admin/purchase-orders',
  authenticate,
  requireStaff,
  supplierCtrl.listPurchaseOrders
);

// Create purchase order.
router.post(
  '/admin/purchase-orders',
  authenticate,
  requireManager,
  supplierCtrl.createPurchaseOrder
);

// Receive purchase order.
router.post(
  '/admin/purchase-orders/:id/receive',
  authenticate,
  requireStaff,
  supplierCtrl.receivePurchaseOrder
);

/*
|--------------------------------------------------------------------------
| Expense Management Routes
|--------------------------------------------------------------------------
*/

// Expense categories.
router.get(
  '/admin/expenses/categories',
  authenticate,
  requireStaff,
  expenseCtrl.categories
);

// Expense listing.
router.get(
  '/admin/expenses',
  authenticate,
  requireManager,
  expenseCtrl.list
);

// Create expense.
router.post(
  '/admin/expenses',
  authenticate,
  requireManager,
  expenseCtrl.create
);

// Update expense.
router.put(
  '/admin/expenses/:id',
  authenticate,
  requireManager,
  expenseCtrl.update
);

// Delete expense.
router.delete(
  '/admin/expenses/:id',
  authenticate,
  requireManager,
  expenseCtrl.remove
);

/*
|--------------------------------------------------------------------------
| Store Settings
|--------------------------------------------------------------------------
*/

router.get('/settings', async (req, res) => {
  try {
    const { Setting } = require('../models');

    const rows = await Setting.find().lean();

    const settings = {};

    for (const row of rows) {
      settings[row.key] = row.value;
    }

    return res.status(200).json({
      settings
    });
  } catch (error) {
    console.error('Settings retrieval failed:', error);

    return res.status(500).json({
      error: 'Failed to load settings.'
    });
  }
});

/*
|--------------------------------------------------------------------------
| Router Export
|--------------------------------------------------------------------------
*/

module.exports = router;