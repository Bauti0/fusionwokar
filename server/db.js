import { createClient } from "@libsql/client";

// ============================================================
// FUSIÓN WOK — Base de datos Turso (libSQL en la nube)
// Tablas: orders, admin_tokens, events, products, categories,
// coupons
//
// Se conecta a Turso con TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
// (.env). La DB es remota y persistente; no hay archivo local.
//
// @libsql/client es ASÍNCRONO. Para minimizar el diff con el viejo
// node:sqlite (síncrono), `db` expone la misma superficie que antes:
//   db.prepare(sql).get(...)  → Promise<fila | undefined>
//   db.prepare(sql).all(...)  → Promise<fila[]>
//   db.prepare(sql).run(...)  → Promise<{ lastInsertRowid, changes }>
//   db.exec(sql)              → Promise<void> (soporta multi-statement)
// Es decir: mismos nombres y mismos shapes de retorno, pero todo
// con await. Los call sites tienen que ser async y usar await.
// ============================================================

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_DATABASE_URL) {
  throw new Error(
    "Falta TURSO_DATABASE_URL en .env. La DB de Fusión Wok corre en Turso; " +
      "no hay fallback local. Creá la base en https://turso.tech y completá las credenciales."
  );
}

const client = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

// Facade sobre @libsql/client que imita la API de node:sqlite.
function prepare(sql) {
  return {
    all: (...args) =>
      client.execute({ sql, args, rowMode: "object" }).then((res) => res.rows),
    get: (...args) =>
      client.execute({ sql, args, rowMode: "object" }).then((res) => res.rows[0]),
    run: (...args) =>
      client.execute({ sql, args }).then((res) => ({
        lastInsertRowid:
          res.lastInsertRowid == null ? 0 : Number(res.lastInsertRowid),
        changes: res.rowsAffected,
      })),
  };
}

// Convierte las filas de un ResultSet (arrays) en objetos. client.batch() no
// acepta rowMode, así que el mapeo se hace acá.
function rowsToObjects(rs) {
  const named = [];
  for (const row of rs.rows) {
    const obj = {};
    for (let i = 0; i < rs.columns.length; i++) obj[rs.columns[i]] = row[i];
    named.push(obj);
  }
  return named;
}

export const db = {
  prepare,
  exec: (sql) => client.executeMultiple(sql),
  // Batch atómico de varias sentencias en UN solo round-trip (importante con
  // Turso/HTTP). Devuelve un array con { lastInsertRowid, rowsAffected, rows }
  // y las filas ya convertidas a objetos.
  batch: (stmts, mode) =>
    client.batch(stmts, mode).then((results) =>
      results.map((rs) => ({
        lastInsertRowid: rs.lastInsertRowid,
        rowsAffected: rs.rowsAffected,
        rows: rowsToObjects(rs),
      }))
    ),
};

export function now() {
  return new Date().toISOString();
}

await db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE NOT NULL,
    branch TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_tokens (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cash_registers_branch ON cash_registers(branch);

  CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);
  CREATE INDEX IF NOT EXISTS idx_orders_branch ON orders(branch);
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(customer_phone);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
  CREATE INDEX IF NOT EXISTS idx_products_branch ON products(branch);
  CREATE INDEX IF NOT EXISTS idx_products_category ON products(branch, category_id);
  CREATE INDEX IF NOT EXISTS idx_categories_branch ON categories(branch);
`);

// Migraciones: agrega columnas nuevas a tablas ya existentes (SQLite no
// soporta ALTER ... ADD COLUMN IF NOT EXISTS).
async function ensureColumn(table, column, ddl) {
  const cols = await db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

await ensureColumn("orders", "scheduled_for", "scheduled_for TEXT NOT NULL DEFAULT ''");
await ensureColumn("orders", "coupon_code", "coupon_code TEXT NOT NULL DEFAULT ''");
await ensureColumn("orders", "discount", "discount INTEGER NOT NULL DEFAULT 0");
await ensureColumn("products", "image", "image TEXT NOT NULL DEFAULT ''");
// "web" = pedido online normal. "whatsapp"/"counter" = cargado a mano
// por el admin (pedido que llegó por WhatsApp o cliente de mostrador).
await ensureColumn("orders", "source", "source TEXT NOT NULL DEFAULT 'web'");
// Costo de envío calculado y cuadras (Tandil). La columna se llama
// "shipping_km" por legado pero guarda el número de cuadras.
await ensureColumn("orders", "shipping", "shipping INTEGER NOT NULL DEFAULT 0");
await ensureColumn("orders", "shipping_km", "shipping_km INTEGER NOT NULL DEFAULT 0");

// Convierte una fila de products en el objeto de producto del menú
export function toProduct(row) {
  if (!row) return null;
  return {
    id: row.product_id,
    name: row.name,
    price: row.price,
    description: row.description || "",
    image: row.image || "",
    extras: JSON.parse(row.extras_json || "[]"),
    available: row.available === 1,
  };
}

// Sembra la tabla products a partir de los menús estáticos si está vacía.
// A partir de ese momento la BD es la fuente de verdad del menú.
export async function seedProducts(menus) {
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM products").get()).n;
  if (count > 0) return;
  const insert = db.prepare(`
    INSERT INTO products
      (branch, category_id, category_name, group_name, product_id, name,
       price, description, image, extras_json, available, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let order = 0;
  const timestamp = now();
  for (const [branchId, menu] of Object.entries(menus)) {
    for (const cat of menu.categories) {
      for (const group of cat.groups) {
        for (const product of group.products) {
          await insert.run(
            branchId,
            cat.id,
            String(cat.name || cat.id),
            group.name || "",
            product.id,
            product.name,
            product.price,
            product.description || "",
            product.image || "",
            JSON.stringify(product.extras || []),
            product.available === false ? 0 : 1,
            order++,
            timestamp,
            timestamp
          );
        }
      }
    }
  }
}

// Siembra las categorías (orden de menú) si la tabla está vacía.
export async function seedCategories(menus) {
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM categories").get()).n;
  if (count > 0) return;
  const insert = db.prepare(`
    INSERT INTO categories (branch, category_id, name, sort_order)
    VALUES (?, ?, ?, ?)
  `);
  for (const [branchId, menu] of Object.entries(menus)) {
    let order = 0;
    for (const cat of menu.categories) {
      await insert.run(branchId, cat.id, String(cat.name || cat.id), order++);
    }
  }
}

// Convierte una fila de categories en objeto de categoría
export function toCategory(row) {
  return {
    id: row.id,
    branch: row.branch,
    categoryId: row.category_id,
    name: row.name,
    sortOrder: row.sort_order,
  };
}

// Convierte una fila de la BD en el objeto público del pedido
export function toPublicOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderNumber: row.order_number,
    branch: row.branch,
    customer: { name: row.customer_name, phone: row.customer_phone },
    address: row.address,
    orderMode: row.order_mode,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    status: row.status,
    items: JSON.parse(row.items),
    total: row.total,
    discount: row.discount || 0,
    couponCode: row.coupon_code || "",
    shippingCost: row.shipping || 0,
    shippingBlocks: row.shipping_km || 0,
    scheduledFor: row.scheduled_for || "",
    notes: row.notes,
    source: row.source || "web",
    mpPaymentId: row.mp_payment_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Proyección SIN datos personales para endpoints públicos
// (tracking y polling). No expone nombre, teléfono, dirección ni notas.
export function toPublicOrderPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderNumber: row.order_number,
    branch: row.branch,
    orderMode: row.order_mode,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    status: row.status,
    items: JSON.parse(row.items),
    total: row.total,
    discount: row.discount || 0,
    couponCode: row.coupon_code || "",
    shippingCost: row.shipping || 0,
    shippingBlocks: row.shipping_km || 0,
    scheduledFor: row.scheduled_for || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Genera el próximo número de pedido (FW-00001, FW-00002…)
export async function nextOrderNumber() {
  const row = await db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM orders").get();
  return `FW-${String(row.n).padStart(5, "0")}`;
}