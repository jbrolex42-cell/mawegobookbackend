
'use strict';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const { User } = require('../models');

const JWT_SECRET = process.env.JWT_SECRET;

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const JWT_ISSUER = process.env.JWT_ISSUER || 'mawego-bookshop';

const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'mawego-api';

const TOKEN_ALGORITHM = 'HS256';

const STAFF_ROLES = [
  'staff',
  'manager',
  'owner'
];

const MANAGER_ROLES = [
  'manager',
  'owner'
];

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET must be configured with at least 32 characters in production.'
    );
  }

  console.warn(
    '[Auth] WARNING: JWT_SECRET is missing or too short. Configure a strong secret before deployment.'
  );
}

const logError = (context, error) => {
  console.error(`[Auth] ${context}`, {
    message: error?.message,
    name: error?.name
  });
};

const isValidObjectId = (value) => {
  return (
    typeof value === 'string' &&
    /^[a-f\d]{24}$/i.test(value)
  );
};

const normalizeRole = (role) => {
  return String(role || '').trim().toLowerCase();
};

const normalizePermissions = (permissions) => {
  if (!Array.isArray(permissions)) {
    return [];
  }

  return [
    ...new Set(
      permissions
        .filter((permission) => typeof permission === 'string')
        .map((permission) => permission.trim())
        .filter(Boolean)
    )
  ];
};

const getTokenFromRequest = (req) => {
  const header = req.headers.authorization;

  if (!header || typeof header !== 'string') {
    return null;
  }

  const match = header.match(/^Bearer\s+(\S+)$/i);

  return match ? match[1] : null;
};

const getPublicUser = (user, includePermissions = true) => {
  const result = {
    id: String(user._id),
    email: user.email,
    full_name: user.full_name,
    role: normalizeRole(user.role)
  };

  if (includePermissions) {
    result.permissions = normalizePermissions(user.permissions);
  }

  return result;
};

const getJwtOptions = () => ({
  algorithm: TOKEN_ALGORITHM,
  issuer: JWT_ISSUER,
  audience: JWT_AUDIENCE
});

const getJwtSecret = () => {
  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error(
      'JWT_SECRET is not configured correctly.'
    );
  }

  return JWT_SECRET;
};

function signToken(user) {
  if (!user || (!user._id && !user.id)) {
    throw new Error('A valid user is required to generate an access token.');
  }

  const userId = String(user._id || user.id);

  if (!isValidObjectId(userId)) {
    throw new Error('Invalid user ID.');
  }

  const role = normalizeRole(user.role);

  if (!role) {
    throw new Error('User role is required.');
  }

  const payload = {
    id: userId,
    email: user.email,
    role,
    name: user.full_name || user.name || ''
  };

  return jwt.sign(
    payload,
    getJwtSecret(),
    {
      ...getJwtOptions(),
      subject: userId,
      expiresIn: JWT_EXPIRES_IN
    }
  );
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Missing access token.');
  }

  const payload = jwt.verify(
    token,
    getJwtSecret(),
    {
      ...getJwtOptions(),
      algorithms: [TOKEN_ALGORITHM]
    }
  );

  if (
    !payload ||
    typeof payload !== 'object' ||
    !isValidObjectId(payload.id)
  ) {
    throw new Error('Invalid token payload.');
  }

  if (payload.sub && payload.sub !== payload.id) {
    throw new Error('Invalid token subject.');
  }

  return payload;
}

async function loadAuthenticatedUser(payload) {
  if (!isValidObjectId(payload.id)) {
    return null;
  }

  const user = await User.findById(payload.id)
    .select(
      '_id email full_name role permissions is_active'
    )
    .lean();

  if (!user || user.is_active !== true) {
    return null;
  }

  return user;
}

async function authenticate(req, res, next) {
  const token = getTokenFromRequest(req);

  if (!token) {
    return res.status(401).json({
      error: 'Authentication required.'
    });
  }

  try {
    const payload = verifyToken(token);

    const user = await loadAuthenticatedUser(payload);

    if (!user) {
      return res.status(401).json({
        error: 'User not found or inactive.'
      });
    }

    req.user = getPublicUser(user, true);

    return next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({
        error: 'Access token has expired.'
      });
    }

    if (error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({
        error: 'Invalid access token.'
      });
    }

    logError('Authentication failed', error);

    return res.status(500).json({
      error: 'Authentication service unavailable.'
    });
  }
}

async function optionalAuth(req, res, next) {
  const token = getTokenFromRequest(req);

  if (!token) {
    return next();
  }

  try {
    const payload = verifyToken(token);

    const user = await loadAuthenticatedUser(payload);

    if (user) {
      req.user = getPublicUser(user, true);
    }
  } catch (error) {

    if (
      !(error instanceof jwt.JsonWebTokenError) &&
      !(error instanceof jwt.TokenExpiredError)
    ) {
      logError('Optional authentication failed', error);
    }
  }

  return next();
}

function requireRole(...roles) {
  const allowedRoles = roles.map(normalizeRole);

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required.'
      });
    }

    const userRole = normalizeRole(req.user.role);

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        error: 'You do not have permission to access this resource.'
      });
    }

    return next();
  };
}

function requirePermission(permission) {
  const requiredPermission = String(permission || '').trim();

  if (!requiredPermission) {
    throw new Error('A permission name is required.');
  }

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required.'
      });
    }

    const role = normalizeRole(req.user.role);

    if (STAFF_ROLES.includes(role)) {
      return next();
    }

    const permissions = normalizePermissions(
      req.user.permissions
    );

    if (
      permissions.includes('*') ||
      permissions.includes(requiredPermission)
    ) {
      return next();
    }

    return res.status(403).json({
      error: 'You do not have permission to perform this action.',
      required_permission: requiredPermission
    });
  };
}

const requireStaff = requireRole(...STAFF_ROLES);

const requireManager = requireRole(...MANAGER_ROLES);

const requireOwner = requireRole('owner');

module.exports = {
  signToken,
  verifyToken,

  authenticate,
  optionalAuth,

  requireRole,
  requirePermission,

  requireStaff,
  requireManager,
  requireOwner,

  JWT_SECRET
};