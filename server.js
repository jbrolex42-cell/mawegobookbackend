
require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env')
});

const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const fs = require('fs');

const { connectMongo } = require('./config/mongo');
const { Setting } = require('./models');

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

const frontendPath = path.join(__dirname, '..', 'frontend');
const uploadsPath = path.join(__dirname, 'uploads');

// ======================================================
// ENVIRONMENT VALIDATION
// ======================================================

function validateEnv() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required.');
  }

  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required.');
  }

  if (
    isProd &&
    (
      process.env.JWT_SECRET.length < 32 ||
      process.env.JWT_SECRET.includes('change-this')
    )
  ) {
    throw new Error(
      'Production JWT_SECRET must be at least 32 characters and must not be a placeholder.'
    );
  }

  if (
    isProd &&
    (
      !process.env.ADMIN_PASSWORD ||
      process.env.ADMIN_PASSWORD === 'MawegoAdmin2024!'
    )
  ) {
    console.warn(
      'WARNING: Change the default admin password.'
    );
  }

  if (
    process.env.CORS_ORIGIN &&
    typeof process.env.CORS_ORIGIN !== 'string'
  ) {
    throw new Error('CORS_ORIGIN must be a comma-separated string.');
  }
}

// ======================================================
// EXPRESS CONFIGURATION
// ======================================================

app.disable('x-powered-by');

app.set('trust proxy', 1);

// ======================================================
// SECURITY HEADERS
// ======================================================

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

  if (isProd) {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains'
    );
  }

  next();
});

// ======================================================
// CORS
// ======================================================

const corsOrigin = process.env.CORS_ORIGIN;

const allowedOrigins = corsOrigin
  ? corsOrigin
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean)
  : true;

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

// ======================================================
// REQUEST BODY PARSING
// ======================================================

app.use(express.json({
  limit: '10mb'
}));

app.use(express.urlencoded({
  extended: true,
  limit: '10mb'
}));

// ======================================================
// API RATE LIMITING
// ======================================================

app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 300 : 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please try again later.'
  }
}));

// ======================================================
// AUTHENTICATION RATE LIMITING
// ======================================================

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 30 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many authentication attempts. Please try again later.'
  }
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ======================================================
// UPLOAD DIRECTORY
// ======================================================

if (!fs.existsSync(uploadsPath)) {
  fs.mkdirSync(uploadsPath, {
    recursive: true
  });
}

// ======================================================
// STATIC UPLOADS
// ======================================================

app.use('/uploads', express.static(uploadsPath, {
  maxAge: isProd ? '7d' : 0,
  etag: true
}));

// ======================================================
// HEALTH CHECK
// ======================================================

app.get('/api/health', (req, res) => {
  const dbConnected =
    mongoose.connection.readyState === 1;

  res.status(dbConnected ? 200 : 503).json({
    status: dbConnected ? 'ok' : 'degraded',
    service: 'mawego-bookshop',
    database: dbConnected ? 'connected' : 'disconnected',
    time: new Date().toISOString(),
    uptime_s: Math.floor(process.uptime())
  });
});

// ======================================================
// API ROUTES
// ======================================================

// Central router handles:
// - Authentication
// - Products and categories
// - Orders
// - M-Pesa STK Push and callback
// - Card payments
// - Manual payment confirmation
// - Receipts
// - Notifications
// - Admin operations
// - Reports
// - Suppliers and expenses

app.use('/api', require('./routes'));

// Brevo receipt email routes
app.use(
  '/api/receipt-emails',
  require('./routes/receiptEmailRoutes')
);

// ======================================================
// PUBLIC WEBSITE SETTINGS
// ======================================================

app.get('/api/settings', async (req, res, next) => {
  try {
    const rows = await Setting.find();

    const settings = {};

    rows.forEach(row => {
      settings[row.key] = row.value;
    });

    res.json({ settings });

  } catch (error) {
    next(error);
  }
});

// ======================================================
// FRONTEND STATIC FILES
// ======================================================

app.use(express.static(frontendPath, {
  maxAge: isProd ? '1d' : 0,
  etag: true,
  index: false
}));

// ======================================================
// API NOT FOUND
// ======================================================

app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'API endpoint not found'
  });
});

// ======================================================
// FRONTEND FALLBACK
// ======================================================

app.get('*', (req, res) => {
  if (req.path.startsWith('/uploads')) {
    return res.status(404).send('Not found');
  }

  const requestedFile = path.join(
    frontendPath,
    req.path === '/' ? 'index.html' : req.path
  );

  res.sendFile(requestedFile, error => {
    if (error) {
      res.sendFile(
        path.join(frontendPath, 'pages', '404.html'),
        secondError => {
          if (secondError) {
            res.status(404).send('Page not found');
          }
        }
      );
    }
  });
});

// ======================================================
// GLOBAL ERROR HANDLER
// ======================================================

app.use((error, req, res, next) => {
  console.error('Server error:', error);

  if (res.headersSent) {
    return next(error);
  }

  if (
    error.message &&
    /image|file|upload|multer/i.test(error.message)
  ) {
    return res.status(400).json({
      error: error.message
    });
  }

  res.status(500).json({
    error: isProd
      ? 'Something went wrong. Please try again.'
      : error.message || 'Server error'
  });
});

// ======================================================
// DATABASE INITIALIZATION
// ======================================================

async function initializeDatabase() {
  console.log('Initializing Mawego Bookshop database...');

  const { init } = require('./utils/initDb');

  if (typeof init === 'function') {
    await Promise.resolve(init());
  }

  console.log('Database initialization completed.');
}

// ======================================================
// SERVER SHUTDOWN
// ======================================================

let server;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`\n${signal} received. Shutting down...`);

  const forceExit = setTimeout(() => {
    console.error('Shutdown timed out.');
    process.exit(1);
  }, 10000);

  forceExit.unref();

  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }

    await mongoose.connection.close();

    console.log('MongoDB connection closed.');
    console.log('Server stopped successfully.');

    clearTimeout(forceExit);
    process.exit(0);

  } catch (error) {
    console.error(
      'Shutdown error:',
      error.message
    );

    process.exit(1);
  }
}

// ======================================================
// START SERVER
// ======================================================

async function start() {
  try {
    console.log('Starting Mawego Bookshop...');

    validateEnv();

    await connectMongo();

    console.log('MongoDB connected successfully.');

    await initializeDatabase();

    server = app.listen(PORT, () => {
      console.log('');
      console.log('======================================');
      console.log('       MAWEGO BOOKSHOP ONLINE');
      console.log('======================================');
      console.log(`Server running on port ${PORT}`);
      console.log('MongoDB connected');
      console.log('API routes registered');
      console.log('======================================');
      console.log('');
    });

    server.on('error', error => {
      console.error(
        'HTTP server error:',
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
    console.error('======================================');
    console.error('   MAWEGO BOOKSHOP STARTUP FAILED');
    console.error('======================================');
    console.error(error.stack || error.message);
    console.error('======================================');

    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close().catch(() => {});
    }

    process.exitCode = 1;
  }
}

// ======================================================
// START APPLICATION
// ======================================================

start();

module.exports = app;