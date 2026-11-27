
'use strict';

const mongoose = require('mongoose');

const { Expense } = require('../models');

const {
  serialize,
  serializeMany,
  parsePagination
} = require('../utils/helpers');

const EXPENSE_CATEGORIES = Object.freeze([
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
]);

const DEFAULT_PAGE_SIZE = 20;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_EXPENSE_AMOUNT = 999999999999;

function sendError(res, status, message) {
  return res.status(status).json({
    error: message
  });
}

function logError(context, error) {
  console.error(`[${context}]`, error.message || error);
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) &&
    /^[a-f\d]{24}$/i.test(String(id));
}

function isValidDate(value) {
  if (typeof value !== 'string') {
    return false;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function validateAmount(value) {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    typeof value === 'boolean'
  ) {
    return null;
  }

  const amount = Number(value);

  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > MAX_EXPENSE_AMOUNT
  ) {
    return null;
  }

  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function validateCategory(category) {
  if (typeof category !== 'string') {
    return null;
  }

  const normalized = category.trim();

  if (!normalized || normalized.length > 100) {
    return null;
  }

  if (!EXPENSE_CATEGORIES.includes(normalized)) {
    return null;
  }

  return normalized;
}

function validateDescription(description) {
  if (description === undefined || description === null) {
    return null;
  }

  if (typeof description !== 'string') {
    return undefined;
  }

  const normalized = description.trim();

  if (normalized.length > MAX_DESCRIPTION_LENGTH) {
    return undefined;
  }

  return normalized || null;
}

function validateDateRange(from, to) {
  if (from !== undefined && !isValidDate(from)) {
    return 'Invalid start date. Use YYYY-MM-DD.';
  }

  if (to !== undefined && !isValidDate(to)) {
    return 'Invalid end date. Use YYYY-MM-DD.';
  }

  if (from && to && from > to) {
    return 'Start date cannot be later than end date.';
  }

  return null;
}

function getPagination(query) {
  const pagination = parsePagination(query);

  const page = Math.max(1, Number(pagination.page) || 1);
  const limit = Math.min(
    100,
    Math.max(1, Number(pagination.limit) || DEFAULT_PAGE_SIZE)
  );

  return {
    page,
    limit,
    skip: (page - 1) * limit
  };
}

function getExpenseFilter(query) {
  const filter = {};

  if (query.from || query.to) {
    filter.expense_date = {};

    if (query.from) {
      filter.expense_date.$gte = query.from;
    }

    if (query.to) {
      filter.expense_date.$lte = query.to;
    }
  }

  return filter;
}

exports.categories = async (req, res) => {
  try {
    return res.json({
      categories: EXPENSE_CATEGORIES
    });

  } catch (error) {
    logError('Expense categories', error);

    return sendError(
      res,
      500,
      'Failed to load expense categories'
    );
  }
};

exports.list = async (req, res) => {
  try {
    const query = req.query || {};

    const dateError = validateDateRange(
      query.from,
      query.to
    );

    if (dateError) {
      return sendError(res, 400, dateError);
    }

    const {
      page,
      limit,
      skip
    } = getPagination(query);

    const filter = getExpenseFilter(query);

    const [total, expenses] = await Promise.all([
      Expense.countDocuments(filter),

      Expense.find(filter)
        .sort({
          expense_date: -1,
          created_at: -1,
          _id: -1
        })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    return res.json({
      expenses: serializeMany(expenses),

      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1
      }
    });

  } catch (error) {
    logError('List expenses', error);

    return sendError(
      res,
      500,
      'Failed to list expenses'
    );
  }
};

exports.create = async (req, res) => {
  try {
    const {
      category,
      amount_kes,
      description,
      expense_date
    } = req.body || {};

    if (
      category === undefined ||
      amount_kes === undefined ||
      amount_kes === null
    ) {
      return sendError(
        res,
        400,
        'Category and amount are required'
      );
    }

    const normalizedCategory = validateCategory(category);

    if (!normalizedCategory) {
      return sendError(
        res,
        400,
        'Please select a valid expense category'
      );
    }

    const amount = validateAmount(amount_kes);

    if (amount === null) {
      return sendError(
        res,
        400,
        'Expense amount must be greater than zero'
      );
    }

    const normalizedDescription =
      validateDescription(description);

    if (normalizedDescription === undefined) {
      return sendError(
        res,
        400,
        `Description cannot exceed ${MAX_DESCRIPTION_LENGTH} characters`
      );
    }

    const date = expense_date || getToday();

    if (!isValidDate(date)) {
      return sendError(
        res,
        400,
        'Invalid expense date. Use YYYY-MM-DD.'
      );
    }

    if (!req.user || !req.user.id) {
      return sendError(
        res,
        401,
        'Authentication required'
      );
    }

    const expense = await Expense.create({
      category: normalizedCategory,
      amount_kes: amount,
      description: normalizedDescription,
      expense_date: date,
      recorded_by: req.user.id
    });

    return res.status(201).json({
      message: 'Expense recorded successfully',
      expense: serialize(expense)
    });

  } catch (error) {
    logError('Create expense', error);

    if (error.name === 'ValidationError') {
      return sendError(
        res,
        400,
        'Invalid expense details'
      );
    }

    return sendError(
      res,
      500,
      'Failed to create expense'
    );
  }
};

exports.update = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return sendError(
        res,
        400,
        'Invalid expense ID'
      );
    }

    const expense = await Expense.findById(id);

    if (!expense) {
      return sendError(
        res,
        404,
        'Expense not found'
      );
    }

    const {
      category,
      amount_kes,
      description,
      expense_date
    } = req.body || {};

    if (category !== undefined) {
      const normalizedCategory = validateCategory(category);

      if (!normalizedCategory) {
        return sendError(
          res,
          400,
          'Please select a valid expense category'
        );
      }

      expense.category = normalizedCategory;
    }

    if (amount_kes !== undefined) {
      const amount = validateAmount(amount_kes);

      if (amount === null) {
        return sendError(
          res,
          400,
          'Expense amount must be greater than zero'
        );
      }

      expense.amount_kes = amount;
    }

    if (description !== undefined) {
      const normalizedDescription =
        validateDescription(description);

      if (normalizedDescription === undefined) {
        return sendError(
          res,
          400,
          `Description cannot exceed ${MAX_DESCRIPTION_LENGTH} characters`
        );
      }

      expense.description = normalizedDescription;
    }

    if (expense_date !== undefined) {
      if (!isValidDate(expense_date)) {
        return sendError(
          res,
          400,
          'Invalid expense date. Use YYYY-MM-DD.'
        );
      }

      expense.expense_date = expense_date;
    }

    await expense.save();

    return res.json({
      message: 'Expense updated successfully',
      expense: serialize(expense)
    });

  } catch (error) {
    logError('Update expense', error);

    if (error.name === 'ValidationError') {
      return sendError(
        res,
        400,
        'Invalid expense details'
      );
    }

    if (error.name === 'CastError') {
      return sendError(
        res,
        400,
        'Invalid expense ID'
      );
    }

    return sendError(
      res,
      500,
      'Failed to update expense'
    );
  }
};

exports.remove = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return sendError(
        res,
        400,
        'Invalid expense ID'
      );
    }

    const expense = await Expense.findByIdAndDelete(id);

    if (!expense) {
      return sendError(
        res,
        404,
        'Expense not found'
      );
    }

    return res.json({
      ok: true,
      message: 'Expense deleted successfully'
    });

  } catch (error) {
    logError('Delete expense', error);

    if (error.name === 'CastError') {
      return sendError(
        res,
        400,
        'Invalid expense ID'
      );
    }

    return sendError(
      res,
      500,
      'Failed to delete expense'
    );
  }
};