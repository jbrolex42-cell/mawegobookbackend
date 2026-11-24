
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const { User, Order } = require('../models');
const { signToken } = require('../middleware/auth');
const { serializeMany } = require('../utils/helpers');

const {
  sendWelcomeEmail,
  sendPasswordResetEmail
} = require('../services/emailService');

exports.register = async (req, res) => {
  try {
    const { email, password, full_name, phone } = req.body;

    if (!email || !password || !full_name) {
      return res.status(400).json({
        error: 'Email, password and full name are required'
      });
    }

    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      typeof full_name !== 'string'
    ) {
      return res.status(400).json({
        error: 'Invalid registration details'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: 'Password must be at least 6 characters'
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const normalizedName = full_name.trim();

    if (!normalizedName) {
      return res.status(400).json({
        error: 'Full name is required'
      });
    }

    const existing = await User.findOne({
      email: normalizedEmail
    });

    if (existing) {
      return res.status(409).json({
        error: 'Email already registered'
      });
    }

    const user = await User.create({
      email: normalizedEmail,
      password_hash: bcrypt.hashSync(password, 10),
      full_name: normalizedName,
      phone: phone || null,
      role: 'customer',
      reward_points: 0,
      is_active: true
    });

    const safeUser = {
      id: String(user._id),
      email: user.email,
      full_name: user.full_name,
      phone: user.phone,
      role: user.role,
      reward_points: user.reward_points || 0
    };

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
        console.error(
          'Welcome email failed:',
          error.message
        );
      });

    return res.status(201).json({
      message: 'Account created successfully',
      user: safeUser,
      token: signToken(user)
    });

  } catch (error) {
    console.error('Registration error:', error);

    if (error.code === 11000) {
      return res.status(409).json({
        error: 'Email already registered'
      });
    }

    return res.status(500).json({
      error: 'Registration failed'
    });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      !email ||
      !password
    ) {
      return res.status(400).json({
        error: 'Email and password required'
      });
    }

    const user = await User.findOne({
      email: email.toLowerCase().trim()
    });

    if (
      !user ||
      !user.is_active ||
      !bcrypt.compareSync(password, user.password_hash)
    ) {
      return res.status(401).json({
        error: 'Invalid credentials'
      });
    }

    return res.json({
      user: {
        id: String(user._id),
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
        role: user.role,
        reward_points: user.reward_points || 0
      },
      token: signToken(user)
    });

  } catch (error) {
    console.error('Login error:', error);

    return res.status(500).json({
      error: 'Login failed'
    });
  }
};

exports.forgotPassword = async (req, res) => {
  const genericMessage =
    'If an account exists with that email, password reset instructions will be sent shortly.';

  try {
    const { email } = req.body || {};

    if (typeof email !== 'string' || !email.trim()) {
      return res.status(200).json({
        message: genericMessage
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

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
      Date.now() + 30 * 60 * 1000
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

      console.error(
        'Password reset email failed:',
        emailError.message
      );
    }

    return res.status(200).json({
      message: genericMessage
    });

  } catch (error) {
    console.error('Forgot password error:', error);

    return res.status(200).json({
      message: genericMessage
    });
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
      return res.status(400).json({
        error: 'Reset token and new password are required'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters'
      });
    }

    if (password.length > 128) {
      return res.status(400).json({
        error: 'Password is too long'
      });
    }

    if (!/^[a-f0-9]{64}$/i.test(token)) {
      return res.status(400).json({
        error: 'This password reset link is invalid or has expired.'
      });
    }

    const tokenHash = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    const newPasswordHash = bcrypt.hashSync(password, 12);

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
          password_hash: newPasswordHash,
          password_reset_token_hash: null,
          password_reset_expires: null
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(400).json({
        error: 'This password reset link is invalid or has expired. Please request another one.'
      });
    }

    return res.status(200).json({
      message: 'Your password has been reset successfully. You can now log in.'
    });

  } catch (error) {
    console.error('Reset password error:', error);

    return res.status(500).json({
      error: 'Unable to reset password. Please try again.'
    });
  }
};

exports.me = (req, res) => {
  res.json({
    user: req.user
  });
};

exports.myOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      user_id: req.user.id
    })
      .sort({ created_at: -1 })
      .limit(50);

    return res.json({
      orders: serializeMany(orders)
    });

  } catch (error) {
    console.error('Customer orders error:', error);

    return res.status(500).json({
      error: 'Failed to load orders'
    });
  }
};

exports.createStaff = async (req, res) => {
  try {
    const {
      email,
      password,
      full_name,
      phone,
      role
    } = req.body;

    if (!email || !password || !full_name) {
      return res.status(400).json({
        error: 'Email, password and full name required'
      });
    }

    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      typeof full_name !== 'string' ||
      password.length < 6
    ) {
      return res.status(400).json({
        error: 'Invalid staff account details'
      });
    }

    const allowed = ['staff', 'manager'];

    if (req.user.role === 'owner') {
      allowed.push('owner');
    }

    const targetRole =
      role && allowed.includes(role) ? role : 'staff';

    if (
      req.user.role === 'manager' &&
      targetRole !== 'staff'
    ) {
      return res.status(403).json({
        error: 'Managers can only create staff accounts'
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    if (await User.findOne({ email: normalizedEmail })) {
      return res.status(409).json({
        error: 'Email already in use'
      });
    }

    const user = await User.create({
      email: normalizedEmail,
      password_hash: bcrypt.hashSync(password, 10),
      full_name: full_name.trim(),
      phone: phone || null,
      role: targetRole,
      is_active: true
    });

    return res.status(201).json({
      user: {
        id: String(user._id),
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
        role: user.role,
        is_active: user.is_active,
        created_at: user.created_at
      }
    });

  } catch (error) {
    console.error('Create staff error:', error);

    if (error.code === 11000) {
      return res.status(409).json({
        error: 'Email already in use'
      });
    }

    return res.status(500).json({
      error: 'Failed to create staff'
    });
  }
};

exports.listStaff = async (req, res) => {
  try {
    const users = await User.find({
      role: {
        $in: ['staff', 'manager', 'owner']
      }
    }).sort({
      role: 1,
      full_name: 1
    });

    return res.json({
      users: users.map(user => ({
        id: String(user._id),
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
        role: user.role,
        is_active: user.is_active,
        created_at: user.created_at
      }))
    });

  } catch (error) {
    console.error('List staff error:', error);

    return res.status(500).json({
      error: 'Failed to list staff'
    });
  }
};

exports.updateStaff = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    if (!['staff', 'manager', 'owner'].includes(user.role)) {
      return res.status(400).json({
        error: 'Not a staff account'
      });
    }

    const {
      full_name,
      phone,
      role,
      is_active,
      password
    } = req.body;

    if (full_name) {
      user.full_name = full_name;
    }

    if (phone !== undefined) {
      user.phone = phone;
    }

    if (
      role &&
      ['staff', 'manager'].includes(role) &&
      req.user.role === 'owner'
    ) {
      user.role = role;
    }

    if (is_active !== undefined) {
      user.is_active = !!is_active;
    }

    if (password) {
      if (
        typeof password !== 'string' ||
        password.length < 6
      ) {
        return res.status(400).json({
          error: 'Password must be at least 6 characters'
        });
      }

      user.password_hash = bcrypt.hashSync(password, 10);
    }

    await user.save();

    return res.json({
      user: {
        id: String(user._id),
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
        role: user.role,
        is_active: user.is_active
      }
    });

  } catch (error) {
    console.error('Update staff error:', error);

    return res.status(500).json({
      error: 'Failed to update staff'
    });
  }
};