import { createClient } from "@libsql/client";
import { createDb } from "./sqlite.js";
import { parseRefunds, refundableAmount } from "./refunds.js";

// ============================================================
// FUSIÓN WOK — Base de datos Turso (libSQL en la nube)
// Tablas: orders, admin_tokens, admin_users, events, products,
// categories, coupons, cash_registers, product_images
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

// La facade vive en sqlite.js para que los tests puedan usar la misma capa
// SQL contra un SQLite en memoria sin importar este módulo (que dispara las
// migraciones contra la base real al cargarse).
export const db = createDb(client);

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
    customer_email TEXT NOT NULL DEFAULT '',
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_tokens (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

  -- Cuentas de admin por sucursal. El superadmin (el dueño) NO vive
  -- acá: sigue siendo el ADMIN_USER/ADMIN_PASSWORD del .env, para no
  -- romper su login ni exigir ningún paso manual de migración.
  -- COLLATE NOCASE en username: "Tandil1" y "tandil1" son la misma
  -- cuenta, no puede haber duplicados que se diferencien por mayúsculas.
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cash_registers_branch ON cash_registers(branch);

  CREATE TABLE IF NOT EXISTS product_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL,
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
await ensureColumn("orders", "customer_email", "customer_email TEXT NOT NULL DEFAULT ''");
await ensureColumn("products", "image", "image TEXT NOT NULL DEFAULT ''");
// "web" = pedido online normal. "whatsapp"/"counter" = cargado a mano
// por el admin (pedido que llegó por WhatsApp o cliente de mostrador).
await ensureColumn("orders", "source", "source TEXT NOT NULL DEFAULT 'web'");
// Costo de envío calculado y cuadras (Tandil). La columna se llama
// "shipping_km" por legado pero guarda el número de cuadras.
await ensureColumn("orders", "shipping", "shipping INTEGER NOT NULL DEFAULT 0");
await ensureColumn("orders", "shipping_km", "shipping_km INTEGER NOT NULL DEFAULT 0");
// Envío "pendiente": el cálculo automático falló y el pedido se aceptó igual
// (efectivo/transferencia). El costo se confirma por WhatsApp antes de salir.
await ensureColumn("orders", "shipping_pending", "shipping_pending INTEGER NOT NULL DEFAULT 0");
// Mercado Pago: id de la order (Orders API). mp_preference_id queda como
// histórico de los pedidos creados con la integración anterior.
await ensureColumn("orders", "mp_order_id", "mp_order_id TEXT");
// Cupón que tenía este pedido: NULL = todavía lo está sosteniendo (reservado y
// pendiente, o ya pagado y por eso consumido de verdad). Al liberar pasa a
// now(), y el contador used_count baja SOLO en esa transición — es lo que hace
// que liberar sea idempotente por pedido. Ver server/coupons.js.
await ensureColumn("orders", "coupon_released_at", "coupon_released_at TEXT");

// Dinero devuelto por Mercado Pago (suma) y detalle de cada devolución.
await ensureColumn("orders", "refunded_amount", "refunded_amount INTEGER NOT NULL DEFAULT 0");
await ensureColumn("orders", "refunds_json", "refunds_json TEXT NOT NULL DEFAULT '[]'");

// Cupones por sucursal (T14): '' = global (vale en ambas), 'necochea'/
// 'tandil' = local. Los cupones existentes quedan globales sin tocar
// filas; la unicidad del código sigue siendo GLOBAL (opción 2 del dueño:
// no se recrea la tabla).
await ensureColumn("coupons", "branch", "branch TEXT NOT NULL DEFAULT ''");

// Roles del panel: los tokens de sesión guardan quién los emitió.
//   admin_user_id NULL → el superadmin del .env: los tokens vivos de
//   antes de este cambio siguen válidos y resuelven como superadmin
//   sin ningún paso manual.
//   role/branch duplican los de admin_users para tenerlos a mano en
//   cada request (requireAdmin), pero la fuente de verdad de la
//   identidad es admin_users: si la cuenta se desactiva, la sesión
//   corta aunque el token siga en la tabla.
await ensureColumn("admin_tokens", "admin_user_id", "admin_user_id INTEGER");
await ensureColumn("admin_tokens", "role", "role TEXT NOT NULL DEFAULT 'superadmin'");
await ensureColumn("admin_tokens", "branch", "branch TEXT NOT NULL DEFAULT ''");

// Visitante anónimo por evento (para contar personas, no vistas netas).
// El índice se crea DESPUÉS de agregar la columna (sino falla en DBs viejas).
await ensureColumn("events", "visitor_id", "visitor_id TEXT");
await db.exec("CREATE INDEX IF NOT EXISTS idx_events_visitor ON events(visitor_id)");

// Migración de apertura de caja: una apertura concurrente vieja podía dejar
// DOS cajas abiertas para la misma sucursal (SELECT + INSERT separados). Se
// cierran todas menos la más reciente de cada sucursal y recién después se
// crea un índice único parcial: a futuro la BD impide el duplicado aunque el
// código vuelva a intentarlo.
const dupOpenCash = await db
  .prepare(
    `SELECT c.id FROM cash_registers c
     WHERE c.closed_at IS NULL
       AND c.id <> (SELECT c2.id FROM cash_registers c2
                    WHERE c2.branch = c.branch AND c2.closed_at IS NULL
                    ORDER BY c2.opened_at DESC, c2.id DESC LIMIT 1)`
  )
  .all();
for (const d of dupOpenCash) {
  await db
    .prepare(
      "UPDATE cash_registers SET closed_at = ?, notes = notes || ' [cierre por duplicado]', updated_at = ? WHERE id = ?"
    )
    .run(now(), now(), d.id);
}
try {
  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_registers_open_branch
    ON cash_registers(branch) WHERE closed_at IS NULL;
  `);
} catch (err) {
  // Si algún estado raro impide el índice, la apertura sigue protegida por el
  // INSERT condicional del endpoint; solo se pierde la garantía de respaldo.
  console.error("No se pudo crear uq_cash_registers_open_branch:", err.message);
}

// Migración de datos: los extras de woks (salsas, palitos chinos, galletas)
// se agrupan por categoría (subgroup) en el modal de personalización, con
// subtítulos "SALSAS ADICIONALES" / "PALITOS DESCARTABLES" / "GALLETAS".
// Idempotente: solo reescribe productos que aún no tienen "subgroup".
function modernizeExtras(extras) {
  return extras.map((e) => {
    if (typeof e.id === "string" && e.id.startsWith("salsa-")) {
      return { ...e, subgroup: "salsas", subgroupLabel: "SALSAS ADICIONALES" };
    }
    if (e.id === "palitos-chinos") {
      return { ...e, subgroup: "palitos", subgroupLabel: "PALITOS DESCARTABLES" };
    }
    if (typeof e.id === "string" && e.id.startsWith("galleta-fortuna-")) {
      return {
        ...e,
        group: e.group || "galleta",
        subgroup: "galleta",
        subgroupLabel: e.id.endsWith("-1") ? "GALLETAS" : e.subgroupLabel || "",
      };
    }
    return e;
  });
}

const wokExtraRows = await db.prepare("SELECT id, extras_json FROM products").all();
for (const row of wokExtraRows) {
  let extras;
  try {
    extras = JSON.parse(row.extras_json || "[]");
  } catch {
    continue;
  }
  const hasWokSignature =
    extras.some((e) => typeof e.id === "string" && e.id.startsWith("salsa-")) &&
    extras.some((e) => e.id === "palitos-chinos") &&
    extras.some((e) => typeof e.id === "string" && e.id.startsWith("galleta-fortuna-"));
  if (!hasWokSignature) continue;
  if (extras.some((e) => e.subgroup)) continue; // ya migrado
  const next = modernizeExtras(extras);
  await db.prepare("UPDATE products SET extras_json = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(next),
    now(),
    row.id
  );
};

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
  const refundedAmount = row.refunded_amount || 0;
  return {
    id: row.id,
    orderNumber: row.order_number,
    branch: row.branch,
    // El email se expone SOLO acá (panel admin). toPublicOrderPublic, que
    // alimenta los endpoints públicos de tracking, no lo incluye.
    customer: {
      name: row.customer_name,
      phone: row.customer_phone,
      email: row.customer_email || "",
    },
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
    shipping: {
      cost: row.shipping || 0,
      blocks: row.shipping_km || 0,
      pending: !!row.shipping_pending,
    },
    scheduledFor: row.scheduled_for || "",
    notes: row.notes,
    source: row.source || "web",
    mpOrderId: row.mp_order_id || "",
    mpPaymentId: row.mp_payment_id,
    refundedAmount,
    refundableAmount: refundableAmount(row),
    refunds: parseRefunds(row.refunds_json),
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
    // Ítems SIN la nota libre del cliente: como este endpoint es público y los
    // id/número de pedido son correlativos, las notas no deben exponerse a
    // terceros que conozcan el número de un pedido ajeno.
    items: (JSON.parse(row.items) || []).map(({ notes, ...item }) => item),
    total: row.total,
    discount: row.discount || 0,
    shippingCost: row.shipping || 0,
    shippingBlocks: row.shipping_km || 0,
    shipping: {
      cost: row.shipping || 0,
      blocks: row.shipping_km || 0,
      pending: !!row.shipping_pending,
    },
    scheduledFor: row.scheduled_for || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Formatea el número de pedido a partir del id real que asigna la DB
// (id AUTOINCREMENT → único por construcción, sin carrera de MAX+1).
export function formatOrderNumber(id) {
  return `FW-${String(id).padStart(5, "0")}`;
}

// Guarda una imagen de producto como BLOB en la base (Turso es persistente,
// a diferencia del filesystem efímero de Render free). Devuelve { id, updatedAt }
// para armar la URL /api/images/products/<id>?v=<ts>.
export async function saveProductImage({ mime, data }) {
  const ts = now();
  const res = await db
    .prepare("INSERT INTO product_images (mime, data, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(mime, data, ts, ts);
  return { id: Number(res.lastInsertRowid), updatedAt: ts };
}

export async function getProductImage(id) {
  return db.prepare("SELECT id, mime, data, updated_at FROM product_images WHERE id = ?").get(id);
}

// Borra una imagen de producto (usado al reemplazar la foto o borrar el
// producto: evita acumular BLOBs huérfanos que consumen el plan free).
export async function deleteProductImage(id) {
  await db.prepare("DELETE FROM product_images WHERE id = ?").run(id);
}