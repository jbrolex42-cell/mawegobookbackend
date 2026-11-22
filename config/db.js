/**
 * Mawego Bookshop — JSON file database (no native modules)
 */
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'mawego.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const defaultData = () => ({
  users: [],
  categories: [],
  products: [],
  stock_ledger: [],
  suppliers: [],
  purchase_orders: [],
  purchase_order_items: [],
  orders: [],
  order_items: [],
  payment_logs: [],
  delivery_zones: [],
  settings: [],
  expenses: [],
  activity_log: [],
  _meta: { nextId: {} }
});

function load() {
  if (!fs.existsSync(dbPath)) {
    const data = defaultData();
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
    return data;
  }
  try {
    const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    // Ensure new tables exist on upgrade
    const defaults = defaultData();
    for (const key of Object.keys(defaults)) {
      if (data[key] === undefined) data[key] = defaults[key];
    }
    if (!data._meta) data._meta = { nextId: {} };
    return data;
  } catch {
    const data = defaultData();
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
    return data;
  }
}

let store = load();

function save() {
  fs.writeFileSync(dbPath, JSON.stringify(store, null, 2));
}

function nextId(table) {
  if (!store._meta) store._meta = { nextId: {} };
  if (!store._meta.nextId) store._meta.nextId = {};
  if (!store._meta.nextId[table]) {
    const rows = store[table] || [];
    store._meta.nextId[table] = rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
  }
  return store._meta.nextId[table]++;
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const db = {
  all(table, filterFn) {
    const rows = store[table] || [];
    return filterFn ? rows.filter(filterFn) : [...rows];
  },
  get(table, filterFn) {
    return (store[table] || []).find(filterFn) || null;
  },
  insert(table, row) {
    if (!store[table]) store[table] = [];
    const id = row.id != null ? row.id : nextId(table);
    const record = { ...row, id };
    store[table].push(record);
    save();
    return { lastInsertRowid: id, changes: 1 };
  },
  update(table, id, patch) {
    const rows = store[table] || [];
    const idx = rows.findIndex((r) => String(r.id) === String(id));
    if (idx === -1) return { changes: 0 };
    rows[idx] = { ...rows[idx], ...patch };
    save();
    return { changes: 1 };
  },
  remove(table, filterFn) {
    const before = (store[table] || []).length;
    store[table] = (store[table] || []).filter((r) => !filterFn(r));
    save();
    return { changes: before - store[table].length };
  },
  setTable(table, rows) {
    store[table] = rows;
    save();
  },
  raw() {
    return store;
  },
  reload() {
    store = load();
  },
  logActivity(userId, action, entityType, entityId, details) {
    this.insert('activity_log', {
      user_id: userId || null,
      action,
      entity_type: entityType || null,
      entity_id: entityId || null,
      details: details || null,
      created_at: now()
    });
  },
  save,
  now,
  nextId,
  path: dbPath
};

module.exports = db;
