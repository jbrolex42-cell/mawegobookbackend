
'use strict';

/**
 * =============================================================================
 * MAWEGO BOOKSHOP - SAFARICOM DARAJA M-PESA SERVICE
 * =============================================================================
 *
 * Features:
 * - Safaricom Daraja OAuth authentication
 * - Sandbox and production environments
 * - Cached OAuth access tokens
 * - Concurrent token-request protection
 * - M-Pesa STK Push
 * - Kenyan mobile number normalization (07 and 01)
 * - Nairobi timezone timestamps
 * - STK password generation
 * - Request timeout protection
 * - Response validation
 * - Configuration validation
 * - Safe provider error handling
 *
 * Supported Kenyan phone formats:
 *
 * 0712345678
 * 0112345678
 * 712345678
 * 112345678
 * 254712345678
 * 254112345678
 * +254712345678
 * +254112345678
 *
 * IMPORTANT:
 * - Never expose Daraja credentials to frontend JavaScript.
 * - Keep credentials in the backend .env file.
 * - Save CheckoutRequestID against the relevant order.
 * - Never assume a timeout means a payment failed.
 * - Confirm payment using the Safaricom callback.
 *
 * =============================================================================
 */

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const ENVIRONMENTS = Object.freeze({
  SANDBOX: 'sandbox',
  PRODUCTION: 'production'
});

const BASE_URLS = Object.freeze({
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke'
});

const DEFAULT_TRANSACTION_TYPE = 'CustomerPayBillOnline';

const OAUTH_TIMEOUT = 20000;
const STK_TIMEOUT = 30000;

const DEFAULT_TOKEN_LIFETIME = 3599;
const TOKEN_EXPIRY_BUFFER = 60000;

const MAX_ORDER_REFERENCE_LENGTH = 12;
const MAX_TRANSACTION_DESCRIPTION_LENGTH = 20;

/* -------------------------------------------------------------------------- */
/* OAuth Token Cache                                                          */
/* -------------------------------------------------------------------------- */

// Cached only in this Node.js process.
// A multi-instance deployment has a separate cache per instance.
let cachedAccessToken = null;
let tokenExpiresAt = 0;
let tokenRequestPromise = null;

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

function getConfig() {
  const environment = String(
    process.env.MPESA_ENVIRONMENT || 'sandbox'
  ).trim().toLowerCase();

  if (!Object.values(ENVIRONMENTS).includes(environment)) {
    throw new Error(
      'MPESA_ENVIRONMENT must be sandbox or production.'
    );
  }

  const config = {
    environment,
    baseUrl: BASE_URLS[environment],

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

  const requiredFields = [
    'consumerKey',
    'consumerSecret',
    'shortcode',
    'passkey',
    'callbackUrl'
  ];

  const missingFields = requiredFields.filter(
    field => !config[field]
  );

  if (missingFields.length) {
    throw new Error(
      `Missing M-Pesa configuration: ${missingFields.join(', ')}.`
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
      'MPESA_CALLBACK_URL must be a valid URL.'
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

  if (
    ![
      'CustomerPayBillOnline',
      'CustomerBuyGoodsOnline'
    ].includes(config.transactionType)
  ) {
    throw new Error(
      'Invalid MPESA_TRANSACTION_TYPE.'
    );
  }

  return Object.freeze(config);
}

/* -------------------------------------------------------------------------- */
/* Fetch Support                                                              */
/* -------------------------------------------------------------------------- */

function getFetch() {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error(
      'Global fetch is unavailable. Use Node.js 18 or newer.'
    );
  }

  return globalThis.fetch;
}

/* -------------------------------------------------------------------------- */
/* Request Timeout                                                            */
/* -------------------------------------------------------------------------- */

function createTimeout(timeoutMs, message) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,

    clear() {
      clearTimeout(timer);
    },

    timeoutError() {
      return new Error(message);
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Phone Number Normalization                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Normalizes Kenyan mobile numbers into:
 *
 * 2547XXXXXXXX
 * 2541XXXXXXXX
 *
 * Accepts:
 * - 07XXXXXXXX
 * - 01XXXXXXXX
 * - 7XXXXXXXX
 * - 1XXXXXXXX
 * - 2547XXXXXXXX
 * - 2541XXXXXXXX
 * - +2547XXXXXXXX
 * - +2541XXXXXXXX
 *
 * Spaces, brackets and hyphens are accepted.
 *
 * This function intentionally supports Kenyan mobile numbers only.
 */
function normalizePhone(phone) {
  if (
    phone === null ||
    phone === undefined ||
    (
      typeof phone !== 'string' &&
      typeof phone !== 'number'
    )
  ) {
    throw new Error(
      'Enter a valid Kenyan mobile number.'
    );
  }

  let value = String(phone)
    .trim()
    .replace(/[\s()-]/g, '');

  if (!value || value.length > 20) {
    throw new Error(
      'Enter a valid Kenyan mobile number.'
    );
  }

  if (value.startsWith('+')) {
    value = value.slice(1);
  }

  // Local format: 07XXXXXXXX or 01XXXXXXXX.
  if (/^0[17]\d{8}$/.test(value)) {
    value = `254${value.slice(1)}`;
  }

  // National format without the leading zero.
  else if (/^[17]\d{8}$/.test(value)) {
    value = `254${value}`;
  }

  // Final international format validation.
  if (!/^254[17]\d{8}$/.test(value)) {
    throw new Error(
      'Enter a valid Kenyan mobile number starting with 07, 01, 2547 or 2541.'
    );
  }

  return value;
}

/* -------------------------------------------------------------------------- */
/* Amount Validation                                                          */
/* -------------------------------------------------------------------------- */

function normalizeAmount(amount) {
  if (
    amount === null ||
    amount === undefined ||
    amount === ''
  ) {
    throw new Error(
      'M-Pesa payment amount is required.'
    );
  }

  const numericAmount = Number(amount);

  if (
    !Number.isSafeInteger(numericAmount) ||
    numericAmount < 1
  ) {
    throw new Error(
      'M-Pesa amount must be a positive whole number.'
    );
  }

  return numericAmount;
}

/* -------------------------------------------------------------------------- */
/* Order Reference Validation                                                */
/* -------------------------------------------------------------------------- */

function normalizeOrderNumber(orderNumber) {
  const value = String(orderNumber || '').trim();

  if (!value) {
    throw new Error(
      'Order number is required.'
    );
  }

  if (value.length > 100) {
    throw new Error(
      'Order number is too long.'
    );
  }

  return value;
}

/* -------------------------------------------------------------------------- */
/* Nairobi Timestamp                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Returns the current Nairobi timestamp:
 *
 * YYYYMMDDHHmmss
 */
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

/* -------------------------------------------------------------------------- */
/* STK Password                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Daraja STK password:
 *
 * Base64(Shortcode + Passkey + Timestamp)
 */
function createStkPassword(shortcode, passkey, timestamp) {
  if (!shortcode || !passkey || !timestamp) {
    throw new Error(
      'Unable to generate M-Pesa STK password.'
    );
  }

  return Buffer.from(
    `${shortcode}${passkey}${timestamp}`,
    'utf8'
  ).toString('base64');
}

/* -------------------------------------------------------------------------- */
/* Response Parsing                                                           */
/* -------------------------------------------------------------------------- */

async function parseResponse(response) {
  let rawBody = '';

  try {
    rawBody = await response.text();
  } catch {
    throw new Error(
      'Unable to read the Safaricom response.'
    );
  }

  let data = {};

  if (rawBody) {
    try {
      data = JSON.parse(rawBody);
    } catch {
      if (response.ok) {
        throw new Error(
          'Safaricom returned an invalid response.'
        );
      }
    }
  }

  if (!response.ok) {
    const message =
      data.errorMessage ||
      data.error_description ||
      data.message ||
      `Safaricom request failed with HTTP ${response.status}.`;

    const error = new Error(message);

    error.statusCode = response.status;

    error.providerResponse = {
      requestId: data.requestId || null,
      errorCode: data.errorCode || null
    };

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

/* -------------------------------------------------------------------------- */
/* OAuth Token Generation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Requests a Daraja OAuth access token.
 *
 * Tokens are cached until shortly before expiration.
 * Concurrent requests share the same token request.
 */
async function getAccessToken({ forceRefresh = false } = {}) {
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
  const fetchImpl = getFetch();

  const credentials = Buffer.from(
    `${config.consumerKey}:${config.consumerSecret}`,
    'utf8'
  ).toString('base64');

  const timeout = createTimeout(
    OAUTH_TIMEOUT,
    'Safaricom authentication request timed out.'
  );

  const requestPromise = (async () => {
    try {
      const response = await fetchImpl(
        `${config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
        {
          method: 'GET',

          headers: {
            Authorization: `Basic ${credentials}`,
            Accept: 'application/json'
          },

          signal: timeout.signal
        }
      );

      const data = await parseResponse(response);

      if (
        typeof data.access_token !== 'string' ||
        !data.access_token.trim()
      ) {
        throw new Error(
          'Safaricom did not return a valid access token.'
        );
      }

      const lifetime = Number(data.expires_in);

      const expiresInSeconds =
        Number.isFinite(lifetime) && lifetime > 0
          ? lifetime
          : DEFAULT_TOKEN_LIFETIME;

      cachedAccessToken = data.access_token;

      tokenExpiresAt =
        Date.now() +
        Math.max(
          1000,
          expiresInSeconds * 1000 - TOKEN_EXPIRY_BUFFER
        );

      return cachedAccessToken;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw timeout.timeoutError();
      }

      throw error;
    } finally {
      timeout.clear();
    }
  })();

  tokenRequestPromise = requestPromise;

  try {
    return await requestPromise;
  } finally {
    if (tokenRequestPromise === requestPromise) {
      tokenRequestPromise = null;
    }
  }
}

/**
 * Clears the in-memory OAuth token cache.
 *
 * Useful for controlled refreshes and automated tests.
 */
function clearAccessTokenCache() {
  cachedAccessToken = null;
  tokenExpiresAt = 0;
  tokenRequestPromise = null;
}

/* -------------------------------------------------------------------------- */
/* STK Payload                                                                */
/* -------------------------------------------------------------------------- */

function createStkPayload({
  config,
  phone,
  amount,
  orderNumber,
  timestamp
}) {
  if (!config || typeof config !== 'object') {
    throw new Error(
      'M-Pesa configuration is required.'
    );
  }

  const normalizedPhone = normalizePhone(phone);
  const normalizedAmount = normalizeAmount(amount);
  const normalizedOrderNumber =
    normalizeOrderNumber(orderNumber);

  const password = createStkPassword(
    config.shortcode,
    config.passkey,
    timestamp
  );

  const accountReference = normalizedOrderNumber
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, MAX_ORDER_REFERENCE_LENGTH);

  const transactionDescription = (
    `Mawego ${normalizedOrderNumber}`
  )
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .slice(0, MAX_TRANSACTION_DESCRIPTION_LENGTH);

  if (!accountReference) {
    throw new Error(
      'Invalid order reference for M-Pesa payment.'
    );
  }

  return {
    BusinessShortCode: config.shortcode,

    Password: password,

    Timestamp: timestamp,

    TransactionType: config.transactionType,

    Amount: normalizedAmount,

    PartyA: normalizedPhone,

    PartyB: config.shortcode,

    PhoneNumber: normalizedPhone,

    CallBackURL: config.callbackUrl,

    AccountReference: accountReference,

    TransactionDesc:
      transactionDescription || 'Bookshop payment'
  };
}

/* -------------------------------------------------------------------------- */
/* Initiate STK Push                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Initiates a Safaricom Daraja STK Push.
 *
 * Input:
 *
 * {
 *   phone: '0712345678',
 *   amount: 100,
 *   orderNumber: 'ORD-1001'
 * }
 *
 * Returns:
 *
 * {
 *   success,
 *   merchantRequestId,
 *   checkoutRequestId,
 *   responseCode,
 *   responseDescription,
 *   customerMessage,
 *   phone,
 *   amount,
 *   orderNumber
 * }
 *
 * IMPORTANT:
 * Persist checkoutRequestId against the order.
 *
 * A successful STK initiation is NOT proof of payment.
 * Only mark an order as paid after verifying the callback.
 */
async function initiateStkPush({
  phone,
  amount,
  orderNumber
} = {}) {
  const config = getConfig();
  const fetchImpl = getFetch();

  const normalizedPhone = normalizePhone(phone);
  const numericAmount = normalizeAmount(amount);

  const normalizedOrderNumber =
    normalizeOrderNumber(orderNumber);

  const accessToken = await getAccessToken();

  const timestamp = getTimestamp();

  const payload = createStkPayload({
    config,
    phone: normalizedPhone,
    amount: numericAmount,
    orderNumber: normalizedOrderNumber,
    timestamp
  });

  const timeout = createTimeout(
    STK_TIMEOUT,
    'M-Pesa STK Push request timed out. Check the transaction status before retrying.'
  );

  try {
    const response = await fetchImpl(
      `${config.baseUrl}/mpesa/stkpush/v1/processrequest`,
      {
        method: 'POST',

        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },

        body: JSON.stringify(payload),

        signal: timeout.signal
      }
    );

    const data = await parseResponse(response);

    if (
      data.ResponseCode !== undefined &&
      String(data.ResponseCode) !== '0'
    ) {
      throw new Error(
        data.ResponseDescription ||
        'Safaricom rejected the STK Push request.'
      );
    }

    if (
      !data.CheckoutRequestID ||
      !data.MerchantRequestID
    ) {
      throw new Error(
        'Safaricom response is missing payment request identifiers.'
      );
    }

    return {
      success: true,

      merchantRequestId: data.MerchantRequestID,

      checkoutRequestId: data.CheckoutRequestID,

      responseCode: data.ResponseCode,

      responseDescription:
        data.ResponseDescription || '',

      customerMessage:
        data.CustomerMessage || '',

      phone: normalizedPhone,

      amount: numericAmount,

      orderNumber: normalizedOrderNumber
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw timeout.timeoutError();
    }

    throw error;
  } finally {
    timeout.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  getConfig,

  getAccessToken,

  clearAccessTokenCache,

  getTimestamp,

  createStkPassword,

  createStkPayload,

  normalizePhone,

  normalizeAmount,

  normalizeOrderNumber,

  initiateStkPush
};