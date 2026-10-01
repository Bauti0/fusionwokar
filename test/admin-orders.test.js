import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { listOrders, getOrderScoped, effectiveBranch } from "../server/admin-queries.js";

// ============================================================
// admin-queries.js — pedidos del panel con aislamiento por
// sucursal (T7 del plan de roles).
//
// `scope` es el convenio de toda la Etapa B:
//   - null        → superadmin: ve todo (comportamiento actual)
//   - "necochea" / "tandil" → branch_admin: SOLO su sucursal,
//     venga lo que venga en ?branch= del query (se ignora).
//
// Contra un SQLite real en memoria (file::memory:), igual que
// admin-users.test.js: COUNT/LIMIT/OFFSET y el WHERE con scope
// dependen del motor.
// ============================================================

// DDL espejo de server/db.js (solo las columnas que estas queries
// tocan; el SELECT * devuelve lo que haya en la tabla).
async function makeDb() {
  const client = createClient({ url: "file::memory:" });
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
      coupon_code TEXT NOT NULL DEFAULT '',
      refunded_amount INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

let seq = 0;

// Inserta un pedido con defaults razonables; lo que importa del
// aislamiento son branch/estado/pago/búsqueda, no el resto.
async function addOrder(db, o = {}) {
  seq += 1;
  const ts = o.created_at || `2026-01-${String(10 + seq).padStart(2, "0")}T12:00:00.000Z`;
  const r = await db
    .prepare(
      `INSERT INTO orders
        (order_number, branch, customer_name, customer_phone, payment_method, payment_status, status, total, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `FW-${String(seq).padStart(5, "0")}`,
      o.branch || "tandil",
      o.customer_name || "Cliente",
      o.customer_phone || "2262480511",
      o.payment_method || "mercadopago",
      o.payment_status || "approved",
      o.status || "completed",
      o.total ?? 10000,
      ts,
      ts
    );
  return Number(r.lastInsertRowid);
}

describe("listOrders — aislamiento por scope", () => {
  it("scope tandil no devuelve NI cuenta los pedidos de necochea", async () => {
    const db = await makeDb();
    await addOrder(db, { branch: "tandil" });
    await addOrder(db, { branch: "tandil" });
    await addOrder(db, { branch: "tandil" });
    await addOrder(db, { branch: "necochea" });
    await addOrder(db, { branch: "necochea" });

    const r = await listOrders(db, { scope: "tandil", page: 1, limit: 50 });
    assert.equal(r.total, 3, "el total cuenta solo los de su sucursal");
    assert.equal(r.rows.length, 3);
    assert.ok(r.rows.every((o) => o.branch === "tandil"), "ningún pedido de necochea puede colarse");
    assert.equal(r.hasMore, false);
  });

  it("el ?branch= del query se IGNORA para branch_admin (scope manda)", async () => {
    const db = await makeDb();
    await addOrder(db, { branch: "tandil" });
    await addOrder(db, { branch: "necochea" });

    // El branch_admin de tandil pide filtrar necochea: no le case.
    const r = await listOrders(db, { scope: "tandil", branch: "necochea", page: 1, limit: 50 });
    assert.equal(r.total, 1);
    assert.ok(r.rows.every((o) => o.branch === "tandil"));
  });

  it("scope null (superadmin) ve todo, y su filtro ?branch= sigue andando", async () => {
    const db = await makeDb();
    await addOrder(db, { branch: "tandil" });
    await addOrder(db, { branch: "necochea" });
    await addOrder(db, { branch: "necochea" });

    let r = await listOrders(db, { scope: null, page: 1, limit: 50 });
    assert.equal(r.total, 3, "superadmin sin filtro: ve ambas sucursales");
    assert.equal(new Set(r.rows.map((o) => o.branch)).size, 2);

    // Filtro de sucursal del panel del dueño: se mantiene intacto.
    r = await listOrders(db, { scope: null, branch: "necochea", page: 1, limit: 50 });
    assert.equal(r.total, 2);
    assert.ok(r.rows.every((o) => o.branch === "necochea"));
  });

  it("scope + paginación: total, hasMore y página correctos", async () => {
    const db = await makeDb();
    for (let i = 0; i < 5; i++) await addOrder(db, { branch: "tandil" });
    await addOrder(db, { branch: "necochea" });

    let r = await listOrders(db, { scope: "tandil", page: 2, limit: 2 });
    assert.equal(r.total, 5, "el total es de su sucursal aunque la página corte");
    assert.equal(r.rows.length, 2);
    assert.equal(r.page, 2);
    assert.equal(r.limit, 2);
    assert.equal(r.hasMore, true, "2*2 + 2 < 5");

    r = await listOrders(db, { scope: "tandil", page: 3, limit: 2 });
    assert.equal(r.hasMore, false, "última página: 2*2 + 1 = 5");
  });

  it("scope combinado con status y payment", async () => {
    const db = await makeDb();
    await addOrder(db, { branch: "tandil", status: "completed" });
    await addOrder(db, { branch: "tandil", status: "cancelled" });
    await addOrder(db, { branch: "necochea", status: "completed" });

    let r = await listOrders(db, { scope: "tandil", status: "completed", page: 1, limit: 50 });
    assert.equal(r.total, 1, "solo SU completed, no el de necochea");

    await addOrder(db, { branch: "tandil", payment_method: "efectivo", payment_status: "pending" });
    await addOrder(db, { branch: "tandil", payment_method: "mercadopago" });
    r = await listOrders(db, { scope: "tandil", payment: "approved", page: 1, limit: 50 });
    assert.equal(r.total, 3, "efectivo pending + 2 MP approved de tandil");
    assert.ok(r.rows.every((o) => o.payment_status === "approved"));
  });

  it("por defecto oculta los MP pendientes; includePending=1 los muestra (con scope)", async () => {
    const db = await makeDb();
    await addOrder(db, { branch: "tandil", payment_status: "pending" });
    await addOrder(db, { branch: "necochea", payment_status: "pending" });
    await addOrder(db, { branch: "tandil" });

    let r = await listOrders(db, { scope: "tandil", page: 1, limit: 50 });
    assert.equal(r.total, 1, "el MP pending de tandil queda oculto por defecto");

    r = await listOrders(db, { scope: "tandil", includePending: "1", page: 1, limit: 50 });
    assert.equal(r.total, 2, "includePending lo muestra…");
    assert.ok(r.rows.every((o) => o.branch === "tandil"), "…pero solo el SUYO, el de necochea jamás");
  });

  it("búsqueda por nombre/número/teléfono combinada con scope", async () => {
    const db = await makeDb();
    await addOrder(db, { branch: "tandil", customer_name: "María" });
    await addOrder(db, { branch: "necochea", customer_name: "María" });
    await addOrder(db, { branch: "tandil", customer_name: "Pedro" });

    let r = await listOrders(db, { scope: "tandil", search: "María", page: 1, limit: 50 });
    assert.equal(r.total, 1, "la María de necochea no aparece para el admin de tandil");

    r = await listOrders(db, { scope: null, search: "María", page: 1, limit: 50 });
    assert.equal(r.total, 2, "superadmin encuentra ambas");
  });

  it("ordena por created_at DESC", async () => {
    const db = await makeDb();
    const viejo = await addOrder(db, { branch: "tandil", created_at: "2026-01-01T12:00:00.000Z" });
    const nuevo = await addOrder(db, { branch: "tandil", created_at: "2026-02-01T12:00:00.000Z" });

    const r = await listOrders(db, { scope: "tandil", page: 1, limit: 50 });
    assert.deepEqual(r.rows.map((o) => o.id), [nuevo, viejo]);
  });
});

describe("getOrderScoped — pedidos por id", () => {
  it("ajeno → null; propio → la fila; superadmin (null) → siempre", async () => {
    const db = await makeDb();
    const deTandil = await addOrder(db, { branch: "tandil" });
    const deNecochea = await addOrder(db, { branch: "necochea" });

    assert.equal((await getOrderScoped(db, deTandil, "tandil")).id, deTandil);
    assert.equal(await getOrderScoped(db, deNecochea, "tandil"), null, "404: no confirmar existencia de la otra sucursal");
    assert.equal((await getOrderScoped(db, deNecochea, null)).id, deNecochea, "superadmin ve ambos");
    assert.equal(await getOrderScoped(db, 99999, "tandil"), null);
  });
});

describe("effectiveBranch — sucursal efectiva de la operación", () => {
  it("branch_admin: SIEMPRE su sucursal, ignora lo que pida el cliente", async () => {
    const admin = { role: "branch_admin", branch: "tandil" };
    assert.deepEqual(effectiveBranch(admin, "necochea"), { branch: "tandil" }, "no se puede pedir la otra");
    assert.deepEqual(effectiveBranch(admin, undefined), { branch: "tandil" });
    assert.deepEqual(effectiveBranch(admin, "inventada"), { branch: "tandil" });
  });

  it("superadmin: acepta branch válida y rechaza inválida o ausente", async () => {
    const admin = { role: "superadmin", branch: "" };
    assert.deepEqual(effectiveBranch(admin, "necochea"), { branch: "necochea" });
    assert.deepEqual(effectiveBranch(admin, "tandil"), { branch: "tandil" });
    assert.ok(effectiveBranch(admin, "bahia").error, "sucursal inexistente");
    assert.ok(effectiveBranch(admin, "").error, "sin sucursal");
    assert.ok(effectiveBranch(admin, undefined).error, "sin sucursal");
  });
});
