
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

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const BCRYPT_ROUNDS = 12;
const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_EXPIRY_MS = 30 * 60 * 1000;
const MAX_CUSTOMER_ORDERS = 50;
const MAX_NAME_LENGTH = 120;

const STAFF_ROLES = ['staff', 'manager', 'owner'];
const MANAGER_CREATABLE_ROLES = ['staff'];
const OWNER_CREATABLE_ROLES = ['staff', 'manager', 'owner'];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;
const RESET_TOKEN_REGEX = /^[a-f\d]{64}$/i;

function normalizeEmail(email) {
  return typeof email === 'string'
    ? email.trim().toLowerCase()
    : '';
}

function isValidEmail(email) {
  return (
    typeof email === 'string' &&
    email.length <= 254 &&
    EMAIL_REGEX.test(email)
  );
}

function isValidObjectId(id) {
  return OBJECT_ID_REGEX.test(String(id || ''));
}

function isValidPassword(password) {
  return (
    typeof password === 'string' &&
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH
  );
}

function normalizeName(name) {
  return typeof name === 'string' ? name.trim() : '';
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
    result.created_at = user.created_at || null;
  }

  return result;
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

function isDuplicateError(error) {
  return error?.code === 11000;
}

function logError(context, error) {
  console.error(`[${context}]`, {
    message: error?.message || String(error),
    status: error?.response?.status,
    response: error?.response?.body || error?.response?.text
  });
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, passwordHash) {
  if (
    typeof password !== 'string' ||
    typeof passwordHash !== 'string' ||
    !passwordHash
  ) {
    return false;
  }

  return bcrypt.compare(password, passwordHash);
}

function canManageStaff(actor, target) {
  if (!actor || !target) {
    return false;
  }

  if (actor.role === 'owner') {
    return true;
  }

  if (actor.role === 'manager') {
    return target.role === 'staff';
  }

  return false;
}

function hashResetToken(token) {
  return crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');
}

function genericResetResponse(res) {
  return res.status(200).json({
    message:
      'If an account exists with that email, password reset instructions will be sent shortly.'
  });
}

function getActor(req) {
  return req.user && req.user.id
    ? req.user
    : null;
}

exports.register = async (req, res) => {
  try {
    const {
      email,
      password,
      full_name,
      phone
    } = req.body || {};

    const normalizedEmail = normalizeEmail(email);
    const normalizedName = normalizeName(full_name);

    if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
      return sendError(res, 400, 'Please provide a valid email address');
    }

    if (!normalizedName || normalizedName.length > MAX_NAME_LENGTH) {
      return sendError(res, 400, 'Please provide a valid full name');
    }

    if (!isValidPassword(password)) {
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
      phone: typeof phone === 'string' ? phone.trim() : null,
      role: 'customer',
      reward_points: 0,
      is_active: true
    });

    const token = signToken(user);

    try {
      await sendWelcomeEmail({
        email: user.email,
        customerName: user.full_name
      });

      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            welcome_email_sent_at: new Date()
          }
        }
      );
    } catch (emailError) {
      logError('Welcome email delivery failed', emailError);
    }

    return res.status(201).json({
      message: 'Account created successfully',
      user: safeUser(user),
      token
    });

  } catch (error) {
    logError('Customer registration failed', error);

    if (isDuplicateError(error)) {
      return sendError(res, 409, 'Email already registered');
    }

    return sendError(
      res,
      500,
      'Registration failed. Please try again.'
    );
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body || {};

    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || typeof password !== 'string' || !password) {
      return sendError(res, 400, 'Email and password are required');
    }

    if (!isValidEmail(normalizedEmail)) {
      return sendError(res, 401, 'Invalid email or password');
    }

    const user = await User.findOne({
      email: normalizedEmail
    }).select('+password_hash');

    if (!user || user.is_active !== true) {
      return sendError(res, 401, 'Invalid email or password');
    }

    const passwordMatches = await verifyPassword(
      password,
      user.password_hash
    );

    if (!passwordMatches) {
      return sendError(res, 401, 'Invalid email or password');
    }

    const token = signToken(user);

    return res.status(200).json({
      message: 'Login successful',
      user: safeUser(user),
      token
    });

  } catch (error) {
    logError('Login failed', error);

    return sendError(
      res,
      500,
      'Login failed. Please try again.'
    );
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body?.email);

    if (!isValidEmail(normalizedEmail)) {
      return genericResetResponse(res);
    }

    const user = await User.findOne({
      email: normalizedEmail,
      role: 'customer',
      is_active: true
    }).select('_id email full_name');

    if (!user) {
      return genericResetResponse(res);
    }

    const resetToken = crypto
      .randomBytes(RESET_TOKEN_BYTES)
      .toString('hex');

    const tokenHash = hashResetToken(resetToken);

    const expiresAt = new Date(
      Date.now() + RESET_TOKEN_EXPIRY_MS
    );

    const updateResult = await User.updateOne(
      {
        _id: user._id,
        is_active: true
      },
      {
        $set: {
          password_reset_token_hash: tokenHash,
          password_reset_expires: expiresAt
        }
      }
    );

    if (updateResult.matchedCount === 0) {
      return genericResetResponse(res);
    }

    try {
      const emailResult = await sendPasswordResetEmail({
        email: user.email,
        customerName: user.full_name,
        resetToken
      });

      console.info('[Password reset email accepted]', {
        userId: String(user._id),
        messageId: emailResult?.messageId || null
      });

    } catch (emailError) {
      logError('Password reset email delivery failed', emailError);

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

    }

    return genericResetResponse(res);

  } catch (error) {
    logError('Forgot password failed', error);
    return genericResetResponse(res);
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body || {};

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

    if (!isValidPassword(password)) {
      return sendError(
        res,
        400,
        'Password must be between 8 and 128 characters'
      );
    }

    if (!RESET_TOKEN_REGEX.test(token)) {
      return sendError(
        res,
        400,
        'This password reset link is invalid or has expired.'
      );
    }

    const tokenHash = hashResetToken(token);
    const passwordHash = await hashPassword(password);

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
      message:
        'Your password has been reset successfully. You can now log in.'
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

exports.me = (req, res) => {
  if (!req.user) {
    return sendError(res, 401, 'Authentication required');
  }

  return res.status(200).json({
    user: req.user
  });
};

exports.myOrders = async (req, res) => {
  try {
    const actor = getActor(req);

    if (!actor) {
      return sendError(res, 401, 'Authentication required');
    }

    if (!isValidObjectId(actor.id)) {
      return sendError(res, 401, 'Invalid authenticated user');
    }

    const orders = await Order.find({
      user_id: actor.id
    })
      .sort({ created_at: -1, _id: -1 })
      .limit(MAX_CUSTOMER_ORDERS)
      .lean();

    return res.status(200).json({
      orders: serializeMany(orders)
    });

  } catch (error) {
    logError('Customer order history failed', error);

    return sendError(res, 500, 'Failed to load orders');
  }
};

exports.createStaff = async (req, res) => {
  try {
    const actor = getActor(req);

    if (!actor || !['manager', 'owner'].includes(actor.role)) {
      return sendError(res, 403, 'You are not allowed to create staff accounts');
    }

    const {
      email,
      password,
      full_name,
      phone,
      role
    } = req.body || {};

    const normalizedEmail = normalizeEmail(email);
    const normalizedName = normalizeName(full_name);

    if (!isValidEmail(normalizedEmail)) {
      return sendError(res, 400, 'Please provide a valid email address');
    }

    if (!isValidPassword(password)) {
      return sendError(
        res,
        400,
        'Password must be between 8 and 128 characters'
      );
    }

    if (!normalizedName || normalizedName.length > MAX_NAME_LENGTH) {
      return sendError(res, 400, 'Please provide a valid full name');
    }

    if (
      phone !== undefined &&
      phone !== null &&
      typeof phone !== 'string'
    ) {
      return sendError(res, 400, 'Invalid phone number');
    }

    const allowedRoles = actor.role === 'owner'
      ? OWNER_CREATABLE_ROLES
      : MANAGER_CREATABLE_ROLES;

    const targetRole = role || 'staff';

    if (!allowedRoles.includes(targetRole)) {
      return sendError(
        res,
        403,
        'You cannot create an account with that role'
      );
    }

    const existingUser = await User.findOne({
      email: normalizedEmail
    }).select('_id');

    if (existingUser) {
      return sendError(res, 409, 'Email already in use');
    }

    const user = await User.create({
      email: normalizedEmail,
      password_hash: await hashPassword(password),
      full_name: normalizedName,
      phone: typeof phone === 'string' ? phone.trim() : null,
      role: targetRole,
      is_active: true
    });

    return res.status(201).json({
      message: 'Staff account created successfully',
      user: safeUser(user, true)
    });

  } catch (error) {
    logError('Staff creation failed', error);

    if (isDuplicateError(error)) {
      return sendError(res, 409, 'Email already in use');
    }

    return sendError(res, 500, 'Failed to create staff account');
  }
};

exports.listStaff = async (req, res) => {
  try {
    const users = await User.find({
      role: {
        $in: STAFF_ROLES
      }
    })
      .select('email full_name phone role is_active created_at')
      .sort({
        role: 1,
        full_name: 1
      })
      .lean();

    return res.status(200).json({
      users: users.map(user => ({
        id: String(user._id),
        email: user.email,
        full_name: user.full_name,
        phone: user.phone || null,
        role: user.role,
        is_active: Boolean(user.is_active),
        created_at: user.created_at || null
      }))
    });

  } catch (error) {
    logError('Staff listing failed', error);

    return sendError(res, 500, 'Failed to list staff');
  }
};

exports.updateStaff = async (req, res) => {
  try {
    const actor = getActor(req);
    const { id } = req.params || {};

    if (!actor) {
      return sendError(res, 401, 'Authentication required');
    }

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

    if (!canManageStaff(actor, user)) {
      return sendError(
        res,
        403,
        'You are not allowed to manage this staff account'
      );
    }

    if (String(actor.id) === String(user._id)) {
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

    if (full_name !== undefined) {
      const normalizedName = normalizeName(full_name);

      if (!normalizedName || normalizedName.length > MAX_NAME_LENGTH) {
        return sendError(res, 400, 'Invalid full name');
      }

      user.full_name = normalizedName;
    }

    if (phone !== undefined) {
      if (phone !== null && typeof phone !== 'string') {
        return sendError(res, 400, 'Invalid phone number');
      }

      user.phone = typeof phone === 'string' && phone.trim()
        ? phone.trim()
        : null;
    }

    if (role !== undefined) {
      if (!STAFF_ROLES.includes(role)) {
        return sendError(res, 400, 'Invalid staff role');
      }

      if (actor.role !== 'owner') {
        return sendError(
          res,
          403,
          'Only owners can change staff roles'
        );
      }

      user.role = role;
    }

    if (is_active !== undefined) {
      if (typeof is_active !== 'boolean') {
        return sendError(res, 400, 'Invalid account status');
      }

      user.is_active = is_active;
    }

    if (password !== undefined) {
      if (!isValidPassword(password)) {
        return sendError(
          res,
          400,
          'Password must be between 8 and 128 characters'
        );
      }

      user.password_hash = await hashPassword(password);

      user.password_reset_token_hash = null;
      user.password_reset_expires = null;
    }

    await user.save();

    return res.status(200).json({
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