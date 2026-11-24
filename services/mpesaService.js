
function getConfig() {
  const environment = (
    process.env.MPESA_ENVIRONMENT || 'sandbox'
  ).toLowerCase();

  if (!['sandbox', 'production'].includes(environment)) {
    throw new Error(
      'MPESA_ENVIRONMENT must be sandbox or production'
    );
  }

  const baseUrl =
    environment === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';

  const config = {
    baseUrl,
    consumerKey: process.env.MPESA_CONSUMER_KEY,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET,
    shortcode: process.env.MPESA_SHORTCODE,
    passkey: process.env.MPESA_PASSKEY,
    callbackUrl: process.env.MPESA_CALLBACK_URL,
    transactionType:
      process.env.MPESA_TRANSACTION_TYPE ||
      'CustomerPayBillOnline'
  };

  const required = [
    'consumerKey',
    'consumerSecret',
    'shortcode',
    'passkey',
    'callbackUrl'
  ];

  const missing = required.filter(
    key => !config[key] || !String(config[key]).trim()
  );

  if (missing.length) {
    throw new Error(
      `Missing M-Pesa configuration: ${missing.join(', ')}`
    );
  }

  if (!config.callbackUrl.startsWith('https://')) {
    throw new Error(
      'MPESA_CALLBACK_URL must use HTTPS'
    );
  }

  return config;
}

async function parseResponse(response) {
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      data.errorMessage ||
      data.error_description ||
      data.message ||
      `Safaricom request failed (${response.status})`;

    throw new Error(message);
  }

  return data;
}

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

function createStkPassword(shortcode, passkey, timestamp) {
  return Buffer.from(
    `${shortcode}${passkey}${timestamp}`
  ).toString('base64');
}

function normalizePhone(phone) {
  let value = String(phone || '').replace(/\D/g, '');

  if (value.startsWith('0')) {
    value = `254${value.slice(1)}`;
  } else if (
    value.startsWith('7') ||
    value.startsWith('1')
  ) {
    value = `254${value}`;
  }

  if (!/^254(7|1)\d{8}$/.test(value)) {
    throw new Error(
      'Enter a valid Kenyan M-Pesa number, for example 0712345678'
    );
  }

  return value;
}

async function getAccessToken() {
  const config = getConfig();

  const credentials = Buffer.from(
    `${config.consumerKey}:${config.consumerSecret}`
  ).toString('base64');

  const response = await fetch(
    `${config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
    {
      method: 'GET',
      headers: {
        Authorization: `Basic ${credentials}`
      },
      signal: AbortSignal.timeout(20000)
    }
  );

  const data = await parseResponse(response);

  if (!data.access_token) {
    throw new Error(
      'Safaricom did not return an access token'
    );
  }

  return data.access_token;
}

async function initiateStkPush({
  phone,
  amount,
  orderNumber
}) {
  const config = getConfig();

  const normalizedPhone = normalizePhone(phone);
  const numericAmount = Number(amount);

  if (
    !Number.isFinite(numericAmount) ||
    numericAmount < 1
  ) {
    throw new Error('Invalid M-Pesa payment amount');
  }

  if (!orderNumber) {
    throw new Error('Order number is required');
  }

  const accessToken = await getAccessToken();
  const timestamp = getTimestamp();

  const password = createStkPassword(
    config.shortcode,
    config.passkey,
    timestamp
  );

  const payload = {
    BusinessShortCode: config.shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: config.transactionType,
    Amount: Math.round(numericAmount),
    PartyA: normalizedPhone,
    PartyB: config.shortcode,
    PhoneNumber: normalizedPhone,
    CallBackURL: config.callbackUrl,
    AccountReference: String(orderNumber).slice(0, 12),
    TransactionDesc: `Mawego ${orderNumber}`.slice(0, 20)
  };

  const response = await fetch(
    `${config.baseUrl}/mpesa/stkpush/v1/processrequest`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    }
  );

  return parseResponse(response);
}

module.exports = {
  getConfig,
  getAccessToken,
  getTimestamp,
  normalizePhone,
  initiateStkPush
};