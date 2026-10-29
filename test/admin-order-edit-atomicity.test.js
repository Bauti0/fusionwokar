import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";

// ============================================================
// Atomicidad de la escritura de edición de pedidos (PATCH admin).
//
// Regresión que cubre: el endpoint hacía db.exec("BEGIN") … db.exec("COMMIT")
// y en el catch db.exec("ROLLBACK"). Cada exec corre sobre executeMultiple(),
// que abre una conexión lógica NUEVA por llamada (y la libera haciendo
// rollback), así que el BEGIN moría al terminar su llamada: el UPDATE de
// orders corría en autocommit, el COMMIT/POST fallaban y el ROLLBACK del
// catch tiraba "cannot rollback - no transaction is active" TAPANDO el error
// original. Resultado en producción: 500 con los datos ya aplicados.
//
// Ahora la escritura es UN solo db.batch(stmts, "write") (applyOrderEdit),
// que envuelve las sentencias en una transacción y las revierte todas si una
// falla — el mismo mecanismo que usa el resto del repo. Acá se prueba esa
// invariante con la MISMA abstracción que usa producción (createDb).
//
// Lo que NO se puede reproducir fielmente acá es la falla original de
// Turso (BEGIN que no sobrevive entre llamadas): eso exigiría un servidor
// libsql real (red + dependencia nueva) y, además, ya no habría BEGIN. Por
// eso el segundo bloque valida el guard sobre la fuente del endpoint.
// ============================================================

// shipping.js captura sus constantes AL IMPORTAR (igual que en
// admin-order-edit.test.js): las env vars van antes del import dinámico.
process.env.ORS_API_KEY = "";
process.env.SHIPPING_FLAT_BLOCKS = "20";
process.env.SHIPPING_BASE_COST = "4000";
process.env.SHIPPING_PER_BLOCK = "100";

const { applyOrderEdit, computeOrderEdits } = await import("../server/order-edit.js");

const clients = [];
after(() => {
  for (const c of clients) c.close();
});

async function makeDb() {
  const client = createClient({ url: "file::memory:" });
  clients.push(client);
  const db = createDb(client);
  await db.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      branch TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      order_mode TEXT NOT NULL DEFAULT 'pickup',
      payment_method TEXT NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending_payment',
      items TEXT NOT NULL DEFAULT '[]',
      total INTEGER NOT NULL DEFAULT 0,
      discount INTEGER NOT NULL DEFAULT 0,
      coupon_code TEXT NOT NULL DEFAULT '',
      shipping INTEGER NOT NULL DEFAULT 0,
      shipping_km INTEGER NOT NULL DEFAULT 0,
      shipping_pending INTEGER NOT NULL DEFAULT 0,
      mp_order_id TEXT,
      mp_payment_id TEXT,
      refunded_amount INTEGER NOT NULL DEFAULT 0,
      refunds_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE order_audit_log (
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
  `);
  return db;
}

// Pedido Tandil en delivery con envío $4.780: el mismo caso del bug en
// producción (total $23.680, se pasó a pickup y quedó en $18.900).
async function seedPedido(db) {
  const r = await db
    .prepare(
      `INSERT INTO orders
        (order_number, branch, customer_name, customer_phone, order_mode, payment_method, payment_status, status, total, shipping, shipping_km, shipping_pending, address, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "FW-00025",
      "tandil",
      "Cliente",
      "2262480511",
      "delivery",
      "efectivo",
      "approved",
      "received",
      23680,
      4780,
      20,
      0,
      "Cuba 1117",
      "2026-10-07T02:00:00.000Z",
      "2026-10-07T02:00:00.000Z"
    );
  return Number(r.lastInsertRowid);
}

const superadmin = { role: "superadmin", branch: "", userId: 1, username: "superadmin" };
const iso = () => new Date().toISOString();

async function estadoPedido(db, id) {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
}

async function cantAuditoria(db, id) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM order_audit_log WHERE order_id = ?").get(id);
  return Number(row.n);
}

describe("applyOrderEdit — escritura atómica (UPDATE + auditoría)", () => {
  it("camino feliz: el batch aplica el UPDATE de orders y las 3 filas de auditoría", async () => {
    const db = await makeDb();
    const id = await seedPedido(db);
    const row = await estadoPedido(db, id);

    const result = await computeOrderEdits(row, { orderMode: "pickup" }, superadmin, iso);
    assert.equal(result.error, undefined, "el cálculo no debe fallar");
    await applyOrderEdit(db, result);

    const upd = await estadoPedido(db, id);
    assert.equal(upd.order_mode, "pickup");
    assert.equal(upd.shipping, 0);
    assert.equal(upd.total, 18900);
    assert.equal(await cantAuditoria(db, id), 3);
  });

  it("si un INSERT de auditoría falla, el UPDATE de orders NO queda aplicado", async () => {
    const db = await makeDb();
    const id = await seedPedido(db);
    const row = await estadoPedido(db, id);

    const result = await computeOrderEdits(row, { orderMode: "pickup" }, superadmin, iso);
    assert.equal(result.error, undefined);

    // Rompemos una fila de auditoría: la base la rechaza (NOT NULL en
    // admin_username), igual que rechazaría cualquier constraint real. Es
    // la misma señal que un fallo a mitad del batch en Turso.
    result.auditEntries[0].admin_username = null;
    await assert.rejects(() => applyOrderEdit(db, result));

    // El pedido tiene que quedar EXACTAMENTE como estaba: si el UPDATE se
    // aplicara igual (autocommit, como pasaba con BEGIN suelto), este test
    // falla.
    const upd = await estadoPedido(db, id);
    assert.equal(upd.order_mode, "delivery");
    assert.equal(upd.address, "Cuba 1117");
    assert.equal(upd.shipping, 4780);
    assert.equal(upd.total, 23680);
    assert.equal(upd.updated_at, "2026-10-07T02:00:00.000Z");
    assert.equal(await cantAuditoria(db, id), 0);
  });

  it("no deja transacciones abiertas: después de un fallo se puede escribir de nuevo", async () => {
    const db = await makeDb();
    const id = await seedPedido(db);
    const row = await estadoPedido(db, id);
    const result = await computeOrderEdits(row, { orderMode: "pickup" }, superadmin, iso);
    result.auditEntries[0].admin_username = null;
    await assert.rejects(() => applyOrderEdit(db, result));

    // Si el batch dejara el BEGIN sin cerrar, esta escritura se colgaría o
    // fallaría con "cannot start a transaction within a transaction".
    const ok = await db
      .prepare("INSERT INTO order_audit_log (order_id, admin_username, admin_role, field, old_total, new_total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, "superadmin", "superadmin", "orderMode", 1, 1, iso());
    assert.equal(ok.changes, 1);
  });
});

describe("PATCH /api/admin/orders/:id — guard contra BEGIN/COMMIT sueltos", () => {
  it("el handler escribe con applyOrderEdit y no usa db.exec(\"BEGIN\") ni COMMIT/ROLLBACK", async () => {
    const src = await readFile(new URL("../server/index.js", import.meta.url), "utf8");

    // La regresión exacta: transacción armada a mano sobre executeMultiple.
    assert.doesNotMatch(src, /exec\(\s*["'`]BEGIN/i, "volvió db.exec(\"BEGIN\") contra Turso");
    assert.doesNotMatch(src, /exec\(\s*["'`](COMMIT|ROLLBACK)/i, "volvieron COMMIT/ROLLBACK sueltos");

    // El escritor del endpoint es el batch atómico.
    assert.match(src, /applyOrderEdit\(db, result\)/);

    // Y el escritor usa batch en modo write (misma abstracción que producción).
    const orderEditSrc = await readFile(new URL("../server/order-edit.js", import.meta.url), "utf8");
    assert.match(orderEditSrc, /db\.batch\(stmts, "write"\)/);
  });

  it("el catch responde 500 genérico sin filtrar detalles internos", async () => {
    const src = await readFile(new URL("../server/index.js", import.meta.url), "utf8");
    const inicio = src.indexOf('app.patch("/api/admin/orders/:id"');
    const fin = src.indexOf("// ---------- auditoría de pedido", inicio);
    const handler = src.slice(inicio, fin);
    assert.ok(fin > inicio, "no se encontró el bloque completo del handler");
    // Loguea el error original (err.message) y devuelve un mensaje genérico.
    assert.match(handler, /console\.error\("PATCH \/api\/admin\/orders\/:id:", err\.message\)/);
    assert.match(handler, /res\.status\(500\)\.json\(\{ error: "Error interno" \}\)/);
    assert.doesNotMatch(handler, /res\.status\(500\)\.json\(\{ error: err/);
  });
});
