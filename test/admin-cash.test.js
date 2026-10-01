import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { getCashRegisterState, openCashRegister, closeCashRegister } from "../server/admin-queries.js";

// ============================================================
// admin-queries.js — arqueo de caja con aislamiento por sucursal
// (T11 del plan de roles).
//
// Reglas que fija:
//   - el branch_admin consulta SU caja: la otra sucursal no
//     aparece ni como abierta ni en el historial;
//   - lo esperado suma el efectivo aprobado de ESA sucursal desde
//     opened_at (la venta de la otra no puede inflar el arqueo);
//   - cerrar un arqueo de la otra sucursal → error genérico
//     "Arqueo no encontrado" (404, sin confirmar existencia).
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE cash_registers (
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
  `);
  return db;
}

const T0 = "2026-01-10T12:00:00.000Z";
const T1 = "2026-01-10T15:00:00.000Z";
const T2 = "2026-01-10T20:00:00.000Z";
let seq = 0;

async function addCash(db, o = {}) {
  const r = await db
    .prepare(
      `INSERT INTO cash_registers
        (branch, opening_amount, opened_at, closing_counted, closed_at, expected_amount, difference, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      o.branch || "tandil",
      o.openingAmount ?? 0,
      o.openedAt || T0,
      o.counted ?? null,
      o.closedAt ?? null,
      o.expected ?? null,
      o.difference ?? null,
      "",
      o.openedAt || T0,
      o.openedAt || T0
    );
  return Number(r.lastInsertRowid);
}

async function addOrder(db, o = {}) {
  seq += 1;
  const ts = o.created_at || T1;
  await db
    .prepare(
      `INSERT INTO orders
        (order_number, branch, payment_method, payment_status, status, total, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `FW-${String(seq).padStart(5, "0")}`,
      o.branch || "tandil",
      o.payment_method || "efectivo",
      o.payment_status || "approved",
      o.status || "completed",
      o.total ?? 1000,
      ts,
      ts
    );
}

describe("getCashRegisterState", () => {
  it("branch_admin: su caja abierta y su historial; la otra sucursal no aparece", async () => {
    const db = await makeDb();
    const abiertaTandil = await addCash(db, { branch: "tandil", openingAmount: 1000 });
    const abiertaNecochea = await addCash(db, { branch: "necochea", openingAmount: 2000 });
    await addCash(db, { branch: "tandil", openingAmount: 500, closedAt: T0, counted: 500, expected: 500, difference: 0 });
    await addCash(db, { branch: "necochea", openingAmount: 700, closedAt: T0, counted: 700, expected: 700, difference: 0 });

    // El requestedBranch ("necochea") se ignora: el scope manda.
    const st = await getCashRegisterState(db, "tandil", "necochea");
    assert.equal(st.open.id, abiertaTandil);
    assert.equal(st.history.length, 1, "solo SU historial");
    assert.ok(st.history.every((r) => r.branch === "tandil"));

    // Superadmin: usa la branch pedida (comportamiento actual)
    const stSuper = await getCashRegisterState(db, null, "necochea");
    assert.equal(stSuper.open.id, abiertaNecochea);
    assert.ok(stSuper.history.every((r) => r.branch === "necochea"));
  });

  it("expectedNow = apertura + efectivo aprobado de ESA sucursal desde opened_at", async () => {
    const db = await makeDb();
    await addCash(db, { branch: "tandil", openingAmount: 10000 });
    // Cuenta: efectivo aprobado de tandil después de abrir
    await addOrder(db, { branch: "tandil", payment_method: "efectivo", total: 5000, created_at: T1 });
    // NO cuenta: lo de antes de abrir
    await addOrder(db, { branch: "tandil", payment_method: "efectivo", total: 9999, created_at: "2026-01-09T12:00:00.000Z" });
    // NO cuenta: la venta de la otra sucursal
    await addOrder(db, { branch: "necochea", payment_method: "efectivo", total: 7777, created_at: T1 });
    // NO cuenta: otros medios de pago
    await addOrder(db, { branch: "tandil", payment_method: "mercadopago", total: 8888, created_at: T1 });
    // NO cuenta: cancelado o no aprobado
    await addOrder(db, { branch: "tandil", payment_method: "efectivo", total: 3333, status: "cancelled", created_at: T1 });

    const st = await getCashRegisterState(db, "tandil", undefined);
    assert.equal(st.expectedNow, 15000, "10000 de apertura + 5000 de efectivo");
  });

  it("sin caja abierta: open null y expectedNow null", async () => {
    const db = await makeDb();
    const st = await getCashRegisterState(db, "tandil", undefined);
    assert.equal(st.open, null);
    assert.equal(st.expectedNow, null);
    assert.deepEqual(st.history, []);
  });
});

describe("openCashRegister", () => {
  it("abrir en su sucursal funciona y devuelve el id; una segunda apertura rebota", async () => {
    const db = await makeDb();
    const r = await openCashRegister(db, { branch: "tandil", openingAmount: 2500, nowIso: T0 });
    assert.equal(r.ok, true);
    assert.ok(Number.isInteger(r.id));

    const doble = await openCashRegister(db, { branch: "tandil", openingAmount: 100, nowIso: T1 });
    assert.match(doble.error, /Ya hay una caja abierta/);

    // La otra sucursal no interfiere
    const otra = await openCashRegister(db, { branch: "necochea", openingAmount: 100, nowIso: T1 });
    assert.equal(otra.ok, true);
  });

  it("monto inválido → error", async () => {
    const db = await makeDb();
    assert.match((await openCashRegister(db, { branch: "tandil", openingAmount: -5, nowIso: T0 })).error, /Monto inicial inválido/);
    assert.match((await openCashRegister(db, { branch: "tandil", openingAmount: "abc", nowIso: T0 })).error, /Monto inicial inválido/);
  });
});

describe("closeCashRegister", () => {
  it("arqueo de la otra sucursal → error genérico (no confirma que exista)", async () => {
    const db = await makeDb();
    const ajena = await addCash(db, { branch: "necochea", openingAmount: 1000 });

    const r = await closeCashRegister(db, ajena, { counted: 500, scope: "tandil", nowIso: T2 });
    assert.match(r.error, /Arqueo no encontrado/);
    // Y sigue abierta
    const row = await db.prepare("SELECT closed_at FROM cash_registers WHERE id = ?").get(ajena);
    assert.equal(row.closed_at, null);
  });

  it("cerrar la propia: expected = apertura + efectivo del turno, difference correcta", async () => {
    const db = await makeDb();
    const id = await addCash(db, { branch: "tandil", openingAmount: 10000 });
    await addOrder(db, { branch: "tandil", payment_method: "efectivo", total: 3000, created_at: T1 });
    await addOrder(db, { branch: "necochea", payment_method: "efectivo", total: 90000, created_at: T1 });

    const r = await closeCashRegister(db, id, { counted: 12000, notes: "turno tarde", scope: "tandil", nowIso: T2 });
    assert.equal(r.ok, true);
    assert.equal(r.expected, 13000, "10000 + 3000 de SU efectivo");
    assert.equal(r.difference, -1000);
  });

  it("no se puede cerrar dos veces; el superadmin (scope null) cierra cualquiera", async () => {
    const db = await makeDb();
    const id = await addCash(db, { branch: "necochea", openingAmount: 500 });
    await addOrder(db, { branch: "necochea", payment_method: "efectivo", total: 200, created_at: T1 });

    const r = await closeCashRegister(db, id, { counted: 700, scope: null, nowIso: T2 });
    assert.equal(r.ok, true);
    assert.equal(r.expected, 700);
    assert.equal(r.difference, 0);

    const reCerrar = await closeCashRegister(db, id, { counted: 700, scope: null, nowIso: T2 });
    assert.match(reCerrar.error, /ya está cerrada/);
  });

  it("arqueo inexistente → error", async () => {
    const db = await makeDb();
    const r = await closeCashRegister(db, 99999, { counted: 100, scope: "tandil", nowIso: T2 });
    assert.match(r.error, /Arqueo no encontrado/);
  });
});
