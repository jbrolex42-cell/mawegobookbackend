
const mongoose = require('mongoose');

const { Expense } = require('../models');
const {
  serialize,
  serializeMany,
  parsePagination
} = require('../utils/helpers');

const EXPENSE_CATEGORIES = [
  'Rent',
  'Salaries',
  'Electricity',
  'Water',
  'Internet',
  'Transport',
  'Stationery',
  'Packaging',
  'Repairs and Maintenance',
  'Marketing',
  'Bank Charges',
  'Other'
];

exports.categories = async (req, res) => {
  try {
    res.json({
      categories: EXPENSE_CATEGORIES
    });
  } catch (err) {
    console.error('Expense categories error:', err);

    res.status(500).json({
      error: 'Failed to load expense categories'
    });
  }
};

exports.list = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);

    const filter = {};

    if (req.query.from || req.query.to) {
      filter.expense_date = {};

      if (req.query.from) {
        filter.expense_date.$gte = req.query.from;
      }

      if (req.query.to) {
        filter.expense_date.$lte = req.query.to;
      }
    }

    const total = await Expense.countDocuments(filter);

    const expenses = await Expense.find(filter)
      .sort({
        expense_date: -1,
        created_at: -1
      })
      .skip(skip)
      .limit(limit);

    res.json({
      expenses: serializeMany(expenses),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1
      }
    });

  } catch (err) {
    console.error('List expenses error:', err);

    res.status(500).json({
      error: 'Failed to list expenses'
    });
  }
};

exports.create = async (req, res) => {
  try {
    const {
      category,
      amount_kes,
      description,
      expense_date
    } = req.body;

    if (!category || amount_kes === undefined || amount_kes === null) {
      return res.status(400).json({
        error: 'Category and amount are required'
      });
    }

    const amount = Number(amount_kes);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: 'Expense amount must be greater than zero'
      });
    }

    if (expense_date && !/^\d{4}-\d{2}-\d{2}$/.test(expense_date)) {
      return res.status(400).json({
        error: 'Expense date must use YYYY-MM-DD format'
      });
    }

    const expense = await Expense.create({
      category: String(category).trim(),
      amount_kes: amount,
      description: description ? String(description).trim() : null,
      expense_date: expense_date || new Date().toISOString().slice(0, 10),
      recorded_by: req.user.id
    });

    res.status(201).json({
      message: 'Expense recorded successfully',
      expense: serialize(expense)
    });

  } catch (err) {
    console.error('Create expense error:', err);

    res.status(500).json({
      error: 'Failed to create expense'
    });
  }
};

exports.update = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        error: 'Invalid expense ID'
      });
    }

    const expense = await Expense.findById(id);

    if (!expense) {
      return res.status(404).json({
        error: 'Expense not found'
      });
    }

    const {
      category,
      amount_kes,
      description,
      expense_date
    } = req.body;

    if (category !== undefined) {
      if (!String(category).trim()) {
        return res.status(400).json({
          error: 'Category cannot be empty'
        });
      }

      expense.category = String(category).trim();
    }

    if (amount_kes !== undefined) {
      const amount = Number(amount_kes);

      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
          error: 'Expense amount must be greater than zero'
        });
      }

      expense.amount_kes = amount;
    }

    if (description !== undefined) {
      expense.description = description
        ? String(description).trim()
        : null;
    }

    if (expense_date !== undefined) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(expense_date) ||
        Number.isNaN(Date.parse(expense_date))
      ) {
        return res.status(400).json({
          error: 'Invalid expense date. Use YYYY-MM-DD'
        });
      }

      expense.expense_date = expense_date;
    }

    await expense.save();

    res.json({
      message: 'Expense updated successfully',
      expense: serialize(expense)
    });

  } catch (err) {
    console.error('Update expense error:', err);

    res.status(500).json({
      error: 'Failed to update expense'
    });
  }
};

exports.remove = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        error: 'Invalid expense ID'
      });
    }

    const expense = await Expense.findByIdAndDelete(id);

    if (!expense) {
      return res.status(404).json({
        error: 'Expense not found'
      });
    }

    res.json({
      ok: true,
      message: 'Expense deleted successfully'
    });

  } catch (err) {
    console.error('Delete expense error:', err);

    res.status(500).json({
      error: 'Failed to delete expense'
    });
  }
};