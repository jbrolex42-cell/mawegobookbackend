const { User, PointsLedger } = require('../models');
const { serialize, pointsToKes, MIN_REDEEM_POINTS, KES_PER_POINT } = require('../utils/helpers');

exports.balance = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      reward_points: user.reward_points || 0,
      value_kes: pointsToKes(user.reward_points || 0),
      min_redeem: MIN_REDEEM_POINTS,
      kes_per_point: KES_PER_POINT,
      rules: {
        earn: '1 point for every KES 50 spent on products',
        redeem: '100 points = KES 50 off (minimum 100 points)'
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load points' });
  }
};

exports.history = async (req, res) => {
  try {
    const rows = await PointsLedger.find({ user_id: req.user.id })
      .sort({ created_at: -1 })
      .limit(50);
    res.json({ ledger: rows.map((r) => serialize(r)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load points history' });
  }
};
