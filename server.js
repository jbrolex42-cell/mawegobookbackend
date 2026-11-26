
'use strict';

require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env')
});

const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const fs = require('fs');

// Application modules
const { connectMongo } = require('./config/mongo');
const { Setting } = require('./models');

// ============================================================
// APPLICATION CONFIGURATION
// ============================================================

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

const ROOT_PATH = path.join(__dirname, '..');
const FRONTEND_PATH = path.join(ROOT_PATH, 'frontend');
const UPLOADS_PATH = path.join(__dirname, 'uploads');

const SHUTDOWN_TIMEOUT = 10000;

// Render runs the application behind a reverse proxy.
// Default to one trusted proxy hop on Render/production.
const TRUST_PROXY_HOPS =
  process.env.TRUST_PROXY_HOPS !== undefined
    ? Number(process.env.TRUST_PROXY_HOPS)
    : (IS_PRODUCTION || process.env.RENDER === 'true' ? 1 : 0);

// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

function validateEnvironment() {
  const requiredVariables = [
    'MONGODB_URI',
    'JWT_SECRET'
  ];

  for (const variable of requiredVariables) {
    if (!process.env[variable]) {
      throw new Error(
        `${variable} environment variable is required.`
      );
    }
  }

  if (IS_PRODUCTION) {
    if (
      process.env.JWT_SECRET.length < 32 ||
      process.env.JWT_SECRET.includes('change-this')
    ) {
      throw new Error(
        'Production JWT_SECRET must contain at least 32 characters and cannot be a placeholder.'
      );
    }

    if (
      !process.env.ADMIN_PASSWORD ||
      process.env.ADMIN_PASSWORD === 'MawegoAdmin2024!'
    ) {
      console.warn(
        '[SECURITY WARNING] Configure a strong administrator password.'
      );
    }

    if (process.env.CORS_ORIGIN === '*') {
      throw new Error(
        'Wildcard CORS is not permitted in production.'
      );
    }
  }

  if (
    !Number.isInteger(TRUST_PROXY_HOPS) ||
    TRUST_PROXY_HOPS < 0 ||
    TRUST_PROXY_HOPS > 10
  ) {
    throw new Error(
      'TRUST_PROXY_HOPS must be an integer between 0 and 10.'
    );
  }

  if (
    process.env.CORS_ORIGIN &&
    typeof process.env.CORS_ORIGIN !== 'string'
  ) {
    throw new Error(
      'CORS_ORIGIN must be a comma-separated string.'
    );
  }

  if (
    !Number.isInteger(PORT) ||
    PORT < 1 ||
    PORT > 65535
  ) {
    throw new Error('Invalid server PORT configuration.');
  }
}

// ============================================================
// SECURITY MIDDLEWARE
// ============================================================

app.disable('x-powered-by');

// IMPORTANT:
// Render forwards the original client IP using X-Forwarded-For.
// Trust only the configured number of proxy hops.
app.set(
  'trust proxy',
  TRUST_PROXY_HOPS > 0
    ? TRUST_PROXY_HOPS
    : false
);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  res.setHeader(
    'Referrer-Policy',
    'strict-origin-when-cross-origin'
  );

  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );

  res.setHeader('X-XSS-Protection', '0');

  if (IS_PRODUCTION) {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains'
    );
  }

  next();
});

// ============================================================
// CORS CONFIGURATION
// ============================================================

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean)
  : true;

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS'
  ],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With'
  ]
}));

// ============================================================
// REQUEST PARSING
// ============================================================

app.use(express.json({
  limit: '10mb'
}));

app.use(express.urlencoded({
  extended: true,
  limit: '10mb'
}));

// ============================================================
// RATE LIMITING
// ============================================================

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PRODUCTION ? 300 : 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests. Please try again later.'
  }
});

const authenticationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PRODUCTION ? 30 : 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many authentication attempts. Please try again later.'
  }
});

app.use('/api/', generalLimiter);

app.use(
  '/api/auth/login',
  authenticationLimiter
);

app.use(
  '/api/auth/register',
  authenticationLimiter
);

// ============================================================
// UPLOAD DIRECTORY
// ============================================================

function initializeDirectories() {
  fs.mkdirSync(UPLOADS_PATH, {
    recursive: true
  });
}

app.use('/uploads', express.static(UPLOADS_PATH, {
  maxAge: IS_PRODUCTION ? '7d' : 0,
  etag: true,
  index: false,
  dotfiles: 'deny'
}));

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/api/health', (req, res) => {
  const databaseConnected =
    mongoose.connection.readyState === 1;

  const status = databaseConnected
    ? 'ok'
    : 'degraded';

  res.status(databaseConnected ? 200 : 503).json({
    success: databaseConnected,
    status,
    service: 'mawego-bookshop',
    environment: NODE_ENV,
    database: databaseConnected
      ? 'connected'
      : 'disconnected',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// API ROUTES
// ============================================================

app.use('/api', require('./routes'));

app.use(
  '/api/receipt-emails',
  require('./routes/receiptEmailRoutes')
);

// ============================================================
// PUBLIC SETTINGS
// ============================================================

app.get('/api/settings', async (req, res, next) => {
  try {
    const rows = await Setting.find().lean();

    const settings = {};

    for (const row of rows) {
      settings[row.key] = row.value;
    }

    return res.status(200).json({
      success: true,
      settings
    });

  } catch (error) {
    return next(error);
  }
});

// ============================================================
// FRONTEND STATIC FILES
// ============================================================

app.use(express.static(FRONTEND_PATH, {
  maxAge: IS_PRODUCTION ? '1d' : 0,
  etag: true,
  index: false,
  dotfiles: 'deny'
}));

// ============================================================
// API 404 HANDLER
// ============================================================

app.use('/api', (req, res) => {
  return res.status(404).json({
    success: false,
    error: 'API endpoint not found'
  });
});

// ============================================================
// FRONTEND ROUTING
// ============================================================

app.get('*', (req, res, next) => {
  let decodedPath;

  try {
    decodedPath = decodeURIComponent(req.path);
  } catch (error) {
    return res.status(400).send('Invalid URL');
  }

  if (
    decodedPath.startsWith('/uploads/') ||
    decodedPath === '/uploads'
  ) {
    return res.status(404).send('Not found');
  }

  const requestedPath = path.resolve(
    FRONTEND_PATH,
    `.${decodedPath}`
  );

  // Prevent access outside the frontend directory.
  if (
    requestedPath !== FRONTEND_PATH &&
    !requestedPath.startsWith(FRONTEND_PATH + path.sep)
  ) {
    return res.status(403).send('Forbidden');
  }

  const filePath = decodedPath === '/'
    ? path.join(FRONTEND_PATH, 'index.html')
    : requestedPath;

  res.sendFile(filePath, error => {
    if (!error) {
      return;
    }

    res.sendFile(
      path.join(FRONTEND_PATH, 'pages', '404.html'),
      fallbackError => {
        if (fallbackError && !res.headersSent) {
          res.status(404).send('Page not found');
        }
      }
    );
  });
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  console.error('[SERVER ERROR]', {
    method: req.method,
    path: req.path,
    message: error.message,
    timestamp: new Date().toISOString()
  });

  // Malformed JSON.
  if (
    error instanceof SyntaxError &&
    error.status === 400 &&
    'body' in error
  ) {
    return res.status(400).json({
      success: false,
      error: 'Invalid JSON request body.'
    });
  }

  // Request payload too large.
  if (error.status === 413) {
    return res.status(413).json({
      success: false,
      error: 'Request payload is too large.'
    });
  }

  // Upload and file validation errors.
  if (
    /multer|file type|file size|image upload/i.test(
      error.message
    )
  ) {
    return res.status(400).json({
      success: false,
      error: IS_PRODUCTION
        ? 'Invalid file upload.'
        : error.message
    });
  }

  const statusCode =
    error.status >= 400 && error.status < 500
      ? error.status
      : 500;

  return res.status(statusCode).json({
    success: false,
    error: IS_PRODUCTION
      ? 'Something went wrong. Please try again.'
      : error.message || 'Internal server error.'
  });
});

// ============================================================
// DATABASE INITIALIZATION
// ============================================================

async function initializeDatabase() {
  console.log(
    '[DATABASE] Initializing Mawego Bookshop...'
  );

  const { init } = require('./utils/initDb');

  if (typeof init === 'function') {
    await init();
  }

  console.log(
    '[DATABASE] Initialization completed.'
  );
}

// ============================================================
// SERVER LIFECYCLE
// ============================================================

let server = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`\n[SERVER] ${signal} received.`);
  console.log('[SERVER] Starting graceful shutdown...');

  const forceExit = setTimeout(() => {
    console.error(
      '[SERVER] Shutdown timeout exceeded.'
    );

    process.exit(1);
  }, SHUTDOWN_TIMEOUT);

  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close(error => {
          if (error) {
            return reject(error);
          }

          return resolve();
        });
      });
    }

    await mongoose.disconnect();

    clearTimeout(forceExit);

    console.log('[DATABASE] MongoDB disconnected.');
    console.log(
      '[SERVER] Shutdown completed successfully.'
    );

    process.exit(0);

  } catch (error) {
    clearTimeout(forceExit);

    console.error(
      '[SERVER] Shutdown failed:',
      error.message
    );

    process.exit(1);
  }
}

// ============================================================
// APPLICATION STARTUP
// ============================================================

async function start() {
  try {
    console.log('');
    console.log('========================================');
    console.log('       MAWEGO BOOKSHOP ONLINE');
    console.log('========================================');

    console.log(
      '[STARTUP] Validating configuration...'
    );

    validateEnvironment();

    initializeDirectories();

    console.log(
      `[SECURITY] Trusted proxy hops: ${TRUST_PROXY_HOPS}`
    );

    console.log(
      '[STARTUP] Connecting to MongoDB...'
    );

    await connectMongo();

    console.log(
      '[DATABASE] Connected successfully.'
    );

    await initializeDatabase();

    server = app.listen(PORT, () => {
      console.log('');
      console.log('========================================');
      console.log('       MAWEGO BOOKSHOP ONLINE');
      console.log('========================================');
      console.log(`Environment : ${NODE_ENV}`);
      console.log(`Port        : ${PORT}`);
      console.log(`Frontend    : ${FRONTEND_PATH}`);
      console.log(`Uploads     : ${UPLOADS_PATH}`);
      console.log(`Proxy hops  : ${TRUST_PROXY_HOPS}`);
      console.log('Database    : Connected');
      console.log('API         : Active');
      console.log('Status      : RUNNING');
      console.log('========================================');
      console.log('');
    });

    server.on('error', error => {
      console.error(
        '[HTTP SERVER ERROR]',
        error.message
      );

      process.exitCode = 1;
    });

    process.on('SIGTERM', () => {
      shutdown('SIGTERM');
    });

    process.on('SIGINT', () => {
      shutdown('SIGINT');
    });

  } catch (error) {
    console.error('');
    console.error('========================================');
    console.error('   MAWEGO BOOKSHOP STARTUP FAILED');
    console.error('========================================');
    console.error(error.stack || error.message);
    console.error('========================================');

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect().catch(() => {});
    }

    process.exitCode = 1;
  }
}

// ============================================================
// APPLICATION ENTRY POINT
// ============================================================

if (require.main === module) {
  start();
}

module.exports = app;