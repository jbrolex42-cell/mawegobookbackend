const express = require('express');
const router = express.Router();

const mpesaController = require('../controllers/mpesaController');

// Customer initiates an STK Push.
router.post('/mpesa/stk', mpesaController.initiateStk);

// Safaricom calls this URL after the transaction.
router.post('/mpesa/callback', mpesaController.callback);

module.exports = router;