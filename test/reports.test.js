import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { refundedQuery, sumRefunded, refundedByBranch, netAmount } from "../server/reports.js";

// El reporte de devoluciones se prueba contra un SQLite real en memoria,
// porque el defecto vive en el WHERE de la consulta (qué pedidos entran),
// no en una suma suelta: un mock no probaria nada.

function iso(dayOffset = 0) {
  return new Date(Date.now() + dayOffset * 86400000).toISOString();
}

async function makeDb() {
  const client = createClient({ url: "file::memory:" });
  const db = createDb(client);
  await db.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL DEFAULT 'tandil',
      total INTEGER NOT NULL DEFAULT 0,
      refunded_amount INTEGER NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'approved',
      status TEXT NOT NULL DEFAULT 'received',
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

async function addOrder(db, { total, refunded = 0, payment = "approved", branch = "tandil", at = iso(0), status = "received" }) {
  await db
    .prepare(
      "INSERT INTO orders (branch, total, refunded_amount, payment_status, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(branch, total, refunded, payment, status, at);
}

async function runRefunded(db, opts) {
  const q = refundedQuery(opts);
  const rows = await db.prepare(q.sql).all(...q.args);
  return sumRefunded(rows);
}

// ---------------------------------------------------------------------
// LA REGRESION: el panel sumaba la venta de los pedidos "approved" y nunca
// restaba lo devuelto, asi que un parcial seguia contando como ingreso
// completo. Peor: un pedido con devolucion TOTAL pasa a payment_status
// 'refunded' y desaparecia del panel entero, incluida la plata devuelta.
// ---------------------------------------------------------------------

describe("lo devuelto en el periodo", () => {
  it("cuenta parciales y totales juntos", async () => {
    const db = await makeDb();
    await addOrder(db, { total: 1000, refunded: 200 });              // parcial: sigue 'approved'
    await addOrder(db, { total: 500, refunded: 500, payment: "refunded" }); // total: sale de la venta
    await addOrder(db, { total: 800, refunded: 0, payment: "refunded" });   // refunded sin monto (viejo)
    await addOrder(db, { total: 700, refunded: 0 });                 // sin devolucion

    assert.equal(await runRefunded(db, { fromIso: iso(-1), toIso: iso(1) }), 700);
  });

  it("incluye el pedido con devolucion total (payment_status 'refunded')", async () => {
    const db = await makeDb();
    await addOrder(db, { total: 500, refunded: 500, payment: "refunded" });
    // El filtro viejo (payment_status = 'approved') daria 0 y la plata
    // devuelta quedaria invisible.
    assert.equal(await runRefunded(db, { fromIso: iso(-1), toIso: iso(1) }), 500);
  });

  it("no cuenta pedidos creados fuera del periodo", async () => {
    const db = await makeDb();
    await addOrder(db, { total: 1000, refunded: 300, at: iso(-10) });
    await addOrder(db, { total: 1000, refunded: 100, at: iso(0) });
    assert.equal(await runRefunded(db, { fromIso: iso(-1), toIso: iso(1) }), 100);
  });

  it("filtra por sucursal cuando se pide", async () => {
    const db = await makeDb();
    await addOrder(db, { total: 1000, refunded: 200, branch: "tandil" });
    await addOrder(db, { total: 1000, refunded: 350, branch: "necochea" });
    assert.equal(await runRefunded(db, { fromIso: iso(-1), toIso: iso(1), branch: "necochea" }), 350);
    assert.equal(await runRefunded(db, { fromIso: iso(-1), toIso: iso(1) }), 550);
  });

  it("sin devoluciones da 0", async () => {
    const db = await makeDb();
    await addOrder(db, { total: 1000, refunded: 0 });
    assert.equal(await runRefunded(db, { fromIso: iso(-1), toIso: iso(1) }), 0);
  });

  it("sumRefunded tolera filas vacias", () => {
    assert.equal(sumRefunded([]), 0);
    assert.equal(sumRefunded([{ s: null }, { s: 150 }]), 150);
  });
});

// El panel tiene que poder decir de qué local es cada número: con dos
// sucursales, un total agregado no alcanza para saber dónde se devolvió.

describe("desglose por local", () => {
  it("agrupa lo devuelto por sucursal", async () => {
    const db = await makeDb();
    await addOrder(db, { total: 1000, refunded: 200, branch: "tandil" });
    await addOrder(db, { total: 1000, refunded: 120, branch: "tandil" });
    await addOrder(db, { total: 1000, refunded: 350, branch: "necochea" });
    const q = refundedQuery({ fromIso: iso(-1), toIso: iso(1) });
    const rows = await db.prepare(q.sql).all(...q.args);

    const { total, byBranch } = refundedByBranch(rows);
    assert.equal(total, 670);
    assert.equal(byBranch.get("tandil"), 320);
    assert.equal(byBranch.get("necochea"), 350);
  });

  it("un local sin devoluciones da 0 y no aparece", async () => {
    const db = await makeDb();
    await addOrder(db, { total: 1000, refunded: 200, branch: "tandil" });
    const q = refundedQuery({ fromIso: iso(-1), toIso: iso(1) });
    const rows = await db.prepare(q.sql).all(...q.args);
    const { total, byBranch } = refundedByBranch(rows);
    assert.equal(total, 200);
    assert.equal(byBranch.get("necochea") || 0, 0);
  });

  it("refundedByBranch tolera filas vacias", () => {
    const { total, byBranch } = refundedByBranch([]);
    assert.equal(total, 0);
    assert.equal(byBranch.size, 0);
  });
});

// La venta que se muestra en el panel es NETA (lo vendido menos lo devuelto),
// con lo devuelto aparte para que se vea la diferencia.

describe("venta neta", () => {
  it("descuenta lo devuelto", () => {
    assert.equal(netAmount(1000, 250), 750);
  });

  it("nunca da negativo si se devolvio mas de lo vendido", () => {
    assert.equal(netAmount(1000, 1500), 0);
  });

  it("sin devoluciones queda igual", () => {
    assert.equal(netAmount(1000, 0), 1000);
  });

  it("tolera valores faltantes", () => {
    assert.equal(netAmount(null, null), 0);
    assert.equal(netAmount(undefined, 0), 0);
  });
});
