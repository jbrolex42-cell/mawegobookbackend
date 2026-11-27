
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const {
  authenticate,
  requireStaff,
  requireManager
} = require('../middleware/auth');

const newsletterController = require('../controllers/newsletterController');

const router = express.Router();

const subscribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'Too many subscription attempts. Please try again later.'
  }
});

// Public newsletter endpoints
router.post(
  '/subscribe',
  subscribeLimiter,
  newsletterController.subscribe
);

router.get(
  '/verify',
  newsletterController.verifySubscription
);

router.get(
  '/unsubscribe',
  newsletterController.showUnsubscribe
);

router.post(
  '/unsubscribe',
  newsletterController.unsubscribe
);

// Staff newsletter management
router.get(
  '/admin/stats',
  authenticate,
  requireStaff,
  newsletterController.getStats
);

router.get(
  '/admin/subscribers',
  authenticate,
  requireStaff,
  newsletterController.getSubscribers
);

router.get(
  '/admin/campaigns',
  authenticate,
  requireStaff,
  newsletterController.getCampaigns
);

// Manager/owner campaign operations
router.post(
  '/admin/campaigns',
  authenticate,
  requireManager,
  newsletterController.createCampaign
);

router.post(
  '/admin/campaigns/:id/send',
  authenticate,
  requireManager,
  newsletterController.sendCampaign
);

module.exports = router;