
'use strict';

const mongoose = require('mongoose');

const {
  Order,
  Product,
  Category,
  Expense
} = require('../models');

const { serializeMany } = require('../utils/helpers');

const ACTIVE_ORDER_STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'ready',
  'out_for_delivery'
];

const RECENT_ORDER_LIMIT = 8;
const TOP_PRODUCTS_LIMIT = 15;

const logError = (context, error) => {
  console.error(`[ReportsController] ${context}`, {
    message: error?.message,
    name: error?.name
  });
};

const toNumber = (value, fallback = 0) => {
  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
};

const roundMoney = (value) => {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
};

const startOfDay = (date) => {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
};

const endOfDay = (date) => {
  const value = new Date(date);
  value.setHours(23, 59, 59, 999);
  return value;
};

const formatDate = (date) => {
  const value = new Date(date);

  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
};

const currentDate = () => formatDate(new Date());

const firstDayOfCurrentMonth = () => {
  const now = new Date();

  return formatDate(
    new Date(now.getFullYear(), now.getMonth(), 1)
  );
};

const isValidDate = (value) => {
  if (typeof value !== 'string') return false;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);

  const date = new Date(year, month - 1, day);

  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
};

const validDateRange = (from, to) => {
  return (
    isValidDate(from) &&
    isValidDate(to) &&
    from <= to
  );
};

const getDateRange = (query = {}) => {
  const from = query.from || firstDayOfCurrentMonth();
  const to = query.to || currentDate();

  if (!validDateRange(from, to)) {
    return {
      error: 'Invalid date range. Use YYYY-MM-DD and ensure the start date is not after the end date.'
    };
  }

  return {
    from,
    to,
    start: startOfDay(`${from}T00:00:00`),
    end: endOfDay(`${to}T00:00:00`)
  };
};

const getPaidOrderFilter = (start, end) => ({
  payment_status: 'paid',
  created_at: {
    $gte: start,
    $lte: end
  }
});

const getProductIdsFromOrders = (orders) => {
  const ids = new Set();

  for (const order of orders) {
    for (const item of order.items || []) {
      const id = item.product_id;

      if (
        id &&
        mongoose.Types.ObjectId.isValid(String(id))
      ) {
        ids.add(String(id));
      }
    }
  }

  return [...ids];
};

const getProductCostMap = async (productIds) => {
  if (!productIds.length) {
    return new Map();
  }

  const products = await Product.find({
    _id: {
      $in: productIds
    }
  })
    .select('_id cost_kes')
    .lean();

  return new Map(
    products.map((product) => [
      String(product._id),
      toNumber(product.cost_kes)
    ])
  );
};

const getItemQuantity = (item) => {
  return Math.max(0, toNumber(item.quantity));
};

const getItemUnitPrice = (item) => {
  return Math.max(0, toNumber(item.unit_price_kes));
};

const getItemLineTotal = (item) => {
  const explicitTotal = Number(item.line_total_kes);

  if (Number.isFinite(explicitTotal)) {
    return Math.max(0, explicitTotal);
  }

  return getItemUnitPrice(item) * getItemQuantity(item);
};

const calculateCostOfGoods = (item, costMap) => {
  const quantity = getItemQuantity(item);

  const historicalCost = Number(item.unit_cost_kes);

  const unitCost = Number.isFinite(historicalCost)
    ? historicalCost
    : costMap.get(String(item.product_id)) || 0;

  return Math.max(0, unitCost) * quantity;
};

const sum = (items, selector) => {
  return items.reduce(
    (total, item) => total + toNumber(selector(item)),
    0
  );
};

exports.dashboard = async (req, res) => {
  try {
    const now = new Date();

    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);

    const monthStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      1
    );

    const [
      todaySales,
      monthSales,
      pendingOrders,
      inventoryStats,
      lowStockCount,
      lowStockProducts,
      recentOrders
    ] = await Promise.all([
      Order.aggregate([
        {
          $match: getPaidOrderFilter(todayStart, todayEnd)
        },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $ifNull: ['$total_kes', 0]
              }
            },
            count: {
              $sum: 1
            }
          }
        }
      ]),

      Order.aggregate([
        {
          $match: getPaidOrderFilter(monthStart, now)
        },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $ifNull: ['$total_kes', 0]
              }
            },
            count: {
              $sum: 1
            }
          }
        }
      ]),

      Order.countDocuments({
        order_status: {
          $in: ACTIVE_ORDER_STATUSES
        }
      }),

      Product.aggregate([
        {
          $match: {
            is_active: true
          }
        },
        {
          $group: {
            _id: null,
            total_products: {
              $sum: 1
            },
            total_units: {
              $sum: {
                $ifNull: ['$stock_qty', 0]
              }
            }
          }
        }
      ]),

      Product.countDocuments({
        is_active: true,
        $expr: {
          $lte: [
            {
              $ifNull: ['$stock_qty', 0]
            },
            {
              $ifNull: ['$low_stock_threshold', 0]
            }
          ]
        }
      }),

      Product.find({
        is_active: true,
        $expr: {
          $lte: [
            {
              $ifNull: ['$stock_qty', 0]
            },
            {
              $ifNull: ['$low_stock_threshold', 0]
            }
          ]
        }
      })
        .select(
          'name sku stock_qty low_stock_threshold price_kes'
        )
        .sort({
          stock_qty: 1,
          name: 1
        })
        .limit(10)
        .lean(),

      Order.find({})
        .select(
          'order_number customer_name total_kes payment_status order_status created_at'
        )
        .sort({
          created_at: -1,
          _id: -1
        })
        .limit(RECENT_ORDER_LIMIT)
        .lean()
    ]);

    const today = todaySales[0] || {
      total: 0,
      count: 0
    };

    const month = monthSales[0] || {
      total: 0,
      count: 0
    };

    const inventory = inventoryStats[0] || {
      total_products: 0,
      total_units: 0
    };

    const monthlyOrders = await Order.find(
      getPaidOrderFilter(monthStart, now)
    )
      .select('items')
      .lean();

    const productIds = getProductIdsFromOrders(monthlyOrders);
    const costMap = await getProductCostMap(productIds);

    let grossProfitMonth = 0;

    for (const order of monthlyOrders) {
      for (const item of order.items || []) {
        const revenue = getItemLineTotal(item);
        const cost = calculateCostOfGoods(item, costMap);

        grossProfitMonth += revenue - cost;
      }
    }

    return res.json({
      sales_today: {
        total: roundMoney(today.total),
        count: today.count
      },

      sales_month: {
        total: roundMoney(month.total),
        count: month.count
      },

      pending_orders: pendingOrders,

      low_stock_count: lowStockCount,

      total_products: inventory.total_products,

      total_stock_units: inventory.total_units,

      gross_profit_month: roundMoney(grossProfitMonth),

      recent_orders: recentOrders.map((order) => ({
        id: String(order._id),
        order_number: order.order_number,
        customer_name: order.customer_name,
        total_kes: order.total_kes,
        payment_status: order.payment_status,
        order_status: order.order_status,
        created_at: order.created_at
      })),

      low_stock_products: lowStockProducts.map((product) => ({
        id: String(product._id),
        name: product.name,
        sku: product.sku,
        stock_qty: toNumber(product.stock_qty),
        low_stock_threshold: toNumber(
          product.low_stock_threshold
        ),
        price_kes: toNumber(product.price_kes)
      }))
    });
  } catch (error) {
    logError('Dashboard generation failed', error);

    return res.status(500).json({
      error: 'Failed to load dashboard.'
    });
  }
};

exports.salesReport = async (req, res) => {
  try {
    const range = getDateRange(req.query);

    if (range.error) {
      return res.status(400).json({
        error: range.error
      });
    }

    const { from, to, start, end } = range;

    const paidOrders = await Order.find(
      getPaidOrderFilter(start, end)
    )
      .select(
        'order_number total_kes subtotal_kes delivery_fee_kes payment_method created_at items'
      )
      .sort({
        created_at: 1
      })
      .lean();

    const summary = {
      order_count: paidOrders.length,

      revenue: roundMoney(
        sum(paidOrders, (order) => order.total_kes)
      ),

      delivery_fees: roundMoney(
        sum(paidOrders, (order) => order.delivery_fee_kes)
      ),

      product_sales: roundMoney(
        sum(paidOrders, (order) => order.subtotal_kes)
      )
    };

    const byDayMap = new Map();
    const byPaymentMap = new Map();
    const productMap = new Map();

    const productIds = getProductIdsFromOrders(paidOrders);
    const costMap = await getProductCostMap(productIds);

    let grossProfit = 0;

    for (const order of paidOrders) {
      const day = formatDate(order.created_at);

      if (!byDayMap.has(day)) {
        byDayMap.set(day, {
          day,
          orders: 0,
          revenue: 0
        });
      }

      const dayEntry = byDayMap.get(day);

      dayEntry.orders += 1;
      dayEntry.revenue += toNumber(order.total_kes);

      const method = order.payment_method || 'unknown';

      if (!byPaymentMap.has(method)) {
        byPaymentMap.set(method, {
          payment_method: method,
          count: 0,
          total: 0
        });
      }

      const paymentEntry = byPaymentMap.get(method);

      paymentEntry.count += 1;
      paymentEntry.total += toNumber(order.total_kes);

      for (const item of order.items || []) {
        const productId = item.product_id
          ? String(item.product_id)
          : `unknown:${item.product_name || 'product'}`;

        if (!productMap.has(productId)) {
          productMap.set(productId, {
            product_name: item.product_name || 'Unknown product',
            sku: item.sku || null,
            qty_sold: 0,
            revenue: 0
          });
        }

        const productEntry = productMap.get(productId);

        const quantity = getItemQuantity(item);
        const lineTotal = getItemLineTotal(item);
        const cost = calculateCostOfGoods(item, costMap);

        productEntry.qty_sold += quantity;
        productEntry.revenue += lineTotal;

        grossProfit += lineTotal - cost;
      }
    }

    return res.json({
      from,
      to,

      summary: {
        ...summary,
        gross_profit: roundMoney(grossProfit)
      },

      by_day: [...byDayMap.values()]
        .map((item) => ({
          ...item,
          revenue: roundMoney(item.revenue)
        }))
        .sort((a, b) => a.day.localeCompare(b.day)),

      by_payment: [...byPaymentMap.values()].map((item) => ({
        ...item,
        total: roundMoney(item.total)
      })),

      top_products: [...productMap.values()]
        .map((item) => ({
          ...item,
          revenue: roundMoney(item.revenue)
        }))
        .sort((a, b) => {
          return (
            b.qty_sold - a.qty_sold ||
            b.revenue - a.revenue
          );
        })
        .slice(0, TOP_PRODUCTS_LIMIT)
    });
  } catch (error) {
    logError('Sales report generation failed', error);

    return res.status(500).json({
      error: 'Failed to generate sales report.'
    });
  }
};

exports.inventoryReport = async (req, res) => {
  try {
    const products = await Product.find({
      is_active: true
    })
      .select(
        'sku name stock_qty low_stock_threshold cost_kes price_kes category_id'
      )
      .populate({
        path: 'category_id',
        select: 'name'
      })
      .sort({
        name: 1
      })
      .lean();

    const list = products.map((product) => {
      const quantity = toNumber(product.stock_qty);
      const cost = toNumber(product.cost_kes);
      const price = toNumber(product.price_kes);
      const threshold = toNumber(
        product.low_stock_threshold
      );

      return {
        id: String(product._id),
        sku: product.sku || null,
        name: product.name,

        stock_qty: quantity,
        low_stock_threshold: threshold,

        cost_kes: cost,
        price_kes: price,

        stock_value_cost: roundMoney(quantity * cost),
        stock_value_retail: roundMoney(quantity * price),

        category_name: product.category_id
          ? product.category_id.name
          : null,

        is_low_stock: quantity <= threshold
      };
    });

    const totals = {
      products: list.length,

      units: sum(list, (product) => product.stock_qty),

      value_cost: roundMoney(
        sum(list, (product) => product.stock_value_cost)
      ),

      value_retail: roundMoney(
        sum(list, (product) => product.stock_value_retail)
      ),

      potential_margin: roundMoney(
        sum(list, (product) =>
          product.stock_value_retail - product.stock_value_cost
        )
      ),

      low_stock: list.filter(
        (product) => product.is_low_stock
      ).length,

      out_of_stock: list.filter(
        (product) => product.stock_qty <= 0
      ).length
    };

    return res.json({
      generated_at: new Date(),
      currency: 'KES',
      products: list,
      totals
    });
  } catch (error) {
    logError('Inventory report generation failed', error);

    return res.status(500).json({
      error: 'Failed to generate inventory report.'
    });
  }
};

exports.profitLoss = async (req, res) => {
  try {
    const range = getDateRange(req.query);

    if (range.error) {
      return res.status(400).json({
        error: range.error
      });
    }

    const { from, to, start, end } = range;

    const [orders, expenses] = await Promise.all([
      Order.find(getPaidOrderFilter(start, end))
        .select(
          'total_kes subtotal_kes delivery_fee_kes items created_at'
        )
        .sort({
          created_at: 1
        })
        .lean(),

      Expense.find({
        expense_date: {
          $gte: from,
          $lte: to
        }
      })
        .select(
          'category description amount_kes expense_date'
        )
        .sort({
          expense_date: 1
        })
        .lean()
    ]);

    const productIds = getProductIdsFromOrders(orders);
    const costMap = await getProductCostMap(productIds);

    let grossSales = 0;
    let productSales = 0;
    let deliveryIncome = 0;
    let costOfGoodsSold = 0;
    let totalItemsSold = 0;

    const dailyMap = new Map();
    const expenseCategories = new Map();

    for (const order of orders) {
      const orderTotal = toNumber(order.total_kes);
      const subtotal = toNumber(order.subtotal_kes);
      const deliveryFee = toNumber(order.delivery_fee_kes);

      grossSales += orderTotal;
      productSales += subtotal;
      deliveryIncome += deliveryFee;

      const day = formatDate(order.created_at);

      if (!dailyMap.has(day)) {
        dailyMap.set(day, {
          day,
          orders: 0,
          sales_kes: 0,
          product_cost_kes: 0
        });
      }

      const daily = dailyMap.get(day);

      daily.orders += 1;
      daily.sales_kes += orderTotal;

      for (const item of order.items || []) {
        const quantity = getItemQuantity(item);
        const itemCost = calculateCostOfGoods(item, costMap);

        totalItemsSold += quantity;
        costOfGoodsSold += itemCost;

        daily.product_cost_kes += itemCost;
      }
    }

    let totalExpenses = 0;

    for (const expense of expenses) {
      const amount = toNumber(expense.amount_kes);

      totalExpenses += amount;

      const category = expense.category || 'Other';

      if (!expenseCategories.has(category)) {
        expenseCategories.set(category, {
          category,
          amount_kes: 0,
          count: 0
        });
      }

      const categoryEntry = expenseCategories.get(category);

      categoryEntry.amount_kes += amount;
      categoryEntry.count += 1;
    }

    const grossProfit = productSales - costOfGoodsSold;

    const operatingProfit = grossProfit + deliveryIncome;

    const netProfit = operatingProfit - totalExpenses;

    return res.json({
      period: {
        from,
        to
      },

      generated_at: new Date(),

      currency: 'KES',

      summary: {
        order_count: orders.length,
        items_sold: totalItemsSold,

        gross_sales_kes: roundMoney(grossSales),
        product_sales_kes: roundMoney(productSales),
        delivery_income_kes: roundMoney(deliveryIncome),

        cost_of_goods_sold_kes: roundMoney(
          costOfGoodsSold
        ),

        gross_profit_kes: roundMoney(grossProfit),

        operating_profit_kes: roundMoney(
          operatingProfit
        ),

        operating_expenses_kes: roundMoney(
          totalExpenses
        ),

        net_profit_kes: roundMoney(netProfit),

        profit_margin_percent: productSales > 0
          ? roundMoney(
              (grossProfit / productSales) * 100
            )
          : 0
      },

      by_day: [...dailyMap.values()]
        .map((item) => ({
          ...item,
          sales_kes: roundMoney(item.sales_kes),
          product_cost_kes: roundMoney(
            item.product_cost_kes
          )
        }))
        .sort((a, b) => a.day.localeCompare(b.day)),

      expense_breakdown: [...expenseCategories.values()]
        .map((item) => ({
          ...item,
          amount_kes: roundMoney(item.amount_kes)
        }))
        .sort((a, b) => b.amount_kes - a.amount_kes),

      expenses: expenses.map((expense) => ({
        id: String(expense._id),
        category: expense.category,
        description: expense.description,
        amount_kes: expense.amount_kes,
        expense_date: expense.expense_date
      })),

      notes: [
        'Only paid orders are included in sales calculations.',
        'Historical item.unit_cost_kes is used when available; otherwise current Product.cost_kes is used.',
        'Delivery income is added separately to product gross profit.',
        'Recorded expenses are deducted from operating profit.',
        'Refunds, taxes, payment processing fees and delivery operating costs should be recorded separately for more complete accounting.'
      ]
    });
  } catch (error) {
    logError('Profit and loss report generation failed', error);

    return res.status(500).json({
      error: 'Failed to generate profit and loss report.'
    });
  }
};

exports.validDateRange = validDateRange;
exports.getDateRange = getDateRange;
exports.startOfDay = startOfDay;
exports.endOfDay = endOfDay;
exports.roundMoney = roundMoney;