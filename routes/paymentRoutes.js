
'use strict';

const express = require('express');

const router = express.Router();

const mpesaController = require('../controllers/mpesaController');

const requiredMethods = [
  'initiateStk',
  'callback'
];

for (const method of requiredMethods) {
  if (typeof mpesaController[method] !== 'function') {
    throw new Error(
      `M-Pesa controller is missing required method: ${method}`
    );
  }
}

router.post(
  '/mpesa/stk',
  mpesaController.initiateStk
);

router.post(
  '/mpesa/callback',
  mpesaController.callback
);

module.exports = router;