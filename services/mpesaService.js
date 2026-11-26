
'use strict';

const crypto = require('crypto');

const ENVIRONMENTS = Object.freeze({
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke'
});

const DEFAULT_TRANSACTION_TYPE = 'CustomerPayBillOnline';

const OAUTH_TIMEOUT_MS = 20000;
const STK_TIMEOUT_MS = 30000;
const TOKEN_EXPIRY_BUFFER_MS = 60000;

let cachedAccessToken = null;
let tokenExpiresAt = 0;
let tokenRequestPromise = null;

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------

function getConfig() {
  const environment = String(
    process.env.MPESA_ENVIRONMENT || 'sandbox'
  ).trim().toLowerCase();

  const baseUrl = ENVIRONMENTS[environment];

  if (!baseUrl) {
    throw new Error(
      'MPESA_ENVIRONMENT must be sandbox or production.'
    );
  }

  const config = {
    environment,
    baseUrl,

    consumerKey: String(
      process.env.MPESA_CONSUMER_KEY || ''
    ).trim(),

    consumerSecret: String(
      process.env.MPESA_CONSUMER_SECRET || ''
    ).trim(),

    shortcode: String(
      process.env.MPESA_SHORTCODE || ''
    ).trim(),

    passkey: String(
      process.env.MPESA_PASSKEY || ''
    ).trim(),

    callbackUrl: String(
      process.env.MPESA_CALLBACK_URL || ''
    ).trim(),

    transactionType: String(
      process.env.MPESA_TRANSACTION_TYPE ||
      DEFAULT_TRANSACTION_TYPE
    ).trim()
  };

  const missing = [
    'consumerKey',
    'consumerSecret',
    'shortcode',
    'passkey',
    'callbackUrl'
  ].filter(key => !config[key]);

  if (missing.length) {
    throw new Error(
      `Missing M-Pesa configuration: ${missing.join(', ')}.`
    );
  }

  if (!/^\d+$/.test(config.shortcode)) {
    throw new Error(
      'MPESA_SHORTCODE must contain digits only.'
    );
  }

  let callback;

  try {
    callback = new URL(config.callbackUrl);
  } catch {
    throw new Error(
      'MPESA_CALLBACK_URL must be a valid HTTPS URL.'
    );
  }

  if (
    callback.protocol !== 'https:' ||
    !callback.hostname ||
    callback.username ||
    callback.password
  ) {
    throw new Error(
      'MPESA_CALLBACK_URL must be a valid HTTPS URL.'
    );
  }

  const supportedTypes = [
    'CustomerPayBillOnline',
    'CustomerBuyGoodsOnline'
  ];

  if (!supportedTypes.includes(config.transactionType)) {
    throw new Error(
      'Invalid MPESA_TRANSACTION_TYPE.'
    );
  }

  return Object.freeze(config);
}

// -----------------------------------------------------------------------------
// FETCH AND RESPONSE HELPERS
// -----------------------------------------------------------------------------

function getFetch() {
  if (typeof fetch !== 'function') {
    throw new Error(
      'Node.js 18 or newer is required for M-Pesa requests.'
    );
  }

  return fetch;
}

async function requestWithTimeout(
  url,
  options,
  timeoutMs,
  timeoutMessage,
  uncertain = false
) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    return await getFetch()(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    const timeoutError = new Error(
      error?.name === 'AbortError'
        ? timeoutMessage
        : 'Unable to communicate with Safaricom.'
    );

    timeoutError.code =
      error?.name === 'AbortError'
        ? 'MPESA_REQUEST_TIMEOUT'
        : 'MPESA_NETWORK_ERROR';

    timeoutError.uncertain = Boolean(uncertain);
    timeoutError.cause = error;

    throw timeoutError;
  } finally {
    clearTimeout(timer);
  }
}

async function parseResponse(response) {
  const raw = await response.text();

  let data = {};

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      if (response.ok) {
        throw new Error(
          'Safaricom returned an unreadable response.'
        );
      }
    }
  }

  if (!response.ok) {
    const message =
      data.errorMessage ||
      data.error_description ||
      data.message ||
      `Safaricom returned HTTP ${response.status}.`;

    const error = new Error(message);

    error.statusCode = response.status;

    error.providerCode =
      data.errorCode ||
      data.error_code ||
      null;

    error.providerRequestId =
      data.requestId ||
      null;

    throw error;
  }

  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data)
  ) {
    throw new Error(
      'Invalid response received from Safaricom.'
    );
  }

  return data;
}

// -----------------------------------------------------------------------------
// VALIDATION
// -----------------------------------------------------------------------------

function normalizePhone(phone) {
  if (
    phone === null ||
    phone === undefined ||
    !['string', 'number'].includes(typeof phone)
  ) {
    throw new Error(
      'Enter a valid Kenyan mobile number.'
    );
  }

  let value = String(phone)
    .trim()
    .replace(/[\s()-]/g, '');

  if (value.startsWith('+')) {
    value = value.slice(1);
  }

  if (/^0[17]\d{8}$/.test(value)) {
    value = `254${value.slice(1)}`;
  } else if (/^[17]\d{8}$/.test(value)) {
    value = `254${value}`;
  }

  if (!/^254[17]\d{8}$/.test(value)) {
    throw new Error(
      'Enter a valid Kenyan number starting with 07, 01, 2547 or 2541.'
    );
  }

  return value;
}

function normalizeAmount(amount) {
  const value = Number(amount);

  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new Error(
      'M-Pesa amount must be a positive whole number.'
    );
  }

  return value;
}

function normalizeOrderNumber(orderNumber) {
  const value = String(
    orderNumber || ''
  ).trim();

  if (!value || value.length > 100) {
    throw new Error(
      'A valid order number is required.'
    );
  }

  return value;
}

// -----------------------------------------------------------------------------
// TIMESTAMP AND PASSWORD
// -----------------------------------------------------------------------------

function getTimestamp() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  return (
    values.year +
    values.month +
    values.day +
    values.hour +
    values.minute +
    values.second
  );
}

function createStkPassword(
  shortcode,
  passkey,
  timestamp
) {
  if (!shortcode || !passkey || !timestamp) {
    throw new Error(
      'Unable to generate the M-Pesa STK password.'
    );
  }

  return Buffer.from(
    `${shortcode}${passkey}${timestamp}`,
    'utf8'
  ).toString('base64');
}

// -----------------------------------------------------------------------------
// ACCESS TOKEN
// -----------------------------------------------------------------------------

async function getAccessToken({
  forceRefresh = false
} = {}) {
  if (
    !forceRefresh &&
    cachedAccessToken &&
    Date.now() < tokenExpiresAt
  ) {
    return cachedAccessToken;
  }

  if (!forceRefresh && tokenRequestPromise) {
    return tokenRequestPromise;
  }

  const config = getConfig();

  const credentials = Buffer.from(
    `${config.consumerKey}:${config.consumerSecret}`
  ).toString('base64');

  const request = (async () => {
    const response = await requestWithTimeout(
      `${config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      {
        method: 'GET',
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: 'application/json'
        }
      },
      OAUTH_TIMEOUT_MS,
      'Safaricom authentication request timed out.'
    );

    const data = await parseResponse(response);

    if (
      typeof data.access_token !== 'string' ||
      !data.access_token.trim()
    ) {
      throw new Error(
        'Safaricom did not return an access token.'
      );
    }

    const expiresIn =
      Number(data.expires_in) || 3599;

    cachedAccessToken = data.access_token;

    tokenExpiresAt =
      Date.now() +
      Math.max(
        1000,
        expiresIn * 1000 - TOKEN_EXPIRY_BUFFER_MS
      );

    return cachedAccessToken;
  })();

  tokenRequestPromise = request;

  try {
    return await request;
  } finally {
    if (tokenRequestPromise === request) {
      tokenRequestPromise = null;
    }
  }
}

function clearAccessTokenCache() {
  cachedAccessToken = null;
  tokenExpiresAt = 0;
  tokenRequestPromise = null;
}

// -----------------------------------------------------------------------------
// ACCOUNT REFERENCE
// -----------------------------------------------------------------------------

function createAccountReference(orderNumber) {
  const normalized = normalizeOrderNumber(orderNumber);

  const suffix = crypto
    .createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, 10)
    .toUpperCase();

  // 12 characters, suitable for the Daraja AccountReference field.
  return `MB${suffix}`;
}

// -----------------------------------------------------------------------------
// STK PAYLOAD
// -----------------------------------------------------------------------------

function createStkPayload({
  config,
  phone,
  amount,
  orderNumber,
  timestamp
}) {
  if (!config || !timestamp) {
    throw new Error(
      'M-Pesa STK configuration is incomplete.'
    );
  }

  const normalizedPhone = normalizePhone(phone);
  const normalizedAmount = normalizeAmount(amount);
  const normalizedOrderNumber =
    normalizeOrderNumber(orderNumber);

  return {
    BusinessShortCode: config.shortcode,

    Password: createStkPassword(
      config.shortcode,
      config.passkey,
      timestamp
    ),

    Timestamp: timestamp,

    TransactionType: config.transactionType,

    Amount: normalizedAmount,

    PartyA: normalizedPhone,

    PartyB: config.shortcode,

    PhoneNumber: normalizedPhone,

    CallBackURL: config.callbackUrl,

    AccountReference:
      createAccountReference(normalizedOrderNumber),

    TransactionDesc: 'Book payment'
  };
}

// -----------------------------------------------------------------------------
// INITIATE STK PUSH
// -----------------------------------------------------------------------------

async function initiateStkPush({
  phone,
  amount,
  orderNumber
} = {}) {
  const config = getConfig();

  const normalizedPhone = normalizePhone(phone);
  const normalizedAmount = normalizeAmount(amount);
  const normalizedOrderNumber =
    normalizeOrderNumber(orderNumber);

  const accessToken = await getAccessToken();

  const timestamp = getTimestamp();

  const payload = createStkPayload({
    config,
    phone: normalizedPhone,
    amount: normalizedAmount,
    orderNumber: normalizedOrderNumber,
    timestamp
  });

  const response = await requestWithTimeout(
    `${config.baseUrl}/mpesa/stkpush/v1/processrequest`,
    {
      method: 'POST',

      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },

      body: JSON.stringify(payload)
    },
    STK_TIMEOUT_MS,
    'M-Pesa request timed out. Its status is unknown; check the transaction before retrying.',
    true
  );

  let data;

  try {
    data = await parseResponse(response);
  } catch (error) {
    // A gateway/server error may occur after Safaricom has
    // received the request. Do not assume it was rejected.
    if (
      response.status >= 500 ||
      response.status === 408
    ) {
      error.uncertain = true;
    }

    throw error;
  }

  if (data.ResponseCode === undefined) {
    const error = new Error(
      'Safaricom returned an incomplete STK response. Verify the transaction before retrying.'
    );

    error.uncertain = true;

    throw error;
  }

  if (String(data.ResponseCode) !== '0') {
    const error = new Error(
      data.ResponseDescription ||
      'Safaricom rejected the STK Push request.'
    );

    error.providerCode = data.ResponseCode;
    error.providerDescription =
      data.ResponseDescription || null;

    error.uncertain = false;

    throw error;
  }

  if (
    !data.CheckoutRequestID ||
    !data.MerchantRequestID
  ) {
    const error = new Error(
      'Safaricom may have accepted the payment request, but the payment identifiers were missing. Verify the transaction before retrying.'
    );

    error.uncertain = true;

    throw error;
  }

  return {
    success: true,

    merchantRequestId:
      data.MerchantRequestID,

    checkoutRequestId:
      data.CheckoutRequestID,

    responseCode:
      String(data.ResponseCode),

    responseDescription:
      data.ResponseDescription || '',

    customerMessage:
      data.CustomerMessage || '',

    phone: normalizedPhone,

    amount: normalizedAmount,

    orderNumber: normalizedOrderNumber
  };
}

// -----------------------------------------------------------------------------
// EXPORTS
// -----------------------------------------------------------------------------

module.exports = {
  getConfig,
  getAccessToken,
  clearAccessTokenCache,

  getTimestamp,
  createStkPassword,
  createStkPayload,
  createAccountReference,

  normalizePhone,
  normalizeAmount,
  normalizeOrderNumber,

  initiateStkPush
};