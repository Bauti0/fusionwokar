// playwright-global-setup.js
// Configuración global para tests Playwright con base temporal
// Usa el server de producción (puerto 3001) que sirve tanto API como frontend desde dist/

import { resolve } from "path";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);

let testDbPath = null;
let testDbClient = null;
let testDb = null;
let serverProcess = null;

const TEST_API_PORT = 3001;
const TEST_API_URL = `http://localhost:${3001}`;
const TEST_BASE_URL = `http://localhost:${3001}`; // Usar el mismo server para API y frontend

// Variables de entorno para los tests - DEBEN ir ANTES de importar módulos del server
process.env.TEST_BASE_URL = `http://localhost:3001`;
process.env.TEST_API_URL = `http://localhost:3001`;
process.env.PORT = "3001";
process.env.TURSO_DATABASE_URL = `file:${tmpdir()}/fusion-wok-test-placeholder.db`;
process.env.TURSO_AUTH_TOKEN = "";
process.env.NODE_ENV = "test";
process.env.DEMO_MODE = "true";
process.env.ADMIN_USER = "superadmin";
process.env.ADMIN_PASSWORD = "test123";
process.env.MP_WEBHOOK_SECRET = "test-secret";
process.env.MP_ACCESS_TOKEN = "";
process.env.PUBLIC_BASE_URL = `http://localhost:3001`;
process.env.CRON_SECRET = "test-cron-secret";
process.env.PORT = "3001";
process.env.TEST_RELAX_CSP = "1"; // CSP relajada solo en tests (NODE_ENV=test)

// Crear archivo placeholder ANTES de importar server/db.js
const placeholderPath = resolve(tmpdir(), "fusion-wok-test-placeholder.db");
if (!existsSync(placeholderPath)) {
  writeFileSync(placeholderPath, "");
}

// Los imports de módulos del server deben ser dinámicos para que se ejecuten DESPUÉS de setear las env vars
let createClient;
let createDb;
let migrateCashRegisters;
let seedProducts;
let seedCategories;
let seedBranchHours;
let MENUS;
let hashPassword;

async function loadServerModules() {
  const libsql = await import("@libsql/client");
  createClient = libsql.createClient;

  const sqlite = await import("./server/sqlite.js");
  createDb = sqlite.createDb;

  const migrationsCash = await import("./server/migrations-cash.js");
  migrateCashRegisters = migrationsCash.migrateCashRegisters;

  const db = await import("./server/db.js");
  seedProducts = db.seedProducts;
  seedCategories = db.seedCategories;
  seedBranchHours = db.seedBranchHours;

  const menus = await import("./src/data/menus.js");
  MENUS = menus.MENUS;

  const auth = await import("./server/auth.js");
  hashPassword = auth.hashPassword;
}

async function createTestDatabase() {
  // Crear archivo temporal único
  const randomSuffix = Math.random().toString(36).substring(7);
  testDbPath = resolve(tmpdir(), `fusion-wok-test-${randomSuffix}.db`);

  // Usar libSQL con archivo local
  testDbClient = createClient({ url: `file:${testDbPath}` });
  testDb = createDb(testDbClient);

  // Ejecutar esquema completo (copia de server/db.js líneas 44-274 + migraciones)
  await testDb.exec(`
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

  // Migraciones de columnas
  async function ensureColumn(table, column, ddl) {
    const cols = await testDb.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      await testDb.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
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
  await ensureColumn("coupons", "branch", "branch TEXT NOT NULL DEFAULT ''");
  await ensureColumn("admin_tokens", "admin_user_id", "admin_user_id INTEGER");
  await ensureColumn("admin_tokens", "role", "role TEXT NOT NULL DEFAULT 'superadmin'");
  await ensureColumn("admin_tokens", "branch", "branch TEXT NOT NULL DEFAULT ''");
  await ensureColumn("events", "visitor_id", "visitor_id TEXT");

  await testDb.exec("CREATE INDEX IF NOT EXISTS idx_events_visitor ON events(visitor_id)");

  // Migraciones de caja
  await migrateCashRegisters(testDb, () => new Date().toISOString());

  // Columnas de branch_hours
  async function ensureBranchHoursColumns() {
    const cols = await testDb.prepare(`PRAGMA table_info(branch_hours)`).all();
    if (!cols.some((c) => c.name === "created_at")) {
      await testDb.exec(`ALTER TABLE branch_hours ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`);
    }
    if (!cols.some((c) => c.name === "updated_at")) {
      await testDb.exec(`ALTER TABLE branch_hours ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
    }
    if (!cols.some((c) => c.name === "updated_by")) {
      await testDb.exec(`ALTER TABLE branch_hours ADD COLUMN updated_by TEXT NOT NULL DEFAULT 'unknown'`);
    }
  }
  await ensureBranchHoursColumns();

  // Índice único parcial de idempotencia
  try {
    await testDb.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_client_request
      ON orders(client_request_id) WHERE client_request_id IS NOT NULL;
    `);
  } catch (err) {
    console.warn("⚠️  No se pudo crear uq_orders_client_request:", err.message);
  }
}

async function seedTestData() {
  const now = () => new Date().toISOString();
  const timestamp = now();

  // Crear usuarios de prueba
  const superadminHash = hashPassword("test123");
  const necocheaHash = hashPassword("test123");
  const tandilHash = hashPassword("test123");

  await testDb.prepare(`
    INSERT INTO admin_users (username, password_hash, role, branch, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("superadmin", superadminHash, "superadmin", "", 1, timestamp, timestamp);

  await testDb.prepare(`
    INSERT INTO admin_users (username, password_hash, role, branch, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("necochea", necocheaHash, "branch_admin", "necochea", 1, timestamp, timestamp);

  await testDb.prepare(`
    INSERT INTO admin_users (username, password_hash, role, branch, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("tandil", tandilHash, "branch_admin", "tandil", 1, timestamp, timestamp);

  // Sembrar productos y categorías
  await seedProducts(MENUS);
  await seedCategories(MENUS);

  // Sembrar horarios
  await seedBranchHours();

  console.log("✅ Datos de prueba sembrados");
}

async function startServer() {
  // Configurar variables de entorno para el server
  process.env.PORT = String(TEST_API_PORT);
  process.env.TURSO_DATABASE_URL = `file:${testDbPath}`;
  process.env.TURSO_AUTH_TOKEN = "";
  process.env.NODE_ENV = "test";
  process.env.DEMO_MODE = "true";
  process.env.ADMIN_USER = "superadmin";
  process.env.ADMIN_PASSWORD = "test123";
  process.env.MP_WEBHOOK_SECRET = "test-secret";
  process.env.MP_ACCESS_TOKEN = "";
  process.env.PUBLIC_BASE_URL = TEST_BASE_URL;
  process.env.CRON_SECRET = "test-cron-secret";

  // Importar y ejecutar el server (dinámico para que use las env vars correctas)
  await import("./server/index.js");
  // El server se auto-ejecuta al importarse
  // Esperar a que esté listo
  await new Promise(resolve => setTimeout(resolve, 3000));
  console.log(`✅ Server iniciado en ${TEST_API_URL} (API + Frontend)`);
}

async function cleanup() {
  console.log("🧹 Limpiando recursos de test...");

  if (serverProcess) {
    serverProcess.kill();
  }

  if (testDbClient) {
    try {
      await testDbClient.close();
    } catch (e) {
      console.warn("Error cerrando DB:", e.message);
    }
  }

  // Esperar un poco para que se liberen los archivos
  await new Promise(resolve => setTimeout(resolve, 500));

  if (testDbPath && existsSync(testDbPath)) {
    try {
      unlinkSync(testDbPath);
    } catch (e) {
      console.warn("Error borrando BD temporal:", e.message);
    }
  }

  // Limpiar placeholder
  if (existsSync(placeholderPath)) {
    try {
      unlinkSync(placeholderPath);
    } catch (e) {
      console.warn("Error borrando placeholder:", e.message);
    }
  }

  console.log("✅ Limpieza completada");
}

async function globalSetup() {
  console.log("🚀 Iniciando setup global para Playwright...");
  console.log(`📍 API + Frontend: ${TEST_API_URL}`);

  try {
    await loadServerModules();
    await createTestDatabase();
    await seedTestData();
    await startServer();

    // Verificar que todo funciona - usar globalThis.fetch (Node 18+)
    const apiHealth = await globalThis.fetch(`${TEST_API_URL}/api/health`).catch(() => null);
    const clientHealth = await globalThis.fetch(`${TEST_BASE_URL}`).catch(() => null);
    const adminLoginHealth = await globalThis.fetch(`${TEST_BASE_URL}/admin/login`).catch(() => null);

    if (!apiHealth || !clientHealth || !adminLoginHealth) {
      throw new Error("Health checks fallaron");
    }

    console.log("✅ Setup global completado exitosamente");
  } catch (error) {
    console.error("❌ Error en setup global:", error);
    await cleanup();
    throw error;
  }
}

async function globalTeardown() {
  await cleanup();
}

export default globalSetup;
export { globalTeardown };