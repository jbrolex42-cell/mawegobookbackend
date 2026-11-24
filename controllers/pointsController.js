
'use strict';

const mongoose = require('mongoose');

const { User, PointsLedger } = require('../models');

const {
  serialize,
  pointsToKes,
  MIN_REDEEM_POINTS,
  KES_PER_POINT
} = require('../utils/helpers');

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;

const logError = (message, error) => {
  console.error(`[RewardsController] ${message}`, {
    message: error?.message,
    name: error?.name
  });
};

const getUserId = (req) => {
  const userId = req.user?.id || req.user?._id;

  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
    return null;
  }

  return userId;
};

const parseLimit = (value) => {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_HISTORY_LIMIT;
  }

  return Math.min(parsed, MAX_HISTORY_LIMIT);
};

const parsePage = (value) => {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return 1;
  }

  return parsed;
};

/**
 * GET /api/rewards/balance
 *
 * Returns the authenticated customer's reward balance.
 */
exports.balance = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        error: 'Authentication required'
      });
    }

    const user = await User.findById(userId)
      .select('reward_points')
      .lean();

    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    const rewardPoints = Math.max(
      0,
      Number(user.reward_points) || 0
    );

    return res.json({
      reward_points: rewardPoints,
      value_kes: pointsToKes(rewardPoints),
      min_redeem: MIN_REDEEM_POINTS,
      kes_per_point: KES_PER_POINT,

      rules: {
        earn: '1 point for every KES 50 spent on products',
        redeem: `${MIN_REDEEM_POINTS} points = KES ${
          pointsToKes(MIN_REDEEM_POINTS)
        } off (minimum ${MIN_REDEEM_POINTS} points)`
      }
    });
  } catch (error) {
    logError('Failed to load reward balance', error);

    return res.status(500).json({
      error: 'Failed to load points'
    });
  }
};

/**
 * GET /api/rewards/history
 *
 * Returns the authenticated customer's reward ledger.
 *
 * Optional query parameters:
 *   ?page=1
 *   ?limit=50
 */
exports.history = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        error: 'Authentication required'
      });
    }

    const page = parsePage(req.query?.page);
    const limit = parseLimit(req.query?.limit);
    const skip = (page - 1) * limit;

    const filter = {
      user_id: userId
    };

    const [rows, total] = await Promise.all([
      PointsLedger.find(filter)
        .sort({
          created_at: -1,
          _id: -1
        })
        .skip(skip)
        .limit(limit)
        .lean(),

      PointsLedger.countDocuments(filter)
    ]);

    return res.json({
      ledger: rows.map((row) => serialize(row)),
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
        has_next: page * limit < total,
        has_previous: page > 1
      }
    });
  } catch (error) {
    logError('Failed to load reward history', error);

    return res.status(500).json({
      error: 'Failed to load points history'
    });
  }
};