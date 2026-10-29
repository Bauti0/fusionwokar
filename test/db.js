// test/db.js — Helper compartido de tests con base temporal y migraciones REALES
//
// Cada test usa createTestDb() que:
// 1. Crea un SQLite en memoria (file::memory:) vía @libsql/client
// 2. Corre TODAS las migraciones de server/db.js (CREATE TABLE, ALTER, seeds, índices)
// 3. Devuelve { db, close } donde db tiene la misma API que server/sqlite.js
// 4. close() cierra la conexión nativa para evitar ACCESS_VIOLATION al salir
//
// NUNCA usa TURSO_DATABASE_URL ni TURSO_AUTH_TOKEN del entorno.
// Si el entorno apunta a un host remoto o NODE_ENV=production, LANZA.

import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";

const clients = new Set();

export function assertSafeTestEnv() {
  const url = process.env.TURSO_DATABASE_URL || "";
  const isProduction = process.env.NODE_ENV === "production" || process.env.DEMO_MODE === "false";

  if (isProduction) {
    throw new Error("Tests prohibidos en NODE_ENV=production o DEMO_MODE=false");
  }

  if (url && !/^file:/i.test(url)) {
    throw new Error(
      `TURSO_DATABASE_URL apunta a host remoto (${url}). ` +
      "Los tests solo corren contra SQLite en memoria. " +
      "Quita TURSO_DATABASE_URL o usa file::memory:."
    );
  }
}

export async function createTestDb() {
  assertSafeTestEnv();

  const client = createClient({ url: "file::memory:" });
  clients.add(client);

  const db = createDb(client);

  // Ejecutar el esquema COMPLETO de server/db.js (líneas 44-274)
  // Esto incluye CREATE TABLE, ALTER, seeds, índices, migraciones de cash, branch_hours, etc.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      branch TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_email TEXT NOT NULL DEFAULT '',
      customer_first_name TEXT NOT NULL DEFAULT '',
      customer_last_name TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      order_mode TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending_payment',
      items TEXT NOT NULL,
      total INTEGER NOT NULL,
      discount INTEGER NOT NULL DEFAULT 0,
      coupon_code TEXT NOT NULL DEFAULT '',
      scheduled_for TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      mp_payment_id TEXT,
      mp_preference_id TEXT,
      mp_order_id TEXT,
      refunded_amount INTEGER NOT NULL DEFAULT 0,
      refunds_json TEXT NOT NULL DEFAULT '[]',
      coupon_released_at TEXT,
      client_request_id TEXT,
      client_request_fingerprint TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_tokens (
      token TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'branch_admin',
      branch TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_users_branch ON admin_users(branch);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL,
      category_id TEXT NOT NULL,
      category_name TEXT NOT NULL DEFAULT '',
      group_name TEXT NOT NULL DEFAULT '',
      product_id TEXT NOT NULL,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '',
      extras_json TEXT NOT NULL DEFAULT '[]',
      available INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(branch, product_id)
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL,
      category_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(branch, category_id)
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL DEFAULT 'percent',
      value INTEGER NOT NULL,
      min_total INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      max_uses INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cash_registers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL,
      opening_amount INTEGER NOT NULL DEFAULT 0,
      opened_at TEXT NOT NULL,
      closing_counted INTEGER,
      closed_at TEXT,
      expected_amount INTEGER,
      difference INTEGER,
      notes TEXT NOT NULL DEFAULT '',
      corrected_at TEXT,
      deleted_at TEXT,
      deleted_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cash_registers_branch ON cash_registers(branch);

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL,
      cash_register_id INTEGER,
      amount INTEGER NOT NULL,
      concept TEXT NOT NULL,
      category TEXT,
      payment_method TEXT NOT NULL DEFAULT 'cash',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_by TEXT,
      deleted_at TEXT,
      deleted_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_branch ON expenses(branch);
    CREATE INDEX IF NOT EXISTS idx_expenses_cash_register ON expenses(cash_register_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_deleted ON expenses(deleted_at);

    CREATE TABLE IF NOT EXISTS cash_register_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cash_register_id INTEGER NOT NULL,
      admin_user_id INTEGER,
      admin_username TEXT NOT NULL,
      admin_role TEXT NOT NULL,
      admin_branch TEXT NOT NULL DEFAULT '',
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cash_corr_register ON cash_register_corrections(cash_register_id);

    CREATE TABLE IF NOT EXISTS product_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mime TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      admin_user_id INTEGER,
      admin_username TEXT NOT NULL,
      admin_role TEXT NOT NULL,
      admin_branch TEXT NOT NULL DEFAULT '',
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      old_total INTEGER NOT NULL,
      new_total INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_order_audit_order ON order_audit_log(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_audit_created ON order_audit_log(created_at);

    CREATE TABLE IF NOT EXISTS branch_settings (
      branch TEXT PRIMARY KEY,
      paused_until INTEGER,
      paused_indefinitely INTEGER NOT NULL DEFAULT 0,
      pause_message TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);
    CREATE INDEX IF NOT EXISTS idx_orders_branch ON orders(branch);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(customer_phone);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
    CREATE INDEX IF NOT EXISTS idx_products_branch ON products(branch);
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(branch, category_id);
    CREATE INDEX IF NOT EXISTS idx_categories_branch ON categories(branch);

    CREATE TABLE IF NOT EXISTS branch_hours (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      slot INTEGER NOT NULL,
      open_time TEXT NOT NULL,
      close_time TEXT NOT NULL,
      closed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT 'unknown',
      UNIQUE(branch, day_of_week, slot)
    );
  `);

  // Migraciones de columnas (espejo de server/db.js líneas 278-414)
  async function ensureColumn(table, column, ddl) {
    const cols = await db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }

  await ensureColumn("orders", "scheduled_for", "scheduled_for TEXT NOT NULL DEFAULT ''");
  await ensureColumn("orders", "coupon_code", "coupon_code TEXT NOT NULL DEFAULT ''");
  await ensureColumn("orders", "discount", "discount INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("orders", "customer_email", "customer_email TEXT NOT NULL DEFAULT ''");
  await ensureColumn("orders", "customer_first_name", "customer_first_name TEXT NOT NULL DEFAULT ''");
  await ensureColumn("orders", "customer_last_name", "customer_last_name TEXT NOT NULL DEFAULT ''");
  await ensureColumn("products", "image", "image TEXT NOT NULL DEFAULT ''");
  await ensureColumn("orders", "source", "source TEXT NOT NULL DEFAULT 'web'");
  await ensureColumn("orders", "shipping", "shipping INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("orders", "shipping_km", "shipping_km INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("orders", "shipping_pending", "shipping_pending INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("orders", "mp_order_id", "mp_order_id TEXT");
  await ensureColumn("orders", "coupon_released_at", "coupon_released_at TEXT");
  await ensureColumn("orders", "refunded_amount", "refunded_amount INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("orders", "refunds_json", "refunds_json TEXT NOT NULL DEFAULT '[]'");
  await ensureColumn("orders", "client_request_id", "client_request_id TEXT");
  await ensureColumn("orders", "client_request_fingerprint", "client_request_fingerprint TEXT");

  // seen_at con backfill ÚNICO (líneas 322-333)
  {
    const cols = await db.prepare(`PRAGMA table_info(orders)`).all();
    if (!cols.some((c) => c.name === "seen_at")) {
      await db.batch([
        { sql: "ALTER TABLE orders ADD COLUMN seen_at TEXT", args: [] },
        { sql: `UPDATE orders SET seen_at = created_at WHERE seen_at IS NULL AND status != 'pending_payment'`, args: [] },
      ], "write");
    }
  }

  // Índice único parcial de idempotencia (líneas 334-352)
  try {
    await db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_client_request
      ON orders(client_request_id) WHERE client_request_id IS NOT NULL;
    `);
  } catch (err) {
    console.warn("⚠️  No se pudo crear uq_orders_client_request:", err.message);
  }

  await ensureColumn("coupons", "branch", "branch TEXT NOT NULL DEFAULT ''");
  await ensureColumn("admin_tokens", "admin_user_id", "admin_user_id INTEGER");
  await ensureColumn("admin_tokens", "role", "role TEXT NOT NULL DEFAULT 'superadmin'");
  await ensureColumn("admin_tokens", "branch", "branch TEXT NOT NULL DEFAULT ''");
  await ensureColumn("events", "visitor_id", "visitor_id TEXT");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_events_visitor ON events(visitor_id)");

  // Migraciones de caja (server/migrations-cash.js)
  const { migrateCashRegisters } = await import("../server/migrations-cash.js");
  await migrateCashRegisters(db, () => new Date().toISOString());

  // Columnas de branch_hours (líneas 401-414)
  async function ensureBranchHoursColumns() {
    const cols = await db.prepare(`PRAGMA table_info(branch_hours)`).all();
    if (!cols.some((c) => c.name === "created_at")) {
      await db.exec(`ALTER TABLE branch_hours ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`);
    }
    if (!cols.some((c) => c.name === "updated_at")) {
      await db.exec(`ALTER TABLE branch_hours ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
    }
    if (!cols.some((c) => c.name === "updated_by")) {
      await db.exec(`ALTER TABLE branch_hours ADD COLUMN updated_by TEXT NOT NULL DEFAULT 'unknown'`);
    }
  }
  await ensureBranchHoursColumns();

  return {
    db,
    close: () => {
      clients.delete(client);
      return client.close();
    },
  };
}

export async function closeAllTestClients() {
  for (const c of clients) {
    try { await c.close(); } catch {}
  }
  clients.clear();
}