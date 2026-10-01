import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { listCustomers } from "../server/admin-queries.js";

// ============================================================
// admin-queries.js — listCustomers con aislamiento por sucursal
// (T10 del plan de roles).
//
// Regla del dueño que fija (decisión 9): el gasto total y el
// historial del cliente se calculan SOLO con los pedidos de la
// sucursal del admin. Un mismo teléfono con pedidos en ambas
// sucursales NO puede arrastrar los de la otra.
// ============================================================

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
      total INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

let seq = 0;

async function addOrder(db, o = {}) {
  seq += 1;
  const ts = o.created_at || "2026-01-15T12:00:00.000Z";
  await db
    .prepare(
      `INSERT INTO orders
        (order_number, branch, customer_name, customer_phone, address, total, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `FW-${String(seq).padStart(5, "0")}`,
      o.branch || "tandil",
      o.name || "Juana",
      o.phone || "2262480511",
      o.address || "",
      o.total ?? 10000,
      ts,
      ts
    );
}

describe("listCustomers", () => {
  it("un teléfono con pedidos en ambas sucursales: el branch_admin ve SU historial", async () => {
    const db = await makeDb();
    await addOrder(db, { branch: "tandil", total: 8000, created_at: "2026-01-10T12:00:00.000Z" });
    await addOrder(db, { branch: "tandil", total: 4000, created_at: "2026-01-12T12:00:00.000Z" });
    // Más nuevo y más caro, pero de la otra sucursal
    await addOrder(db, { branch: "necochea", total: 50000, created_at: "2026-01-20T12:00:00.000Z" });

    const cs = await listCustomers(db, { scope: "tandil" });
    assert.equal(cs.length, 1, "un solo cliente (mismo teléfono, solo SU sucursal)");
    const c = cs[0];
    assert.equal(c.ordersCount, 2);
    assert.equal(c.totalSpent, 12000, "no puede arrastrar los 50000 de necochea");
    assert.equal(c.lastOrderAt, "2026-01-12T12:00:00.000Z", "su último pedido es el de SU sucursal");
    assert.equal(c.branch, "tandil");
  });

  it("superadmin (scope null) ve el consolidado de ambas", async () => {
    const db = await makeDb();
    await addOrder(db, { branch: "tandil", total: 8000, created_at: "2026-01-10T12:00:00.000Z" });
    await addOrder(db, { branch: "tandil", total: 4000, created_at: "2026-01-12T12:00:00.000Z" });
    await addOrder(db, { branch: "necochea", total: 50000, created_at: "2026-01-20T12:00:00.000Z" });

    const cs = await listCustomers(db, { scope: null });
    assert.equal(cs.length, 1);
    assert.equal(cs[0].ordersCount, 3);
    assert.equal(cs[0].totalSpent, 62000);
    assert.equal(cs[0].lastOrderAt, "2026-01-20T12:00:00.000Z");
  });

  it("búsqueda combinada con scope: encuentra solo clientes de SU sucursal", async () => {
    const db = await makeDb();
    await addOrder(db, { branch: "necochea", name: "María Pérez", phone: "2494611402", total: 3000 });
    await addOrder(db, { branch: "tandil", name: "María López", phone: "2262111222", total: 6000 });
    await addOrder(db, { branch: "tandil", name: "Pedro", phone: "2262333444", total: 9000 });

    const cs = await listCustomers(db, { scope: "tandil", search: "María" });
    assert.equal(cs.length, 1, "la María de necochea no puede aparecer");
    assert.equal(cs[0].name, "María López");

    // Sin search: los dos clientes de tandil
    const todos = await listCustomers(db, { scope: "tandil" });
    assert.equal(todos.length, 2);
  });

  it("superadmin conserva su filtro branch del panel", async () => {
    const db = await makeDb();
    await addOrder(db, { branch: "tandil", name: "Juana", phone: "2262480511", total: 8000 });
    await addOrder(db, { branch: "necochea", name: "María", phone: "2494611402", total: 3000 });

    const cs = await listCustomers(db, { scope: null, branch: "necochea" });
    assert.equal(cs.length, 1);
    assert.equal(cs[0].name, "María");
  });
});
