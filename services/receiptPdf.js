
const PDFDocument = require("pdfkit");

function money(value) {
  return `KES ${Number(value || 0).toLocaleString("en-KE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function generateReceiptPdf(order) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: 45,
        bufferPages: true
      });

      const chunks = [];

      doc.on("data", chunk => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const items = order.items || order.order_items || [];

      const createdAt =
        order.created_at ||
        order.createdAt ||
        Date.now();

      const receiptNumber =
        order.receipt_number ||
        `MB-${new Date(createdAt).getFullYear()}-${String(order._id)
          .slice(-8).toUpperCase()}`;

      const orderNumber =
        order.order_number || String(order._id);

      const customerEmail =
        order.customer_email || order.email || "N/A";

      const discount =
        order.discount_total_kes ??
        order.discount_kes ??
        0;

      doc.font("Helvetica-Bold")
        .fontSize(22)
        .fillColor("#08734e")
        .text("MAWEGO BOOKSHOP", { align: "center" });

      doc.font("Helvetica")
        .fontSize(10)
        .fillColor("#555")
        .text("Books, Stationery & Learning Materials", {
          align: "center"
        });

      doc.moveDown();

      doc.font("Helvetica-Bold")
        .fontSize(18)
        .fillColor("#111")
        .text("SALES RECEIPT", { align: "center" });

      doc.moveDown();

      doc.font("Helvetica")
        .fontSize(10)
        .fillColor("#222");

      doc.text(`Receipt Number: ${receiptNumber}`);
      doc.text(`Order Number: ${orderNumber}`);
      doc.text(`Date: ${new Date(createdAt).toLocaleString("en-KE")}`);

      doc.moveDown();

      doc.font("Helvetica-Bold").text("CUSTOMER DETAILS");

      doc.font("Helvetica")
        .text(`Customer: ${order.customer_name || "Customer"}`)
        .text(`Email: ${customerEmail}`)
        .text(`Phone: ${order.customer_phone || "N/A"}`);

      doc.moveDown();

      doc.font("Helvetica-Bold")
        .fontSize(11)
        .fillColor("#08734e")
        .text("PURCHASE DETAILS");

      doc.moveDown(0.5);

      const columns = {
        product: 45,
        quantity: 310,
        price: 365,
        total: 465
      };

      function drawTableHeader() {
        const y = doc.y;

        doc.font("Helvetica-Bold")
          .fontSize(9)
          .fillColor("#222");

        doc.text("Product", columns.product, y, { width: 250 });
        doc.text("Qty", columns.quantity, y, { width: 45 });
        doc.text("Price", columns.price, y, { width: 90 });
        doc.text("Total", columns.total, y, {
          width: 90,
          align: "right"
        });

        doc.moveTo(45, y + 17)
          .lineTo(550, y + 17)
          .strokeColor("#cccccc")
          .stroke();

        doc.y = y + 24;
      }

      drawTableHeader();

      items.forEach(item => {
        const name = String(
          item.product_name || item.name || "Product"
        );

        const quantity = Number(item.quantity || 1);

        const price = Number(
          item.unit_price_kes ??
          item.price_kes ??
          item.price ??
          0
        );

        const lineTotal = Number(
          item.line_total_kes ?? quantity * price
        );

        const productHeight = doc.heightOfString(name, {
          width: 250,
          font: "Helvetica",
          fontSize: 9
        });

        if (doc.y + Math.max(productHeight, 18) > 720) {
          doc.addPage();
          drawTableHeader();
        }

        const y = doc.y;

        doc.font("Helvetica")
          .fontSize(9)
          .fillColor("#222");

        doc.text(name, columns.product, y, { width: 250 });
        doc.text(String(quantity), columns.quantity, y, { width: 45 });
        doc.text(money(price), columns.price, y, { width: 90 });
        doc.text(money(lineTotal), columns.total, y, {
          width: 90,
          align: "right"
        });

        doc.y = y + Math.max(productHeight, 18) + 7;
      });

      doc.moveDown();

      const subtotal = Number(order.subtotal_kes || 0);
      const delivery = Number(order.delivery_fee_kes || 0);
      const total = Number(order.total_kes || 0);

      doc.font("Helvetica")
        .fontSize(10)
        .fillColor("#222");

      doc.text(`Subtotal: ${money(subtotal)}`, {
        align: "right"
      });

      doc.text(`Discount: ${money(discount)}`, {
        align: "right"
      });

      doc.text(`Delivery: ${money(delivery)}`, {
        align: "right"
      });

      doc.moveDown(0.5);

      doc.font("Helvetica-Bold")
        .fontSize(15)
        .fillColor("#08734e")
        .text(`TOTAL: ${money(total)}`, {
          align: "right"
        });

      doc.moveDown();

      doc.font("Helvetica")
        .fontSize(10)
        .fillColor("#222");

      doc.text(`Payment Method: ${order.payment_method || "N/A"}`);
      doc.text(`Payment Status: ${order.payment_status || "Pending"}`);

      const mpesaReference =
        order.mpesa_receipt ||
        order.mpesa_receipt_number;

      if (mpesaReference) {
        doc.text(`M-Pesa Reference: ${mpesaReference}`);
      }

      doc.moveDown(2);

      doc.font("Helvetica-Bold")
        .fontSize(12)
        .fillColor("#08734e")
        .text("Thank you for shopping with us!", {
          align: "center"
        });

      doc.font("Helvetica")
        .fontSize(9)
        .fillColor("#555")
        .text("Mawego Bookshop | Kenya | Prices in KES", {
          align: "center"
        });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { generateReceiptPdf };