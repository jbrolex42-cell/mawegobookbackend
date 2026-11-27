
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

router.use('/newsletter',require('./newsletterRoutes'));

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many password reset attempts. Please try again later.'
  }
});

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
    'list',
    'update',
    'remove'
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

router.post(
  '/auth/register',
  authCtrl.register
);

router.post(
  '/auth/login',
  authCtrl.login
);

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

router.get(
  '/auth/me',
  authenticate,
  authCtrl.me
);

router.get(
  '/auth/my-orders',
  authenticate,
  authCtrl.myOrders
);

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

router.get(
  '/categories',
  productCtrl.categories
);

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

router.get(
  '/products',
  productCtrl.listPublic
);

router.get(
  '/products/:slug',
  productCtrl.getBySlug
);

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

router.post(
  '/promos/validate',
  optionalAuth,
  promoCtrl.validate
);

router.get(
  '/admin/promos',
  authenticate,
  requireManager,
  promoCtrl.list
);

router.post(
  '/admin/promos',
  authenticate,
  requireManager,
  promoCtrl.create
);

router.post(
  '/orders',
  optionalAuth,
  orderCtrl.create
);

router.get(
  '/orders/track/:orderNumber',
  orderCtrl.getByNumber
);

router.get(
  '/orders/:id/status',
  authenticate,
  orderCtrl.getCustomerStatus
);

router.post(
  '/orders/:id/cancel',
  authenticate,
  orderCtrl.cancelCustomerOrder
);

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

router.use(
  '/receipts',
  require('./receiptRoutes')
);

router.post(
  '/payments/mpesa/stk',
  optionalAuth,
  mpesaCtrl.initiateStk
);

router.post(
  '/payments/mpesa/callback',
  mpesaCtrl.callback
);

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

router.put(
  '/admin/promos/:id',
  authenticate,
  requireManager,
  promoCtrl.update
);

router.delete(
  '/admin/promos/:id',
  authenticate,
  requireManager,
  promoCtrl.remove
);

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

module.exports = router;