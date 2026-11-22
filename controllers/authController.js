const bcrypt = require('bcryptjs');
const { User, Order } = require('../models');
const { signToken } = require('../middleware/auth');
const { serialize, serializeMany } = require('../utils/helpers');

exports.register = async (req, res) => {
  try {
    const { email, password, full_name, phone } = req.body;
    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'Email, password and full name are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const user = await User.create({
      email: email.toLowerCase().trim(),
      password_hash: bcrypt.hashSync(password, 10),
      full_name: full_name.trim(),
      phone: phone || null,
      role: 'customer',
      reward_points: 0,
      is_active: true
    });

    const safe = {
      id: String(user._id),
      email: user.email,
      full_name: user.full_name,
      phone: user.phone,
      role: user.role
    };
    res.status(201).json({ user: safe, token: signToken(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user || !user.is_active || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    res.json({
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
};

exports.me = (req, res) => res.json({ user: req.user });

exports.myOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user_id: req.user.id })
      .sort({ created_at: -1 })
      .limit(50);
    res.json({ orders: serializeMany(orders) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
};

exports.createStaff = async (req, res) => {
  try {
    const { email, password, full_name, phone, role } = req.body;
    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'Email, password and full name required' });
    }
    const allowed = ['staff', 'manager'];
    if (req.user.role === 'owner') allowed.push('owner');
    const targetRole = role && allowed.includes(role) ? role : 'staff';
    if (req.user.role === 'manager' && targetRole !== 'staff') {
      return res.status(403).json({ error: 'Managers can only create staff accounts' });
    }
    if (await User.findOne({ email: email.toLowerCase().trim() })) {
      return res.status(409).json({ error: 'Email already in use' });
    }
    const user = await User.create({
      email: email.toLowerCase().trim(),
      password_hash: bcrypt.hashSync(password, 10),
      full_name: full_name.trim(),
      phone: phone || null,
      role: targetRole,
      is_active: true
    });
    res.status(201).json({
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create staff' });
  }
};

exports.listStaff = async (req, res) => {
  try {
    const users = await User.find({ role: { $in: ['staff', 'manager', 'owner'] } }).sort({
      role: 1,
      full_name: 1
    });
    res.json({
      users: users.map((u) => ({
        id: String(u._id),
        email: u.email,
        full_name: u.full_name,
        phone: u.phone,
        role: u.role,
        is_active: u.is_active,
        created_at: u.created_at
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list staff' });
  }
};

exports.updateStaff = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!['staff', 'manager', 'owner'].includes(user.role)) {
      return res.status(400).json({ error: 'Not a staff account' });
    }
    const { full_name, phone, role, is_active, password } = req.body;
    if (full_name) user.full_name = full_name;
    if (phone !== undefined) user.phone = phone;
    if (role && ['staff', 'manager'].includes(role) && req.user.role === 'owner') user.role = role;
    if (is_active !== undefined) user.is_active = !!is_active;
    if (password && password.length >= 6) user.password_hash = bcrypt.hashSync(password, 10);
    await user.save();
    res.json({
      user: {
        id: String(user._id),
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
        role: user.role,
        is_active: user.is_active
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update staff' });
  }
};
