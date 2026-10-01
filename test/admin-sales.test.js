import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { getSalesReport } from "../server/admin-queries.js";

// ============================================================
// admin-queries.js — getSalesReport con aislamiento por sucursal
// (T10 del plan de roles).
//
// Reglas que fija:
//   - bruto, por método y por día SOLO de la sucursal del admin;
//   - `net` = bruto − devuelto, y la devolución de la OTRA
//     sucursal no puede restar;
//   - el superadmin conserva su filtro por sucursal del panel
//     (?branch= del query), que el branch_admin no puede usar.
//
// El agrupado por día usa arDay (huso fijo de Argentina), así que
// los resultados no dependen de la máquina donde corre el test.
// ============================================================

async function makeDb() {
  const client = createClient({ url: "file::memory:" });
  const db = createDb(client);
  await db.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      payment_method TEXT NOT NULL DEFAULT 'mercadopago',
      payment_status TEXT NOT NULL DEFAULT 'approved',
      total INTEGER NOT NULL DEFAULT 0,
      refunded_amount INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

const FROM = "2026-01-01T00:00:00.000Z";
const TO = "2026-01-31T23:59:59.999Z";
let seq = 0;

async function addOrder(db, o = {}) {
  seq += 1;
  const ts = o.created_at || "2026-01-15T15:00:00.000Z";
  const r = await db
    .prepare(
      `INSERT INTO orders
        (order_number, branch, payment_method, payment_status, status, total, refunded_amount, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)`
    )
    .run(
      `FW-${String(seq).padStart(5, "0")}`,
      o.branch || "tandil",
      o.payment_method || "mercadopago",
      o.payment_status || "approved",
      o.total ?? 10000,
      o.refunded ?? 0,
      ts,
      ts
    );
  return Number(r.lastInsertRowid);
}

// Mismo set para todos los tests: tandil tiene un MP y un efectivo;
// necochea un MP aprobado y uno devuelto por completo.
async function seed(db) {
  await addOrder(db, { branch: "tandil", total: 10000, payment_method: "mercadopago", created_at: "2026-01-15T15:00:00.000Z" });
  await addOrder(db, { branch: "tandil", total: 5000, payment_method: "efectivo", created_at: "2026-01-15T16:00:00.000Z" });
  await addOrder(db, { branch: "necochea", total: 20000, payment_method: "mercadopago", created_at: "2026-01-16T15:00:00.000Z" });
  // Devolución TOTAL: sale de la venta (refunded != approved) pero su
  // plata devuelta tiene que verse para quien la pueda ver.
  await addOrder(db, { branch: "necochea", total: 7000, refunded: 4000, payment_status: "refunded", created_at: "2026-01-17T15:00:00.000Z" });
}

describe("getSalesReport", () => {
  it("branch_admin: por método y por día SOLO de su sucursal; la devolución del otro local no resta", async () => {
    const db = await makeDb();
    await seed(db);

    const r = await getSalesReport(db, { fromIso: FROM, toIso: TO, scope: "tandil" });
    assert.equal(r.total, 15000, "10000 MP + 5000 efectivo, nada de necochea");
    assert.equal(r.count, 2);
    assert.equal(r.devuelto, 0, "los 4000 devueltos en necochea no pueden restarle");
    assert.equal(r.net, 15000);
    assert.equal(r.average, 7500);

    // Desglose por método: solo el de su sucursal
    const mp = r.byMethod.find((m) => m.method === "mercadopago");
    assert.equal(mp.total, 10000, "el MP de 20000 de necochea no entra");
    const ef = r.byMethod.find((m) => m.method === "efectivo");
    assert.equal(ef.count, 1);

    // Desglose por día: solo el día de SUS pedidos
    assert.deepEqual(r.byDay.map((d) => d.date), ["2026-01-15"]);

    assert.deepEqual(r.period, { from: FROM, to: TO });
  });

  it("superadmin (scope null): consolidado de ambas, net = bruto − devuelto", async () => {
    const db = await makeDb();
    await seed(db);

    const r = await getSalesReport(db, { fromIso: FROM, toIso: TO, scope: null });
    assert.equal(r.total, 35000, "10000 + 5000 + 20000 (el refunded no es venta)");
    assert.equal(r.count, 3);
    assert.equal(r.devuelto, 4000);
    assert.equal(r.net, 31000);
    // El desglose por día sale SOLO de la venta aprobada: el pedido
    // del día 17 está refunded (no es venta), su plata solo entra
    // como `devuelto`. Los días del 15 y 16 son de tandil y
    // necochea: el superadmin ve ambos locales.
    assert.deepEqual(r.byDay.map((d) => d.date), ["2026-01-15", "2026-01-16"]);
  });

  it("superadmin conserva su filtro por sucursal del panel", async () => {
    const db = await makeDb();
    await seed(db);

    const r = await getSalesReport(db, { fromIso: FROM, toIso: TO, scope: null, branch: "necochea" });
    assert.equal(r.total, 20000, "solo el aprobado de necochea");
    assert.equal(r.count, 1);
    assert.equal(r.devuelto, 4000);
    assert.equal(r.net, 16000);
  });

  it("si llega branch junto con un scope, el scope manda (branch_admin)", async () => {
    const db = await makeDb();
    await seed(db);

    // El endpoint del branch_admin ni le pasa `branch`, pero si
    // igual llega, no puede abrirle la otra sucursal.
    const r = await getSalesReport(db, { fromIso: FROM, toIso: TO, scope: "tandil", branch: "necochea" });
    assert.equal(r.total, 15000);
    assert.ok(r.byMethod.every((m) => m.total <= 10000));
  });
});
