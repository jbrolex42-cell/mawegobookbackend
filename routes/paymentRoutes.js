const express = require('express');
const router = express.Router();

const mpesaController = require('../controllers/mpesaController');

router.post('/mpesa/stk', mpesaController.initiateStk);

router.post('/mpesa/callback', mpesaController.callback);

module.exports = router;