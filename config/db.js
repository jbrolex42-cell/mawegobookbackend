
'use strict';

/**
 * Mawego Bookshop
 * JSON File Database Engine
 *
 * Lightweight persistent storage without native modules
 * or external database dependencies.
 */

const fs = require('fs');
const path = require('path');

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'mawego.json');
const TEMP_PATH = `${DB_PATH}.tmp`;

const TABLES = [
  'users',
  'categories',
  'products',
  'stock_ledger',
  'suppliers',
  'purchase_orders',
  'purchase_order_items',
  'orders',
  'order_items',
  'payment_logs',
  'delivery_zones',
  'settings',
  'expenses',
  'activity_log'
];

const DEFAULT_META = {
  nextId: {},
  version: 1,
  created_at: null,
  updated_at: null
};

// --------------------------------------------------
// INITIALIZATION
// --------------------------------------------------

function ensureDirectory() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function defaultData() {
  const data = {};

  for (const table of TABLES) {
    data[table] = [];
  }

  data._meta = {
    ...DEFAULT_META,
    nextId: {},
    created_at: now(),
    updated_at: now()
  };

  return data;
}

// --------------------------------------------------
// UTILITIES
// --------------------------------------------------

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function clone(value) {
  if (value === undefined || value === null) {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
}

function assertTable(table) {
  if (typeof table !== 'string' || !table.trim()) {
    throw new TypeError('A valid table name is required.');
  }

  if (table.startsWith('_')) {
    throw new Error('System tables cannot be accessed directly.');
  }

  return table;
}

function assertRows(table) {
  assertTable(table);

  if (!Array.isArray(store[table])) {
    store[table] = [];
  }

  return store[table];
}

// --------------------------------------------------
// DATABASE NORMALIZATION
// --------------------------------------------------

function normalizeData(data) {
  const defaults = defaultData();

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return defaults;
  }

  for (const table of TABLES) {
    if (!Array.isArray(data[table])) {
      data[table] = [];
    }
  }

  if (
    !data._meta ||
    typeof data._meta !== 'object' ||
    Array.isArray(data._meta)
  ) {
    data._meta = {};
  }

  data._meta = {
    ...DEFAULT_META,
    ...data._meta,
    nextId: {
      ...(data._meta.nextId || {})
    },
    version: 1
  };

  if (!data._meta.created_at) {
    data._meta.created_at = now();
  }

  data._meta.updated_at = now();

  return data;
}

// --------------------------------------------------
// FILE OPERATIONS
// --------------------------------------------------

function load() {
  ensureDirectory();

  if (!fs.existsSync(DB_PATH)) {
    const initialData = defaultData();

    writeFile(initialData);

    return initialData;
  }

  try {
    const contents = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(contents);

    return normalizeData(parsed);
  } catch (error) {
    // Do not overwrite a potentially recoverable database.
    // Invalid JSON should be investigated or restored manually.
    throw new Error(
      `Unable to load database at ${DB_PATH}: ${error.message}`
    );
  }
}

function writeFile(data) {
  ensureDirectory();

  const serialized = JSON.stringify(data, null, 2);

  try {
    fs.writeFileSync(TEMP_PATH, serialized, {
      encoding: 'utf8',
      mode: 0o600
    });

    // Rename replaces the previous file atomically on
    // supported local filesystems.
    fs.renameSync(TEMP_PATH, DB_PATH);
  } catch (error) {
    try {
      if (fs.existsSync(TEMP_PATH)) {
        fs.unlinkSync(TEMP_PATH);
      }
    } catch {
      // Preserve the original write error.
    }

    throw new Error(`Database save failed: ${error.message}`);
  }
}

// --------------------------------------------------
// DATABASE STATE
// --------------------------------------------------

let store = load();

function save() {
  store._meta.updated_at = now();
  writeFile(store);
}

// --------------------------------------------------
// ID GENERATION
// --------------------------------------------------

function nextId(table) {
  assertTable(table);

  const rows = assertRows(table);

  if (!store._meta.nextId) {
    store._meta.nextId = {};
  }

  const highestId = rows.reduce((highest, row) => {
    const id = Number(row.id);

    return Number.isSafeInteger(id) && id > highest
      ? id
      : highest;
  }, 0);

  const storedNext = Number(store._meta.nextId[table]) || 1;

  const id = Math.max(highestId + 1, storedNext);

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Unable to generate an ID for ${table}.`);
  }

  store._meta.nextId[table] = id + 1;

  return id;
}

// --------------------------------------------------
// QUERY OPERATIONS
// --------------------------------------------------

function all(table, filterFn) {
  const rows = assertRows(table);

  if (filterFn !== undefined && typeof filterFn !== 'function') {
    throw new TypeError('Filter must be a function.');
  }

  const result = filterFn
    ? rows.filter(filterFn)
    : rows;

  return clone(result);
}

function get(table, filterFn) {
  const rows = assertRows(table);

  if (typeof filterFn !== 'function') {
    throw new TypeError('A filter function is required.');
  }

  const result = rows.find(filterFn);

  return result ? clone(result) : null;
}

// --------------------------------------------------
// INSERT OPERATIONS
// --------------------------------------------------

function insert(table, row) {
  const rows = assertRows(table);

  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('A valid record object is required.');
  }

  const record = clone(row);

  const id = record.id != null
    ? record.id
    : nextId(table);

  if (
    rows.some(existing => String(existing.id) === String(id))
  ) {
    throw new Error(`Duplicate ID "${id}" in table "${table}".`);
  }

  if (record.id == null) {
    record.id = id;
  }

  rows.push(record);

  try {
    save();
  } catch (error) {
    rows.pop();
    throw error;
  }

  return {
    lastInsertRowid: id,
    changes: 1
  };
}

// --------------------------------------------------
// UPDATE OPERATIONS
// --------------------------------------------------

function update(table, id, patch) {
  const rows = assertRows(table);

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('A valid update object is required.');
  }

  const index = rows.findIndex(
    row => String(row.id) === String(id)
  );

  if (index === -1) {
    return { changes: 0 };
  }

  const previous = rows[index];

  const updates = clone(patch);

  // Record identity must remain unchanged.
  delete updates.id;

  rows[index] = {
    ...previous,
    ...updates,
    id: previous.id
  };

  try {
    save();
  } catch (error) {
    rows[index] = previous;
    throw error;
  }

  return { changes: 1 };
}

// --------------------------------------------------
// DELETE OPERATIONS
// --------------------------------------------------

function remove(table, filterFn) {
  const rows = assertRows(table);

  if (typeof filterFn !== 'function') {
    throw new TypeError('A filter function is required.');
  }

  const original = [...rows];

  const remaining = rows.filter(row => !filterFn(row));
  const changes = rows.length - remaining.length;

  if (changes === 0) {
    return { changes: 0 };
  }

  store[table] = remaining;

  try {
    save();
  } catch (error) {
    store[table] = original;
    throw error;
  }

  return { changes };
}

// --------------------------------------------------
// TABLE OPERATIONS
// --------------------------------------------------

function setTable(table, rows) {
  assertTable(table);

  if (!Array.isArray(rows)) {
    throw new TypeError('Table data must be an array.');
  }

  const previous = store[table];

  store[table] = clone(rows);

  try {
    save();
  } catch (error) {
    store[table] = previous;
    throw error;
  }

  return {
    changes: rows.length
  };
}

// --------------------------------------------------
// ACTIVITY LOGGING
// --------------------------------------------------

function logActivity(
  userId,
  action,
  entityType,
  entityId,
  details
) {
  if (!action || typeof action !== 'string') {
    throw new TypeError('Activity action is required.');
  }

  return insert('activity_log', {
    user_id: userId || null,
    action,
    entity_type: entityType || null,
    entity_id: entityId || null,
    details: details || null,
    created_at: now()
  });
}

// --------------------------------------------------
// DATABASE MANAGEMENT
// --------------------------------------------------

function reload() {
  store = load();

  return true;
}

function raw() {
  // Read-only copy: callers cannot mutate the internal store.
  return clone(store);
}

function stats() {
  const result = {};

  for (const table of TABLES) {
    result[table] = store[table].length;
  }

  return {
    tables: result,
    total_records: Object.values(result).reduce(
      (sum, count) => sum + count,
      0
    ),
    database_version: store._meta.version,
    created_at: store._meta.created_at,
    updated_at: store._meta.updated_at,
    database_path: DB_PATH
  };
}

// --------------------------------------------------
// PUBLIC DATABASE API
// --------------------------------------------------

const db = {
  all,
  get,
  insert,
  update,
  remove,
  setTable,

  raw,
  reload,
  save,
  now,
  nextId,

  logActivity,
  stats,

  path: DB_PATH
};

module.exports = db;