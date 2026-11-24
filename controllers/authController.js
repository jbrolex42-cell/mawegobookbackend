
'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const { User, Order } = require('../models');
const { signToken } = require('../middleware/auth');
const { serializeMany } = require('../utils/helpers');

const {
  sendWelcomeEmail,
  sendPasswordResetEmail
} = require('../services/emailService');

// ============================================================
// CONFIGURATION
// ============================================================

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const BCRYPT_ROUNDS = 12;
const RESET_TOKEN_EXPIRY = 30 * 60 * 1000;
const MAX_CUSTOMER_ORDERS = 50;

const STAFF_ROLES = ['staff', 'manager', 'owner'];
const MANAGER_CREATABLE_ROLES = ['staff'];
const OWNER_CREATABLE_ROLES = ['staff', 'manager', 'owner'];

// ============================================================
// SHARED HELPERS
// ============================================================

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidObjectId(id) {
  return /^[a-f\d]{24}$/i.test(String(id || ''));
}

function isValidPassword(password, minLength = PASSWORD_MIN_LENGTH) {
  return (
    typeof password === 'string' &&
    password.length >= minLength &&
    password.length <= PASSWORD_MAX_LENGTH
  );
}

function safeUser(user, includeStatus = false) {
  const result = {
    id: String(user._id),
    email: user.email,
    full_name: user.full_name,
    phone: user.phone || null,
    role: user.role,
    reward_points: Number(user.reward_points || 0)
  };

  if (includeStatus) {
    result.is_active = Boolean(user.is_active);
    result.created_at = user.created_at;
  }

  return result;
}

function sendError(res, status, message) {
  return res.status(status).json({
    error: message
  });
}

function handleDuplicateError(error) {
  return error && error.code === 11000;
}

function canManageStaff(actor, target) {
  if (!actor || !target) return false;

  if (actor.role === 'owner') {
    return true;
  }

  if (actor.role === 'manager') {
    return target.role === 'staff';
  }

  return false;
}

function logError(context, error) {
  console.error(`[${context}]`, error.message || error);
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, passwordHash) {
  if (!passwordHash) return false;

  return bcrypt.compare(password, passwordHash);
}

// ============================================================
// CUSTOMER REGISTRATION
// ============================================================

exports.register = async (req, res) => {
  try {
    const {
      email,
      password,
      full_name,
      phone
    } = req.body || {};

    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      typeof full_name !== 'string'
    ) {
      return sendError(
        res,
        400,
        'Email, password and full name are required'
      );
    }

    const normalizedEmail = normalizeEmail(email);
    const normalizedName = full_name.trim();

    if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
      return sendError(res, 400, 'Please provide a valid email address');
    }

    if (!normalizedName || normalizedName.length > 120) {
      return sendError(res, 400, 'Please provide a valid full name');
    }

    if (!isValidPassword(password, 8)) {
      return sendError(
        res,
        400,
        'Password must be between 8 and 128 characters'
      );
    }

    if (
      phone !== undefined &&
      phone !== null &&
      typeof phone !== 'string'
    ) {
      return sendError(res, 400, 'Invalid phone number');
    }

    const existingUser = await User.findOne({
      email: normalizedEmail
    }).select('_id');

    if (existingUser) {
      return sendError(res, 409, 'Email already registered');
    }

    const passwordHash = await hashPassword(password);

    const user = await User.create({
      email: normalizedEmail,
      password_hash: passwordHash,
      full_name: normalizedName,
      phone: phone ? phone.trim() : null,
      role: 'customer',
      reward_points: 0,
      is_active: true
    });

    // Send welcome email without delaying registration.
    Promise.resolve()
      .then(() => sendWelcomeEmail({
        email: user.email,
        customerName: user.full_name
      }))
      .then(() => User.updateOne(
        { _id: user._id },
        {
          $set: {
            welcome_email_sent_at: new Date()
          }
        }
      ))
      .catch(error => {
        logError('Welcome email failed', error);
      });

    return res.status(201).json({
      message: 'Account created successfully',
      user: safeUser(user),
      token: signToken(user)
    });

  } catch (error) {
    logError('Customer registration failed', error);

    if (handleDuplicateError(error)) {
      return sendError(res, 409, 'Email already registered');
    }

    return sendError(res, 500, 'Registration failed. Please try again.');
  }
};

// ============================================================
// CUSTOMER LOGIN
// ============================================================

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      !email.trim() ||
      !password
    ) {
      return sendError(res, 400, 'Email and password are required');
    }

    const normalizedEmail = normalizeEmail(email);

    if (!isValidEmail(normalizedEmail)) {
      return sendError(res, 401, 'Invalid credentials');
    }

    const user = await User.findOne({
      email: normalizedEmail
    });

    if (!user || !user.is_active) {
      return sendError(res, 401, 'Invalid credentials');
    }

    const passwordMatches = await verifyPassword(
      password,
      user.password_hash
    );

    if (!passwordMatches) {
      return sendError(res, 401, 'Invalid credentials');
    }

    return res.json({
      message: 'Login successful',
      user: safeUser(user),
      token: signToken(user)
    });

  } catch (error) {
    logError('Login failed', error);

    return sendError(res, 500, 'Login failed. Please try again.');
  }
};

// ============================================================
// FORGOT PASSWORD
// ============================================================

exports.forgotPassword = async (req, res) => {
  const genericMessage =
    'If an account exists with that email, password reset instructions will be sent shortly.';

  try {
    const { email } = req.body || {};

    // Always return the same response to avoid exposing accounts.
    if (
      typeof email !== 'string' ||
      !email.trim() ||
      !isValidEmail(normalizeEmail(email))
    ) {
      return res.status(200).json({
        message: genericMessage
      });
    }

    const normalizedEmail = normalizeEmail(email);

    const user = await User.findOne({
      email: normalizedEmail,
      role: 'customer',
      is_active: true
    });

    if (!user) {
      return res.status(200).json({
        message: genericMessage
      });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');

    const tokenHash = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');

    const expiresAt = new Date(
      Date.now() + RESET_TOKEN_EXPIRY
    );

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          password_reset_token_hash: tokenHash,
          password_reset_expires: expiresAt
        }
      }
    );

    try {
      await sendPasswordResetEmail({
        email: user.email,
        customerName: user.full_name,
        resetToken
      });

    } catch (emailError) {
      // Remove the token only if it is still the same token.
      await User.updateOne(
        {
          _id: user._id,
          password_reset_token_hash: tokenHash
        },
        {
          $set: {
            password_reset_token_hash: null,
            password_reset_expires: null
          }
        }
      );

      logError('Password reset email failed', emailError);
    }

    return res.status(200).json({
      message: genericMessage
    });

  } catch (error) {
    logError('Forgot password failed', error);

    return res.status(200).json({
      message: genericMessage
    });
  }
};

// ============================================================
// RESET PASSWORD
// ============================================================

exports.resetPassword = async (req, res) => {
  try {
    const {
      token,
      password
    } = req.body || {};

    if (
      typeof token !== 'string' ||
      typeof password !== 'string' ||
      !token ||
      !password
    ) {
      return sendError(
        res,
        400,
        'Reset token and new password are required'
      );
    }

    if (!isValidPassword(password, 8)) {
      return sendError(
        res,
        400,
        'Password must be between 8 and 128 characters'
      );
    }

    if (!/^[a-f0-9]{64}$/i.test(token)) {
      return sendError(
        res,
        400,
        'This password reset link is invalid or has expired.'
      );
    }

    const tokenHash = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    const passwordHash = await hashPassword(password);

    // Atomic update ensures an expired or already-used token
    // cannot reset the password.
    const result = await User.updateOne(
      {
        password_reset_token_hash: tokenHash,
        password_reset_expires: {
          $gt: new Date()
        },
        is_active: true,
        role: 'customer'
      },
      {
        $set: {
          password_hash: passwordHash,
          password_reset_token_hash: null,
          password_reset_expires: null
        }
      }
    );

    if (result.matchedCount === 0) {
      return sendError(
        res,
        400,
        'This password reset link is invalid or has expired. Please request another one.'
      );
    }

    return res.status(200).json({
      message: 'Your password has been reset successfully. You can now log in.'
    });

  } catch (error) {
    logError('Password reset failed', error);

    return sendError(
      res,
      500,
      'Unable to reset password. Please try again.'
    );
  }
};

// ============================================================
// CURRENT USER PROFILE
// ============================================================

exports.me = (req, res) => {
  if (!req.user) {
    return sendError(res, 401, 'Authentication required');
  }

  return res.json({
    user: req.user
  });
};

// ============================================================
// CUSTOMER ORDER HISTORY
// ============================================================

exports.myOrders = async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return sendError(res, 401, 'Authentication required');
    }

    const orders = await Order.find({
      user_id: req.user.id
    })
      .sort({ created_at: -1 })
      .limit(MAX_CUSTOMER_ORDERS)
      .lean();

    return res.json({
      orders: serializeMany(orders)
    });

  } catch (error) {
    logError('Customer order history failed', error);

    return sendError(res, 500, 'Failed to load orders');
  }
};

// ============================================================
// CREATE STAFF ACCOUNT
// ============================================================

exports.createStaff = async (req, res) => {
  try {
    const {
      email,
      password,
      full_name,
      phone,
      role
    } = req.body || {};

    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      typeof full_name !== 'string'
    ) {
      return sendError(
        res,
        400,
        'Email, password and full name are required'
      );
    }

    if (!isValidEmail(normalizeEmail(email))) {
      return sendError(res, 400, 'Please provide a valid email address');
    }

    if (!isValidPassword(password, 8)) {
      return sendError(
        res,
        400,
        'Password must be between 8 and 128 characters'
      );
    }

    const normalizedEmail = normalizeEmail(email);
    const normalizedName = full_name.trim();

    if (!normalizedName || normalizedName.length > 120) {
      return sendError(res, 400, 'Please provide a valid full name');
    }

    if (
      phone !== undefined &&
      phone !== null &&
      typeof phone !== 'string'
    ) {
      return sendError(res, 400, 'Invalid phone number');
    }

    const allowedRoles =
      req.user.role === 'owner'
        ? OWNER_CREATABLE_ROLES
        : req.user.role === 'manager'
          ? MANAGER_CREATABLE_ROLES
          : [];

    if (!allowedRoles.length) {
      return sendError(res, 403, 'You are not allowed to create staff accounts');
    }

    const targetRole = role || 'staff';

    if (!allowedRoles.includes(targetRole)) {
      return sendError(res, 403, 'You cannot create an account with that role');
    }

    const existingUser = await User.findOne({
      email: normalizedEmail
    }).select('_id');

    if (existingUser) {
      return sendError(res, 409, 'Email already in use');
    }

    const passwordHash = await hashPassword(password);

    const user = await User.create({
      email: normalizedEmail,
      password_hash: passwordHash,
      full_name: normalizedName,
      phone: phone ? phone.trim() : null,
      role: targetRole,
      is_active: true
    });

    return res.status(201).json({
      message: 'Staff account created successfully',
      user: safeUser(user, true)
    });

  } catch (error) {
    logError('Staff creation failed', error);

    if (handleDuplicateError(error)) {
      return sendError(res, 409, 'Email already in use');
    }

    return sendError(res, 500, 'Failed to create staff account');
  }
};

// ============================================================
// LIST STAFF ACCOUNTS
// ============================================================

exports.listStaff = async (req, res) => {
  try {
    const users = await User.find({
      role: {
        $in: STAFF_ROLES
      }
    })
      .select(
        'email full_name phone role is_active created_at'
      )
      .sort({
        role: 1,
        full_name: 1
      })
      .lean();

    return res.json({
      users: users.map(user => ({
        id: String(user._id),
        email: user.email,
        full_name: user.full_name,
        phone: user.phone || null,
        role: user.role,
        is_active: Boolean(user.is_active),
        created_at: user.created_at
      }))
    });

  } catch (error) {
    logError('Staff listing failed', error);

    return sendError(res, 500, 'Failed to list staff');
  }
};

// ============================================================
// UPDATE STAFF ACCOUNT
// ============================================================

exports.updateStaff = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return sendError(res, 400, 'Invalid staff account ID');
    }

    const user = await User.findById(id);

    if (!user) {
      return sendError(res, 404, 'User not found');
    }

    if (!STAFF_ROLES.includes(user.role)) {
      return sendError(res, 400, 'This account is not a staff account');
    }

    // Enforce staff hierarchy.
    if (!canManageStaff(req.user, user)) {
      return sendError(
        res,
        403,
        'You are not allowed to manage this staff account'
      );
    }

    // Prevent staff from changing their own permissions.
    if (String(req.user.id) === String(user._id)) {
      return sendError(
        res,
        403,
        'You cannot modify your own staff account here'
      );
    }

    const {
      full_name,
      phone,
      role,
      is_active,
      password
    } = req.body || {};

    // Full name validation.
    if (full_name !== undefined) {
      if (
        typeof full_name !== 'string' ||
        !full_name.trim() ||
        full_name.trim().length > 120
      ) {
        return sendError(res, 400, 'Invalid full name');
      }

      user.full_name = full_name.trim();
    }

    // Phone validation.
    if (phone !== undefined) {
      if (phone !== null && typeof phone !== 'string') {
        return sendError(res, 400, 'Invalid phone number');
      }

      user.phone = phone ? phone.trim() : null;
    }

    // Role permissions.
    if (role !== undefined) {
      if (!STAFF_ROLES.includes(role)) {
        return sendError(res, 400, 'Invalid staff role');
      }

      if (req.user.role !== 'owner') {
        return sendError(
          res,
          403,
          'Only owners can change staff roles'
        );
      }

      user.role = role;
    }

    // Account activation.
    if (is_active !== undefined) {
      if (typeof is_active !== 'boolean') {
        return sendError(res, 400, 'Invalid account status');
      }

      user.is_active = is_active;
    }

    // Password update.
    if (password !== undefined) {
      if (!isValidPassword(password, 8)) {
        return sendError(
          res,
          400,
          'Password must be between 8 and 128 characters'
        );
      }

      user.password_hash = await hashPassword(password);

      // Invalidate outstanding password reset links.
      user.password_reset_token_hash = null;
      user.password_reset_expires = null;
    }

    await user.save();

    return res.json({
      message: 'Staff account updated successfully',
      user: safeUser(user, true)
    });

  } catch (error) {
    logError('Staff update failed', error);

    if (error.name === 'CastError') {
      return sendError(res, 400, 'Invalid staff account ID');
    }

    return sendError(res, 500, 'Failed to update staff account');
  }
};