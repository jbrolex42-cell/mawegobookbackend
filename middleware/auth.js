const jwt = require('jsonwebtoken');
const { User } = require('../models');

const JWT_SECRET = process.env.JWT_SECRET || 'mawego-dev-secret-change-in-production';

function signToken(user) {
  return jwt.sign(
    {
      id: String(user._id || user.id),
      email: user.email,
      role: user.role,
      name: user.full_name
    },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    const user = await User.findById(payload.id);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }
    req.user = {
      id: String(user._id),
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      permissions: user.permissions || []
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET);
      const user = await User.findById(payload.id);
      if (user && user.is_active) {
        req.user = {
          id: String(user._id),
          email: user.email,
          full_name: user.full_name,
          role: user.role
        };
      }
    } catch (_) {}
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role === 'owner') return next();
    if (['manager', 'staff', 'owner'].includes(req.user.role)) return next();
    const perms = req.user.permissions || [];
    if (perms.includes('*') || perms.includes(perm)) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

module.exports = {
  signToken,
  authenticate,
  optionalAuth,
  requireRole,
  requirePermission,
  requireStaff: requireRole('staff', 'manager', 'owner'),
  requireManager: requireRole('manager', 'owner'),
  requireOwner: requireRole('owner'),
  JWT_SECRET
};
