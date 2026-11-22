
const { Order, Product, Category, Expense } = require('../models');
const { serializeMany } = require('../utils/helpers');

// ==================================================
// DATE HELPERS
// ==================================================

function startOfDay(date) {
  const x = new Date(date);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(date) {
  const x = new Date(date);
  x.setHours(23, 59, 59, 999);
  return x;
}

function validDateRange(from, to) {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;

  if (!datePattern.test(from) || !datePattern.test(to)) {
    return false;
  }

  const fromDate = new Date(`${from}T00:00:00`);
  const toDate = new Date(`${to}T00:00:00`);

  return (
    !Number.isNaN(fromDate.getTime()) &&
    !Number.isNaN(toDate.getTime()) &&
    fromDate.toISOString().slice(0, 10) === from &&
    toDate.toISOString().slice(0, 10) === to &&
    from <= to
  );
}

// ==================================================
// DASHBOARD
// ==================================================

exports.dashboard = async (req, res) => {
  try {
    const now = new Date();
    const todayStart = startOfDay(now);
    const monthStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      1
    );

    const paidToday = await Order.find({
      payment_status: 'paid',
      created_at: { $gte: todayStart }
    });

    const paidMonth = await Order.find({
      payment_status: 'paid',
      created_at: { $gte: monthStart }
    });

    const pending_orders = await Order.countDocuments({
      order_status: {
        $in: [
          'pending',
          'confirmed',
          'processing',
          'ready',
          'out_for_delivery'
        ]
      }
    });

    const activeProducts = await Product.find({
      is_active: true
    });

    const low_stock_products = activeProducts
      .filter(
        (p) => p.stock_qty <= p.low_stock_threshold
      )
      .sort((a, b) => a.stock_qty - b.stock_qty)
      .slice(0, 10)
      .map((p) => ({
        id: String(p._id),
        name: p.name,
        sku: p.sku,
        stock_qty: p.stock_qty,
        low_stock_threshold: p.low_stock_threshold,
        price_kes: p.price_kes
      }));

    let gross_profit_month = 0;

    const productIds = [
      ...new Set(
        paidMonth.flatMap((order) =>
          (order.items || [])
            .map((item) => item.product_id)
            .filter(Boolean)
            .map(String)
        )
      )
    ];

    const products = productIds.length
      ? await Product.find({
          _id: { $in: productIds }
        }).select('cost_kes')
      : [];

    const costMap = new Map(
      products.map((p) => [
        String(p._id),
        Number(p.cost_kes) || 0
      ])
    );

    for (const order of paidMonth) {
      for (const item of order.items || []) {
        const cost = costMap.get(String(item.product_id)) || 0;

        gross_profit_month +=
          (
            Number(item.unit_price_kes) - cost
          ) * Number(item.quantity);
      }
    }

    const recent = await Order.find()
      .sort({ created_at: -1 })
      .limit(8);

    res.json({
      sales_today: {
        total: paidToday.reduce(
          (sum, order) => sum + Number(order.total_kes || 0),
          0
        ),
        count: paidToday.length
      },

      sales_month: {
        total: paidMonth.reduce(
          (sum, order) => sum + Number(order.total_kes || 0),
          0
        ),
        count: paidMonth.length
      },

      pending_orders,

      low_stock_count: activeProducts.filter(
        (p) => p.stock_qty <= p.low_stock_threshold
      ).length,

      total_products: activeProducts.length,
      gross_profit_month,

      recent_orders: recent.map((o) => ({
        id: String(o._id),
        order_number: o.order_number,
        customer_name: o.customer_name,
        total_kes: o.total_kes,
        payment_status: o.payment_status,
        order_status: o.order_status,
        created_at: o.created_at
      })),

      low_stock_products
    });

  } catch (err) {
    console.error('Dashboard error:', err);

    res.status(500).json({
      error: 'Failed to load dashboard'
    });
  }
};

// ==================================================
// SALES REPORT
// ==================================================

exports.salesReport = async (req, res) => {
  try {
    const from =
      req.query.from ||
      new Date(
        new Date().getFullYear(),
        new Date().getMonth(),
        1
      ).toISOString().slice(0, 10);

    const to =
      req.query.to ||
      new Date().toISOString().slice(0, 10);

    if (!validDateRange(from, to)) {
      return res.status(400).json({
        error: 'Invalid date range. Use YYYY-MM-DD.'
      });
    }

    const paid = await Order.find({
      payment_status: 'paid',
      created_at: {
        $gte: startOfDay(from),
        $lte: endOfDay(to)
      }
    });

    const summary = {
      order_count: paid.length,

      revenue: paid.reduce(
        (sum, o) => sum + Number(o.total_kes || 0),
        0
      ),

      delivery_fees: paid.reduce(
        (sum, o) => sum + Number(o.delivery_fee_kes || 0),
        0
      ),

      product_sales: paid.reduce(
        (sum, o) => sum + Number(o.subtotal_kes || 0),
        0
      )
    };

    const byDayMap = {};
    const byPayMap = {};
    const productMap = {};

    let gross_profit = 0;

    const productIds = [
      ...new Set(
        paid.flatMap((order) =>
          (order.items || [])
            .map((item) => item.product_id)
            .filter(Boolean)
            .map(String)
        )
      )
    ];

    const products = productIds.length
      ? await Product.find({
          _id: { $in: productIds }
        }).select('cost_kes')
      : [];

    const costMap = new Map(
      products.map((p) => [
        String(p._id),
        Number(p.cost_kes) || 0
      ])
    );

    for (const o of paid) {
      const day = new Date(o.created_at)
        .toISOString()
        .slice(0, 10);

      if (!byDayMap[day]) {
        byDayMap[day] = {
          day,
          orders: 0,
          revenue: 0
        };
      }

      byDayMap[day].orders++;
      byDayMap[day].revenue += Number(o.total_kes || 0);

      const method = o.payment_method || 'unknown';

      if (!byPayMap[method]) {
        byPayMap[method] = {
          payment_method: method,
          count: 0,
          total: 0
        };
      }

      byPayMap[method].count++;
      byPayMap[method].total += Number(o.total_kes || 0);

      for (const item of o.items || []) {
        const key = String(item.product_id);

        if (!productMap[key]) {
          productMap[key] = {
            product_name: item.product_name,
            sku: item.sku,
            qty_sold: 0,
            revenue: 0
          };
        }

        const quantity = Number(item.quantity) || 0;
        const unitPrice = Number(item.unit_price_kes) || 0;
        const lineTotal = Number(item.line_total_kes) || 0;
        const cost = costMap.get(key) || 0;

        productMap[key].qty_sold += quantity;
        productMap[key].revenue += lineTotal;

        gross_profit += (unitPrice - cost) * quantity;
      }
    }

    res.json({
      from,
      to,

      summary: {
        ...summary,
        gross_profit
      },

      by_day: Object.values(byDayMap).sort(
        (a, b) => a.day.localeCompare(b.day)
      ),

      by_payment: Object.values(byPayMap),

      top_products: Object.values(productMap)
        .sort((a, b) => b.qty_sold - a.qty_sold)
        .slice(0, 15)
    });

  } catch (err) {
    console.error('Sales report error:', err);

    res.status(500).json({
      error: 'Failed to generate sales report'
    });
  }
};

// ==================================================
// INVENTORY REPORT
// ==================================================

exports.inventoryReport = async (req, res) => {
  try {
    const products = await Product.find({
      is_active: true
    })
      .populate('category_id', 'name')
      .sort({ name: 1 });

    const list = products.map((p) => ({
      id: String(p._id),
      sku: p.sku,
      name: p.name,
      stock_qty: p.stock_qty,
      low_stock_threshold: p.low_stock_threshold,
      cost_kes: p.cost_kes,
      price_kes: p.price_kes,

      stock_value_cost:
        p.stock_qty * (p.cost_kes || 0),

      stock_value_retail:
        p.stock_qty * p.price_kes,

      category_name:
        p.category_id ? p.category_id.name : null
    }));

    const totals = {
      units: list.reduce(
        (sum, p) => sum + p.stock_qty,
        0
      ),

      value_cost: list.reduce(
        (sum, p) => sum + p.stock_value_cost,
        0
      ),

      value_retail: list.reduce(
        (sum, p) => sum + p.stock_value_retail,
        0
      ),

      low_stock: list.filter(
        (p) => p.stock_qty <= p.low_stock_threshold
      ).length
    };

    res.json({
      products: list,
      totals
    });

  } catch (err) {
    console.error('Inventory report error:', err);

    res.status(500).json({
      error: 'Failed to generate inventory report'
    });
  }
};

// ==================================================
// PROFIT AND LOSS REPORT
// ==================================================

exports.profitLoss = async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const from =
      req.query.from ||
      new Date(
        new Date().getFullYear(),
        new Date().getMonth(),
        1
      ).toISOString().slice(0, 10);

    const to = req.query.to || today;

    if (!validDateRange(from, to)) {
      return res.status(400).json({
        error: 'Invalid date range. Use YYYY-MM-DD.'
      });
    }

    // Only paid orders count as recognized sales here.
    const orders = await Order.find({
      payment_status: 'paid',
      created_at: {
        $gte: startOfDay(from),
        $lte: endOfDay(to)
      }
    });

    // Operating expenses use the expense_date field.
    const expenses = await Expense.find({
      expense_date: {
        $gte: from,
        $lte: to
      }
    }).sort({ expense_date: 1 });

    // Calculate sales.
    let grossSales = 0;
    let productSales = 0;
    let deliveryIncome = 0;
    let costOfGoodsSold = 0;
    let totalItemsSold = 0;

    const productIds = [
      ...new Set(
        orders.flatMap((order) =>
          (order.items || [])
            .map((item) => item.product_id)
            .filter(Boolean)
            .map(String)
        )
      )
    ];

    const products = productIds.length
      ? await Product.find({
          _id: { $in: productIds }
        }).select('cost_kes name sku')
      : [];

    const costMap = new Map(
      products.map((product) => [
        String(product._id),
        Number(product.cost_kes) || 0
      ])
    );

    for (const order of orders) {
      grossSales += Number(order.total_kes || 0);
      productSales += Number(order.subtotal_kes || 0);
      deliveryIncome += Number(order.delivery_fee_kes || 0);

      for (const item of order.items || []) {
        const quantity = Number(item.quantity) || 0;
        const cost = costMap.get(String(item.product_id)) || 0;

        totalItemsSold += quantity;
        costOfGoodsSold += cost * quantity;
      }
    }

    // Calculate gross profit.
    const grossProfit = productSales - costOfGoodsSold;

    // Calculate operating expenses.
    const totalExpenses = expenses.reduce(
      (sum, expense) =>
        sum + Number(expense.amount_kes || 0),
      0
    );

    // Delivery income is included, but delivery costs
    // are not available in the current known schema.
    const netProfit =
      grossProfit + deliveryIncome - totalExpenses;

    // Group expenses by category.
    const expenseCategories = {};

    for (const expense of expenses) {
      const category = expense.category || 'Other';

      if (!expenseCategories[category]) {
        expenseCategories[category] = {
          category,
          amount_kes: 0,
          count: 0
        };
      }

      expenseCategories[category].amount_kes +=
        Number(expense.amount_kes || 0);

      expenseCategories[category].count++;
    }

    res.json({
      period: {
        from,
        to
      },

      currency: 'KES',

      summary: {
        order_count: orders.length,
        items_sold: totalItemsSold,

        gross_sales_kes: grossSales,
        product_sales_kes: productSales,
        delivery_income_kes: deliveryIncome,

        cost_of_goods_sold_kes: costOfGoodsSold,

        gross_profit_kes: grossProfit,

        operating_expenses_kes: totalExpenses,

        net_profit_kes: netProfit
      },

      expense_breakdown: Object.values(
        expenseCategories
      ).sort(
        (a, b) => b.amount_kes - a.amount_kes
      ),

      expenses: expenses.map((expense) => ({
        id: String(expense._id),
        category: expense.category,
        description: expense.description,
        amount_kes: expense.amount_kes,
        expense_date: expense.expense_date
      })),

      notes: [
        'Only paid orders are included in sales.',
        'Product costs use the current Product.cost_kes value, not a historical purchase cost.',
        'Delivery income is included in net profit; delivery operating costs are not separately recorded here.',
        'Taxes, refunds, payment fees and discounts require separate accounting treatment if applicable.'
      ]
    });

  } catch (err) {
    console.error('Profit and loss report error:', err);

    res.status(500).json({
      error: 'Failed to generate profit and loss report'
    });
  }
};