
'use strict';

const express = require('express');

const router = express.Router();

const mpesaController = require('../controllers/mpesaController');

/*
|--------------------------------------------------------------------------
| Controller Validation
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| M-Pesa STK Push
|--------------------------------------------------------------------------
|
| Initiates an STK Push payment request.
| Customer and order validation must happen inside the controller.
|
*/

router.post(
  '/mpesa/stk',
  mpesaController.initiateStk
);

/*
|--------------------------------------------------------------------------
| M-Pesa Callback
|--------------------------------------------------------------------------
|
| Receives asynchronous payment results from Safaricom Daraja.
| This endpoint must remain accessible to Safaricom without
| customer JWT authentication.
|
*/

router.post(
  '/mpesa/callback',
  mpesaController.callback
);

/*
|--------------------------------------------------------------------------
| Export
|--------------------------------------------------------------------------
*/

module.exports = router;