
const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const {
  authenticate,
  optionalAuth,
  requireStaff,
  requireManager
} = require('../middleware/auth');

const authCtrl = require('../controllers/authController');
const productCtrl = require('../controllers/productController');
const orderCtrl = require('../controllers/orderController');
const paymentCtrl = require('../controllers/paymentController');
const mpesaCtrl = require('../controllers/mpesaController');
const reportCtrl = require('../controllers/reportController');
const supplierCtrl = require('../controllers/supplierController');
const expenseCtrl = require('../controllers/expenseController');
const pointsCtrl = require('../controllers/pointsController');
const notificationCtrl = require('../controllers/notificationController');

const {
  productImage,
  resolveImageUrl
} = require('../middleware/upload');

const router = express.Router();

// ======================================================
// UPLOAD DIRECTORY
// ======================================================

const uploadDir = path.join(__dirname, '..', 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// ======================================================
// PASSWORD RESET RATE LIMITER
// ======================================================

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many password reset attempts. Please try again later.'
  }
});

// ======================================================
// CONTROLLER REGISTRATION
// ======================================================

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
  notificationCtrl
};

// ======================================================
// REQUIRED CONTROLLER METHODS
// ======================================================

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

  notificationCtrl: [
    'list',
    'unreadCount',
    'markRead',
    'markAllRead',
    'clearRead',
    'clearAll'
  ]
};

// ======================================================
// CONTROLLER VALIDATION
// ======================================================

const missingMethods = [];

for (const [controllerName, methods] of Object.entries(requiredMethods)) {
  const controller = controllers[controllerName];

  for (const method of methods) {
    if (!controller || typeof controller[method] !== 'function') {
      missingMethods.push(`${controllerName}.${method}`);
    }
  }
}

if (missingMethods.length > 0) {
  console.error('\n❌ Missing controller functions:');

  missingMethods.forEach((method) => {
    console.error(`   - ${method}`);
  });

  console.error('\nCheck the controller exports before starting the server.\n');

  throw new Error('Controller validation failed');
}

// ======================================================
// AUTHENTICATION
// ======================================================

// Customer registration
router.post('/auth/register', authCtrl.register);

// Customer login
router.post('/auth/login', authCtrl.login);

// Forgot password
router.post(
  '/auth/forgot-password',
  passwordResetLimiter,
  authCtrl.forgotPassword
);

// Reset password
router.post(
  '/auth/reset-password',
  passwordResetLimiter,
  authCtrl.resetPassword
);

// Logged-in customer information
router.get(
  '/auth/me',
  authenticate,
  authCtrl.me
);

// Logged-in customer orders
router.get(
  '/auth/my-orders',
  authenticate,
  authCtrl.myOrders
);

// ======================================================
// STAFF MANAGEMENT
// ======================================================

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

// ======================================================
// LOYALTY POINTS
// ======================================================

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

// ======================================================
// NOTIFICATIONS
// ======================================================

router.get(
  '/notifications',
  authenticate,
  notificationCtrl.list
);

router.get(
  '/notifications/unread-count',
  authenticate,
  notificationCtrl.unreadCount
);

router.patch(
  '/notifications/:id/read',
  authenticate,
  notificationCtrl.markRead
);

router.post(
  '/notifications/read-all',
  authenticate,
  notificationCtrl.markAllRead
);

router.delete(
  '/notifications/clear-read',
  authenticate,
  notificationCtrl.clearRead
);

router.delete(
  '/notifications/clear-all',
  authenticate,
  notificationCtrl.clearAll
);

// ======================================================
// PUBLIC PRODUCTS AND CATEGORIES
// ======================================================

router.get(
  '/categories',
  productCtrl.categories
);

router.get(
  '/products',
  productCtrl.listPublic
);

router.get(
  '/products/:slug',
  productCtrl.getBySlug
);

// ======================================================
// ADMIN CATEGORY MANAGEMENT
// ======================================================

router.get(
  '/admin/categories',
  authenticate,
  requireStaff,
  productCtrl.listCategoriesAdmin
);

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

router.delete(
  '/admin/categories/:id/image',
  authenticate,
  requireStaff,
  productCtrl.removeCategoryImage
);

// ======================================================
// ORDERS
// ======================================================

router.post(
  '/orders',
  optionalAuth,
  orderCtrl.create
);

router.get(
  '/orders/track/:orderNumber',
  orderCtrl.getByNumber
);
// ======================================================
// RECEIPTS
// ======================================================

// Use the receipt router that reads existing MongoDB orders
// and returns { success: true, receipt: { ... } }.

router.use(
  '/receipts',
  require('./receiptRoutes')
);

router.post(
  '/payments/mpesa/stk',
  optionalAuth,
  mpesaCtrl.initiateStk
);

// Safaricom payment callback.
// This must remain public because Safaricom calls it.
router.post(
  '/payments/mpesa/callback',
  mpesaCtrl.callback
);

// Card payments
router.post(
  '/payments/card/initiate',
  paymentCtrl.cardInitiate
);

router.get(
  '/payments/card/callback',
  paymentCtrl.cardCallback
);

router.post(
  '/payments/card/callback',
  paymentCtrl.cardCallback
);

// ======================================================
// ADMIN PRODUCTS
// ======================================================

router.get(
  '/admin/products',
  authenticate,
  requireStaff,
  productCtrl.listAdmin
);

router.post(
  '/admin/products',
  authenticate,
  requireStaff,
  productImage(),
  resolveImageUrl,
  productCtrl.create
);

router.put(
  '/admin/products/:id',
  authenticate,
  requireStaff,
  productImage(),
  resolveImageUrl,
  productCtrl.update
);

router.post(
  '/admin/products/:id/stock',
  authenticate,
  requireStaff,
  productCtrl.adjustStock
);

router.get(
  '/admin/products/:id/ledger',
  authenticate,
  requireStaff,
  productCtrl.stockLedger
);

router.delete(
  '/admin/products/:id',
  authenticate,
  requireManager,
  productCtrl.remove
);

router.post(
  '/admin/products/import',
  authenticate,
  requireManager,
  productCtrl.bulkImport
);

// ======================================================
// ADMIN ORDERS
// ======================================================

router.get(
  '/admin/orders',
  authenticate,
  requireStaff,
  orderCtrl.listAdmin
);

router.get(
  '/admin/orders/:id',
  authenticate,
  requireStaff,
  orderCtrl.getAdmin
);

router.patch(
  '/admin/orders/:id',
  authenticate,
  requireStaff,
  orderCtrl.updateStatus
);

router.post(
  '/admin/orders/:id/mark-paid',
  authenticate,
  requireStaff,
  paymentCtrl.adminMarkPaid
);

// ======================================================
// REPORTS
// ======================================================

router.get(
  '/admin/dashboard',
  authenticate,
  requireStaff,
  reportCtrl.dashboard
);

router.get(
  '/admin/reports/sales',
  authenticate,
  requireManager,
  reportCtrl.salesReport
);

router.get(
  '/admin/reports/inventory',
  authenticate,
  requireStaff,
  reportCtrl.inventoryReport
);

router.get(
  '/admin/reports/profit-loss',
  authenticate,
  requireManager,
  reportCtrl.profitLoss
);

// ======================================================
// SUPPLIERS AND PURCHASE ORDERS
// ======================================================

router.get(
  '/admin/suppliers',
  authenticate,
  requireStaff,
  supplierCtrl.listSuppliers
);

router.post(
  '/admin/suppliers',
  authenticate,
  requireManager,
  supplierCtrl.createSupplier
);

router.put(
  '/admin/suppliers/:id',
  authenticate,
  requireManager,
  supplierCtrl.updateSupplier
);

router.get(
  '/admin/purchase-orders',
  authenticate,
  requireStaff,
  supplierCtrl.listPurchaseOrders
);

router.post(
  '/admin/purchase-orders',
  authenticate,
  requireManager,
  supplierCtrl.createPurchaseOrder
);

router.post(
  '/admin/purchase-orders/:id/receive',
  authenticate,
  requireStaff,
  supplierCtrl.receivePurchaseOrder
);

// ======================================================
// EXPENSES
// ======================================================

router.get(
  '/admin/expenses/categories',
  authenticate,
  requireStaff,
  expenseCtrl.categories
);

router.get(
  '/admin/expenses',
  authenticate,
  requireManager,
  expenseCtrl.list
);

router.post(
  '/admin/expenses',
  authenticate,
  requireManager,
  expenseCtrl.create
);

router.put(
  '/admin/expenses/:id',
  authenticate,
  requireManager,
  expenseCtrl.update
);

router.delete(
  '/admin/expenses/:id',
  authenticate,
  requireManager,
  expenseCtrl.remove
);

// ======================================================
// PUBLIC SETTINGS
// ======================================================

router.get('/settings', async (req, res) => {
  try {
    const { Setting } = require('../models');

    const rows = await Setting.find();
    const settings = {};

    rows.forEach((row) => {
      settings[row.key] = row.value;
    });

    res.json({ settings });

  } catch (error) {
    console.error('Settings error:', error.message);

    res.status(500).json({
      error: 'Failed to load settings'
    });
  }
});

// ======================================================
// EXPORT ROUTER
// ======================================================

module.exports = router;