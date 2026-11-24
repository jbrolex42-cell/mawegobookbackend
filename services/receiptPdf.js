
'use strict';

/**
 * =============================================================================
 * MAWEGO BOOKSHOP - PROFESSIONAL PDF RECEIPT GENERATOR
 * =============================================================================
 *
 * Features:
 * - Professional A4 receipt design
 * - Mawego Bookshop branding
 * - Customer and order information
 * - Receipt and order numbers
 * - M-Pesa payment information
 * - Product itemized table
 * - Automatic multi-page support
 * - Automatic page numbering
 * - Financial calculations and validation
 * - Discount and delivery breakdown
 * - Nairobi timezone formatting
 * - Kenyan currency formatting
 * - Safe text handling
 * - Buffer-based PDF generation for email attachments
 *
 * Dependency:
 * npm install pdfkit
 *
 * Export:
 * generateReceiptPdf(order)
 *
 * =============================================================================
 */

const PDFDocument = require('pdfkit');

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const CONFIG = Object.freeze({
  PAGE_SIZE: 'A4',

  MARGIN: 45,

  BRAND: 'MAWEGO BOOKSHOP',

  TAGLINE: 'Books, Stationery & Learning Materials',

  FOOTER: 'Mawego Bookshop | Kenya | Prices in KES',

  CURRENCY: 'KES',

  TIMEZONE: 'Africa/Nairobi',

  COLORS: {
    primary: '#08734E',
    primaryDark: '#07583D',
    text: '#222222',
    muted: '#666666',
    border: '#DCE5DF',
    light: '#F3F8F5',
    white: '#FFFFFF',
    success: '#08734E'
  },

  FONTS: {
    regular: 'Helvetica',
    bold: 'Helvetica-Bold',
    italic: 'Helvetica-Oblique'
  }
});

/* -------------------------------------------------------------------------- */
/* General Helpers                                                            */
/* -------------------------------------------------------------------------- */

function firstDefined(...values) {
  return values.find(
    value => value !== undefined && value !== null
  );
}

function cleanText(value, fallback = 'N/A') {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ''
  ) {
    return fallback;
  }

  return String(value).trim();
}

function toNumber(value, fallback = 0) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return number;
}

function money(value) {
  const amount = toNumber(value);

  return `${CONFIG.CURRENCY} ${amount.toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function formatDate(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'N/A';
  }

  return new Intl.DateTimeFormat('en-KE', {
    timeZone: CONFIG.TIMEZONE,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

function getOrderId(order) {
  return cleanText(order._id, 'UNKNOWN');
}

function getOrderNumber(order) {
  return cleanText(
    firstDefined(
      order.order_number,
      order.orderNumber
    ),
    getOrderId(order)
  );
}

function getReceiptNumber(order, createdAt) {
  const existing = firstDefined(
    order.receipt_number,
    order.receiptNumber
  );

  if (existing) {
    return cleanText(existing);
  }

  const year = new Date(createdAt).getFullYear();

  const id = getOrderId(order)
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-8)
    .toUpperCase();

  return `MB-${year}-${id || 'RECEIPT'}`;
}

/* -------------------------------------------------------------------------- */
/* Order Date                                                                 */
/* -------------------------------------------------------------------------- */

function getCreatedAt(order) {
  return firstDefined(
    order.created_at,
    order.createdAt,
    order.paid_at,
    order.paidAt,
    new Date()
  );
}

/* -------------------------------------------------------------------------- */
/* Customer Information                                                       */
/* -------------------------------------------------------------------------- */

function getCustomerDetails(order) {
  const customer = order.customer || {};

  return {
    name: cleanText(
      firstDefined(
        order.customer_name,
        order.customerName,
        order.full_name,
        customer.name
      ),
      'Customer'
    ),

    email: cleanText(
      firstDefined(
        order.customer_email,
        order.email,
        customer.email
      )
    ),

    phone: cleanText(
      firstDefined(
        order.customer_phone,
        order.phone,
        customer.phone
      )
    ),

    address: cleanText(
      firstDefined(
        order.delivery_address,
        order.shipping_address,
        order.address,
        customer.address
      )
    )
  };
}

/* -------------------------------------------------------------------------- */
/* Product Normalization                                                      */
/* -------------------------------------------------------------------------- */

function normalizeItems(order) {
  const items = firstDefined(
    order.items,
    order.order_items,
    order.orderItems,
    []
  );

  if (!Array.isArray(items)) {
    return [];
  }

  return items.map(item => {
    const quantity = Math.max(
      0,
      toNumber(
        firstDefined(
          item.quantity,
          item.qty
        ), 1
      )
    );

    const unitPrice = Math.max(
      0,
      toNumber(
        firstDefined(
          item.unit_price_kes,
          item.price_kes,
          item.unit_price,
          item.price
        )
      )
    );

    const calculatedTotal = quantity * unitPrice;

    const lineTotal = Math.max(
      0,
      toNumber(
        firstDefined(
          item.line_total_kes,
          item.line_total,
          item.total
        ),
        calculatedTotal
      )
    );

    return {
      name: cleanText(
        firstDefined(
          item.product_name,
          item.name,
          item.title,
          item.product?.name
        ),
        'Product'
      ),

      quantity,

      unitPrice,

      lineTotal
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Financial Information                                                      */
/* -------------------------------------------------------------------------- */

function getFinancialDetails(order, items) {
  const calculatedSubtotal = items.reduce(
    (sum, item) => sum + item.lineTotal,
    0
  );

  const subtotal = Math.max(
    0,
    toNumber(
      firstDefined(
        order.subtotal_kes,
        order.subtotal,
        order.items_subtotal_kes
      ),
      calculatedSubtotal
    )
  );

  const discount = Math.max(
    0,
    toNumber(
      firstDefined(
        order.discount_total_kes,
        order.discount_kes,
        order.discount_amount,
        order.discount
      )
    )
  );

  const delivery = Math.max(
    0,
    toNumber(
      firstDefined(
        order.delivery_fee_kes,
        order.delivery_kes,
        order.delivery_fee,
        order.shipping_fee
      )
    )
  );

  const calculatedTotal = Math.max(
    0,
    subtotal - discount + delivery
  );

  const total = Math.max(
    0,
    toNumber(
      firstDefined(
        order.total_kes,
        order.total_amount,
        order.total
      ),
      calculatedTotal
    )
  );

  return {
    subtotal,
    discount,
    delivery,
    total
  };
}

/* -------------------------------------------------------------------------- */
/* Payment Information                                                        */
/* -------------------------------------------------------------------------- */

function getPaymentDetails(order) {
  return {
    method: cleanText(
      firstDefined(
        order.payment_method,
        order.paymentMethod
      )
    ),

    status: cleanText(
      firstDefined(
        order.payment_status,
        order.paymentStatus
      ),
      'Pending'
    ),

    mpesaReference: cleanText(
      firstDefined(
        order.mpesa_receipt,
        order.mpesa_receipt_number,
        order.mpesaReceiptNumber,
        order.mpesa_transaction_id
      ),
      ''
    ),

    transactionId: cleanText(
      firstDefined(
        order.mpesa_transaction_id,
        order.transaction_id,
        order.transactionId
      ),
      ''
    )
  };
}

/* -------------------------------------------------------------------------- */
/* PDF Layout Helpers                                                         */
/* -------------------------------------------------------------------------- */

function drawHorizontalLine(doc, y, color = CONFIG.COLORS.border) {
  doc.save();

  doc
    .moveTo(CONFIG.MARGIN, y)
    .lineTo(doc.page.width - CONFIG.MARGIN, y)
    .lineWidth(0.7)
    .strokeColor(color)
    .stroke();

  doc.restore();
}

function drawSectionTitle(doc, title) {
  doc
    .font(CONFIG.FONTS.bold)
    .fontSize(10)
    .fillColor(CONFIG.COLORS.primary)
    .text(title.toUpperCase(), {
      characterSpacing: 0.5
    });

  doc.moveDown(0.6);
}

function drawLabelValue(doc, label, value, x, y, width = 240) {
  doc
    .font(CONFIG.FONTS.bold)
    .fontSize(9)
    .fillColor(CONFIG.COLORS.muted)
    .text(`${label}:`, x, y, {
      width: 85,
      lineBreak: false
    });

  doc
    .font(CONFIG.FONTS.regular)
    .fontSize(9)
    .fillColor(CONFIG.COLORS.text)
    .text(cleanText(value), x + 85, y, {
      width: width - 85
    });
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

function drawHeader(doc, receiptNumber, orderNumber) {
  const margin = CONFIG.MARGIN;
  const pageWidth = doc.page.width;

  doc
    .save()
    .rect(0, 0, pageWidth, 132)
    .fill(CONFIG.COLORS.light)
    .restore();

  doc
    .font(CONFIG.FONTS.bold)
    .fontSize(23)
    .fillColor(CONFIG.COLORS.primary)
    .text(CONFIG.BRAND, margin, 35, {
      width: pageWidth - margin * 2,
      align: 'center'
    });

  doc
    .font(CONFIG.FONTS.regular)
    .fontSize(9)
    .fillColor(CONFIG.COLORS.muted)
    .text(CONFIG.TAGLINE, {
      align: 'center'
    });

  doc.moveDown(1.4);

  doc
    .font(CONFIG.FONTS.bold)
    .fontSize(17)
    .fillColor(CONFIG.COLORS.text)
    .text('SALES RECEIPT', {
      align: 'center'
    });

  doc.moveDown(0.6);

  doc
    .font(CONFIG.FONTS.regular)
    .fontSize(8)
    .fillColor(CONFIG.COLORS.muted)
    .text(`Receipt: ${receiptNumber}  |  Order: ${orderNumber}`, {
      align: 'center'
    });

  doc.y = 150;

  drawHorizontalLine(doc, 145);
}

/* -------------------------------------------------------------------------- */
/* Customer Details                                                           */
/* -------------------------------------------------------------------------- */

function drawCustomerSection(doc, customer, createdAt) {
  drawSectionTitle(doc, 'Customer Information');

  const startY = doc.y;

  drawLabelValue(
    doc,
    'Customer',
    customer.name,
    CONFIG.MARGIN,
    startY
  );

  drawLabelValue(
    doc,
    'Date',
    formatDate(createdAt),
    315,
    startY
  );

  drawLabelValue(
    doc,
    'Email',
    customer.email,
    CONFIG.MARGIN,
    startY + 20
  );

  drawLabelValue(
    doc,
    'Phone',
    customer.phone,
    315,
    startY + 20
  );

  if (customer.address !== 'N/A') {
    drawLabelValue(
      doc,
      'Address',
      customer.address,
      CONFIG.MARGIN,
      startY + 40,
      doc.page.width - CONFIG.MARGIN * 2
    );

    doc.y = startY + 65;
  } else {
    doc.y = startY + 45;
  }

  doc.moveDown(0.6);

  drawHorizontalLine(doc, doc.y);
  doc.moveDown(1);
}

/* -------------------------------------------------------------------------- */
/* Purchase Table                                                             */
/* -------------------------------------------------------------------------- */

const TABLE = Object.freeze({
  product: 45,
  quantity: 325,
  price: 385,
  total: 475,

  productWidth: 265,
  quantityWidth: 45,
  priceWidth: 85,
  totalWidth: 80
});

function drawTableHeader(doc) {
  const y = doc.y;

  doc
    .save()
    .rect(
      CONFIG.MARGIN,
      y - 5,
      doc.page.width - CONFIG.MARGIN * 2,
      25
    )
    .fill(CONFIG.COLORS.light)
    .restore();

  doc
    .font(CONFIG.FONTS.bold)
    .fontSize(8)
    .fillColor(CONFIG.COLORS.text);

  doc.text('PRODUCT', TABLE.product, y + 2, {
    width: TABLE.productWidth
  });

  doc.text('QTY', TABLE.quantity, y + 2, {
    width: TABLE.quantityWidth,
    align: 'center'
  });

  doc.text('UNIT PRICE', TABLE.price, y + 2, {
    width: TABLE.priceWidth,
    align: 'right'
  });

  doc.text('TOTAL', TABLE.total, y + 2, {
    width: TABLE.totalWidth,
    align: 'right'
  });

  doc.y = y + 29;
}

function drawProductRow(doc, item, index) {
  const fontSize = 8.5;

  doc.font(CONFIG.FONTS.regular).fontSize(fontSize);

  const productHeight = doc.heightOfString(item.name, {
    width: TABLE.productWidth,
    font: CONFIG.FONTS.regular,
    fontSize
  });

  const rowHeight = Math.max(productHeight, 15) + 12;

  const bottomLimit = doc.page.height - 90;

  if (doc.y + rowHeight > bottomLimit) {
    doc.addPage();
    doc.y = CONFIG.MARGIN + 10;
    drawTableHeader(doc);
  }

  const y = doc.y;

  if (index % 2 === 1) {
    doc
      .save()
      .rect(
        CONFIG.MARGIN,
        y - 4,
        doc.page.width - CONFIG.MARGIN * 2,
        rowHeight
      )
      .fill('#FAFCFA')
      .restore();
  }

  doc
    .font(CONFIG.FONTS.regular)
    .fontSize(fontSize)
    .fillColor(CONFIG.COLORS.text);

  doc.text(item.name, TABLE.product, y, {
    width: TABLE.productWidth
  });

  doc.text(String(item.quantity), TABLE.quantity, y, {
    width: TABLE.quantityWidth,
    align: 'center'
  });

  doc.text(money(item.unitPrice), TABLE.price, y, {
    width: TABLE.priceWidth,
    align: 'right'
  });

  doc.text(money(item.lineTotal), TABLE.total, y, {
    width: TABLE.totalWidth,
    align: 'right'
  });

  doc.y = y + rowHeight;

  drawHorizontalLine(doc, doc.y, '#EDF1EE');
}

/* -------------------------------------------------------------------------- */
/* Financial Summary                                                          */
/* -------------------------------------------------------------------------- */

function ensureSpace(doc, requiredHeight) {
  const bottomLimit = doc.page.height - 90;

  if (doc.y + requiredHeight > bottomLimit) {
    doc.addPage();
    doc.y = CONFIG.MARGIN + 10;
  }
}

function drawFinancialSummary(doc, financial) {
  ensureSpace(doc, 135);

  doc.moveDown(1);

  const labelX = 330;
  const valueX = 445;
  const valueWidth = 110;

  function drawSummaryRow(label, value, options = {}) {
    const y = doc.y;

    doc
      .font(options.bold ? CONFIG.FONTS.bold : CONFIG.FONTS.regular)
      .fontSize(options.fontSize || 9)
      .fillColor(
        options.color || CONFIG.COLORS.text
      )
      .text(label, labelX, y, {
        width: 110
      });

    doc
      .font(options.bold ? CONFIG.FONTS.bold : CONFIG.FONTS.regular)
      .fontSize(options.fontSize || 9)
      .fillColor(
        options.color || CONFIG.COLORS.text
      )
      .text(money(value), valueX, y, {
        width: valueWidth,
        align: 'right'
      });

    doc.y = y + (options.spacing || 19);
  }

  drawSummaryRow('Subtotal', financial.subtotal);

  drawSummaryRow('Discount', -financial.discount);

  drawSummaryRow('Delivery', financial.delivery);

  drawHorizontalLine(doc, doc.y + 1);

  doc.moveDown(0.6);

  drawSummaryRow(
    'TOTAL PAID',
    financial.total,
    {
      bold: true,
      fontSize: 14,
      color: CONFIG.COLORS.primary,
      spacing: 25
    }
  );
}

/* -------------------------------------------------------------------------- */
/* Payment Details                                                            */
/* -------------------------------------------------------------------------- */

function drawPaymentSection(doc, payment) {
  ensureSpace(doc, 100);

  doc.moveDown(0.5);

  drawHorizontalLine(doc, doc.y);

  doc.moveDown(1);

  drawSectionTitle(doc, 'Payment Information');

  const startY = doc.y;

  drawLabelValue(
    doc,
    'Method',
    payment.method,
    CONFIG.MARGIN,
    startY
  );

  drawLabelValue(
    doc,
    'Status',
    payment.status,
    315,
    startY
  );

  if (payment.mpesaReference) {
    drawLabelValue(
      doc,
      'M-Pesa Ref',
      payment.mpesaReference,
      CONFIG.MARGIN,
      startY + 20,
      doc.page.width - CONFIG.MARGIN * 2
    );

    doc.y = startY + 42;
  } else {
    doc.y = startY + 22;
  }
}

/* -------------------------------------------------------------------------- */
/* Receipt Footer                                                             */
/* -------------------------------------------------------------------------- */

function drawThankYou(doc) {
  ensureSpace(doc, 65);

  doc.moveDown(1);

  doc
    .font(CONFIG.FONTS.bold)
    .fontSize(12)
    .fillColor(CONFIG.COLORS.primary)
    .text('Thank you for shopping with us!', {
      align: 'center'
    });

  doc.moveDown(0.4);

  doc
    .font(CONFIG.FONTS.regular)
    .fontSize(8)
    .fillColor(CONFIG.COLORS.muted)
    .text(CONFIG.FOOTER, {
      align: 'center'
    });
}

/* -------------------------------------------------------------------------- */
/* Page Numbering                                                             */
/* -------------------------------------------------------------------------- */

function addPageNumbers(doc) {
  const range = doc.bufferedPageRange();

  for (
    let index = range.start;
    index < range.start + range.count;
    index++
  ) {
    doc.switchToPage(index);

    const pageNumber = index + 1;

    const footerY = doc.page.height - 35;

    doc
      .save()
      .font(CONFIG.FONTS.regular)
      .fontSize(8)
      .fillColor(CONFIG.COLORS.muted)
      .text(
        `Mawego Bookshop | Page ${pageNumber} of ${range.count}`,
        CONFIG.MARGIN,
        footerY,
        {
          width: doc.page.width - CONFIG.MARGIN * 2,
          align: 'center',
          lineBreak: false
        }
      )
      .restore();
  }
}

/* -------------------------------------------------------------------------- */
/* Main PDF Generator                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Generates a PDF receipt and returns a Buffer.
 *
 * @param {Object} order - Paid order document or plain object.
 * @returns {Promise<Buffer>}
 */
function generateReceiptPdf(order) {
  return new Promise((resolve, reject) => {
    if (!order || typeof order !== 'object') {
      reject(new Error('A valid order is required.'));
      return;
    }

    try {
      const doc = new PDFDocument({
        size: CONFIG.PAGE_SIZE,
        margins: {
          top: CONFIG.MARGIN,
          bottom: CONFIG.MARGIN,
          left: CONFIG.MARGIN,
          right: CONFIG.MARGIN
        },
        bufferPages: true,
        autoFirstPage: true,
        compress: true,
        info: {
          Title: 'Mawego Bookshop Sales Receipt',
          Author: CONFIG.BRAND,
          Subject: 'Customer purchase receipt',
          Creator: CONFIG.BRAND
        }
      });

      const chunks = [];

      let settled = false;

      function fail(error) {
        if (settled) return;

        settled = true;
        reject(error);
      }

      doc.on('data', chunk => {
        chunks.push(chunk);
      });

      doc.on('error', fail);

      doc.on('end', () => {
        if (settled) return;

        settled = true;
        resolve(Buffer.concat(chunks));
      });

      const createdAt = getCreatedAt(order);

      const receiptNumber = getReceiptNumber(
        order,
        createdAt
      );

      const orderNumber = getOrderNumber(order);

      const customer = getCustomerDetails(order);

      const items = normalizeItems(order);

      const financial = getFinancialDetails(
        order,
        items
      );

      const payment = getPaymentDetails(order);

      // Header and customer information.
      drawHeader(
        doc,
        receiptNumber,
        orderNumber
      );

      drawCustomerSection(
        doc,
        customer,
        createdAt
      );

      // Product table.
      drawSectionTitle(
        doc,
        'Purchase Details'
      );

      drawTableHeader(doc);

      if (!items.length) {
        doc
          .font(CONFIG.FONTS.italic)
          .fontSize(9)
          .fillColor(CONFIG.COLORS.muted)
          .text('No product items recorded for this order.');

        doc.moveDown();
      } else {
        items.forEach((item, index) => {
          drawProductRow(doc, item, index);
        });
      }

      // Totals and payment.
      drawFinancialSummary(
        doc,
        financial
      );

      drawPaymentSection(
        doc,
        payment
      );

      drawThankYou(doc);

      // Add page numbers after all content has been created.
      addPageNumbers(doc);

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  generateReceiptPdf,
  money,
  formatDate
};