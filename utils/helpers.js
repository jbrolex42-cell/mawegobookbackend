function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function generateOrderNumber() {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `MB-${datePart}-${rand}`;
}

function generatePoNumber() {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(Math.random() * 900) + 100;
  return `PO-${datePart}-${rand}`;
}

function formatKes(amount) {
  return `KES ${Number(amount).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset, skip: offset };
}

function serialize(doc) {
  if (!doc) return null;
  const o = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  o.id = String(o._id || o.id);
  delete o._id;
  delete o.__v;
  if (o.category_id && typeof o.category_id === 'object' && o.category_id._id) {
    o.category_name = o.category_id.name;
    o.category_slug = o.category_id.slug;
    o.category_id = String(o.category_id._id);
  } else if (o.category_id) {
    o.category_id = String(o.category_id);
  }
  if (o.user_id) o.user_id = String(o.user_id);
  if (o.supplier_id && typeof o.supplier_id === 'object') {
    o.supplier_name = o.supplier_id.name;
    o.supplier_id = String(o.supplier_id._id || o.supplier_id);
  } else if (o.supplier_id) {
    o.supplier_id = String(o.supplier_id);
  }
  if (o.product_id) o.product_id = String(o.product_id);
  if (Array.isArray(o.items)) {
    o.items = o.items.map((i) => {
      const item = { ...i };
      if (item.product_id) item.product_id = String(item.product_id);
      return item;
    });
  }
  if (o.created_at && o.created_at.toISOString) {
    o.created_at = o.created_at.toISOString().replace('T', ' ').slice(0, 19);
  }
  if (o.updated_at && o.updated_at.toISOString) {
    o.updated_at = o.updated_at.toISOString().replace('T', ' ').slice(0, 19);
  }
  return o;
}

const POINTS_PER_KES = 1 / 50; 
const KES_PER_POINT = 0.5;
const MIN_REDEEM_POINTS = 100;

function isSaleActive(product) {
  if (!product) return false;
  const pct = Number(product.discount_percent) || 0;
  const fixed = product.discount_price_kes;
  if (pct <= 0 && (fixed == null || fixed === '')) return false;
  if (product.sale_ends_at) {
    const end = new Date(product.sale_ends_at);
    if (!isNaN(end.getTime()) && end < new Date()) return false;
  }
  return true;
}

function effectivePrice(product) {
  const base = Number(product.price_kes) || 0;
  if (!isSaleActive(product)) return base;
  if (product.discount_price_kes != null && product.discount_price_kes !== '' && Number(product.discount_price_kes) >= 0) {
    return Math.min(base, Number(product.discount_price_kes));
  }
  const pct = Number(product.discount_percent) || 0;
  if (pct > 0) return Math.round(base * (1 - Math.min(pct, 100) / 100));
  return base;
}

function pointsEarnedFromKes(amount) {
  return Math.floor(Math.max(0, Number(amount) || 0) * POINTS_PER_KES);
}

function pointsToKes(points) {
  return Math.floor(Number(points) || 0) * KES_PER_POINT;
}

function kesToPointsCost(kes) {
  return Math.ceil((Number(kes) || 0) / KES_PER_POINT);
}

function enrichProductPricing(o, product) {
  const src = product || o;
  const base = Number(src.price_kes) || 0;
  const sale = isSaleActive(src);
  const finalPrice = effectivePrice(src);
  o.price_kes = base;
  o.sale_active = sale;
  o.final_price_kes = finalPrice;
  o.discount_percent = sale ? (Number(src.discount_percent) || (base > 0 ? Math.round((1 - finalPrice / base) * 100) : 0)) : 0;
  o.discount_price_kes = src.discount_price_kes != null ? Number(src.discount_price_kes) : null;
  o.sale_label = sale ? (src.sale_label || (o.discount_percent ? `${o.discount_percent}% OFF` : 'SALE')) : null;
  o.sale_ends_at = src.sale_ends_at || null;
  return o;
}

function serializeMany(docs) {
  return (docs || []).map(serialize);
}

module.exports = {
  slugify,
  generateOrderNumber,
  generatePoNumber,
  formatKes,
  parsePagination,
  serialize,
  serializeMany,
  effectivePrice,
  isSaleActive,
  pointsEarnedFromKes,
  pointsToKes,
  kesToPointsCost,
  enrichProductPricing,
  POINTS_PER_KES,
  KES_PER_POINT,
  MIN_REDEEM_POINTS
};