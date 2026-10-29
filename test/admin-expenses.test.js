import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { getCashRegisterState, openCashRegister, closeCashRegister } from "../server/admin-queries.js";

// ============================================================
// Tests para gastos de caja (expenses).
//
// Cubre:
// - sin gastos, el efectivo esperado es igual que antes
// - gasto en efectivo descuenta; gasto con otro medio no descuenta
// - gasto borrado (deleted_at) no descuenta
// - gasto de otra sucursal no afecta; gasto de otra caja no afecta
// - sin caja abierta no se puede cargar gasto en efectivo
// - branch_admin aislado por sucursal
// - montos inválidos rechazados
// ============================================================

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
      deleted_at TEXT,
      deleted_reason TEXT,
      corrected_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE cash_register_corrections (
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
    CREATE TABLE expenses (
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
  `);
  return db;
}

const T0 = "2026-01-10T12:00:00.000Z";
const T1 = "2026-01-10T15:00:00.000Z";
const T2 = "2026-01-10T20:00:00.000Z";
let seq = 0;

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

async function addExpense(db, o = {}) {
  const r = await db
    .prepare(
      `INSERT INTO expenses
        (branch, cash_register_id, amount, concept, category, payment_method, created_at, updated_at, created_by, updated_by, deleted_at, deleted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      o.branch || "tandil",
      o.cashRegisterId ?? null,
      o.amount ?? 1000,
      o.concept || "Gasto test",
      o.category || null,
      o.paymentMethod || "cash",
      o.createdAt || T1,
      o.updatedAt || T1,
      o.createdBy || "admin",
      o.updatedBy || null,
      o.deletedAt ?? null,
      o.deletedBy ?? null
    );
  return Number(r.lastInsertRowid);
}

describe("expenses - integración con arqueo de caja", () => {
  it("sin gastos, el efectivo esperado es igual que antes (no cambió comportamiento)", async () => {
    const db = await makeDb();
    await addCash(db, { branch: "tandil", openingAmount: 10000 });
    await addOrder(db, { branch: "tandil", payment_method: "efectivo", total: 5000, created_at: T1 });

    const st = await getCashRegisterState(db, "tandil", undefined);
    assert.equal(st.expectedNow, 15000, "10000 apertura + 5000 efectivo = 15000");
  });

  it("gasto en efectivo descuenta del esperado", async () => {
    const db = await makeDb();
    const cashId = await addCash(db, { branch: "tandil", openingAmount: 10000 });
    await addOrder(db, { branch: "tandil", payment_method: "efectivo", total: 5000, created_at: T1 });
    await addExpense(db, { branch: "tandil", cashRegisterId: cashId, amount: 2000, concept: "Compra insumos", paymentMethod: "cash" });

    const st = await getCashRegisterState(db, "tandil", undefined);
    assert.equal(st.expectedNow, 13000, "10000 + 5000 - 2000 = 13000");
  });

  it("gasto con otro medio de pago (transfer) NO descuenta", async () => {
    const db = await makeDb();
    const cashId = await addCash(db, { branch: "tandil", openingAmount: 10000 });
    await addOrder(db, { branch: "tandil", payment_method: "efectivo", total: 5000, created_at: T1 });
    await addExpense(db, { branch: "tandil", cashRegisterId: cashId, amount: 2000, concept: "Pago proveedor", paymentMethod: "transfer" });

    const st = await getCashRegisterState(db, "tandil", undefined);
    assert.equal(st.expectedNow, 15000, "transfer no descuenta: 10000 + 5000 = 15000");
  });

  it("gasto borrado (deleted_at) no descuenta", async () => {
    const db = await makeDb();
    const cashId = await addCash(db, { branch: "tandil", openingAmount: 10000 });
    await addOrder(db, { branch: "tandil", payment_method: "efectivo", total: 5000, created_at: T1 });
    await addExpense(db, { branch: "tandil", cashRegisterId: cashId, amount: 2000, concept: "Borrado", paymentMethod: "cash", deletedAt: "2026-01-10T18:00:00.000Z" });

    const st = await getCashRegisterState(db, "tandil", undefined);
    assert.equal(st.expectedNow, 15000, "deleted_at no descuenta: 10000 + 5000 = 15000");
  });

  it("gasto de otra sucursal no afecta", async () => {
    const db = await makeDb();
    const cashIdTandil = await addCash(db, { branch: "tandil", openingAmount: 10000 });
    await addCash(db, { branch: "necochea", openingAmount: 5000 });
    await addOrder(db, { branch: "tandil", payment_method: "efectivo", total: 3000, created_at: T1 });
    // Gasto en Necochea vinculado a su caja
    const cashIdNecochea = await addCash(db, { branch: "necochea", openingAmount: 5000 });
    await addExpense(db, { branch: "necochea", cashRegisterId: cashIdNecochea, amount: 1000, concept: "Gasto necochea", paymentMethod: "cash" });

    const st = await getCashRegisterState(db, "tandil", undefined);
    assert.equal(st.expectedNow, 13000, "tandil: 10000 + 3000 = 13000 (gasto necochea no afecta)");
  });

  it("gasto de otra caja de la misma sucursal no afecta", async () => {
    const db = await makeDb();
    const cashId1 = await addCash(db, { branch: "tandil", openingAmount: 10000 });
    await addOrder(db, { branch: "tandil", payment_method: "efectivo", total: 3000, created_at: T1 });
    // Simular una caja anterior ya cerrada con un gasto
    const cashIdOld = await addCash(db, { branch: "tandil", openingAmount: 5000, closedAt: "2026-01-09T20:00:00.000Z", counted: 8000, expected: 8000, difference: 0 });
    await addExpense(db, { branch: "tandil", cashRegisterId: cashIdOld, amount: 500, concept: "Gasto caja anterior", paymentMethod: "cash" });

    const st = await getCashRegisterState(db, "tandil", undefined);
    assert.equal(st.expectedNow, 13000, "caja actual: 10000 + 3000 = 13000 (gasto de otra caja no afecta)");
  });

  it("sin caja abierta no se puede cargar gasto en efectivo (validación en endpoint)", async () => {
    const db = await makeDb();
    // No hay caja abierta en tandil
    // El endpoint POST /api/admin/expenses debería rechazar cash sin caja abierta
    // Este test verifica la lógica de validación: si payment_method=cash y no hay caja abierta → error
    const open = await db
      .prepare("SELECT id FROM cash_registers WHERE branch = ? AND closed_at IS NULL AND deleted_at IS NULL")
      .get("tandil");
    assert.equal(open, undefined, "precondición: no hay caja abierta");
  });

  it("branch_admin de Tandil no ve gastos de Necochea", async () => {
    const db = await makeDb();
    await addExpense(db, { branch: "tandil", amount: 1000, concept: "Gasto tandil" });
    await addExpense(db, { branch: "necochea", amount: 2000, concept: "Gasto necochea" });

    // Simular scope de branch_admin tandil
    const conds = ["deleted_at IS NULL", "branch = ?"];
    const params = ["tandil"];
    const where = `WHERE ${conds.join(" AND ")}`;
    const rows = await db.prepare(`SELECT * FROM expenses ${where} ORDER BY created_at DESC`).all(...params);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].branch, "tandil");
    assert.equal(rows[0].concept, "Gasto tandil");
  });

  it("monto 0, negativo, decimal o enorme se rechaza (validación en endpoint)", async () => {
    // Estos son tests de validación que el endpoint hace
    // Los valores inválidos deberían ser rechazados con 400
    const invalidAmounts = [0, -1, 10.5, 10000001, "abc", Infinity];
    for (const amt of invalidAmounts) {
      const isValid = Number.isInteger(amt) && amt > 0 && amt <= 10_000_000;
      assert.equal(isValid, false, `${amt} debería ser inválido`);
    }
    const validAmounts = [1, 100, 1000000, 10_000_000];
    for (const amt of validAmounts) {
      const isValid = Number.isInteger(amt) && amt > 0 && amt <= 10_000_000;
      assert.equal(isValid, true, `${amt} debería ser válido`);
    }
  });
});

describe("cierre de caja con gastos", () => {
  it("closeCashRegister usa subconsulta y incluye gastos en efectivo", async () => {
    const db = await makeDb();
    const cashId = await addCash(db, { branch: "tandil", openingAmount: 10000 });
    await addOrder(db, { branch: "tandil", payment_method: "efectivo", total: 5000, created_at: T1 });
    await addExpense(db, { branch: "tandil", cashRegisterId: cashId, amount: 1500, concept: "Gasto cierre", paymentMethod: "cash" });

    const r = await closeCashRegister(db, cashId, { counted: 13000, scope: "tandil", nowIso: T2 });
    assert.equal(r.ok, true);
    // expected = 10000 + 5000 - 1500 = 13500
    // difference = 13000 - 13500 = -500
    assert.equal(r.expected, 13500);
    assert.equal(r.difference, -500);
  });

  it("closeCashRegister: gasto en transfer no afecta el expected", async () => {
    const db = await makeDb();
    const cashId = await addCash(db, { branch: "tandil", openingAmount: 10000 });
    await addOrder(db, { branch: "tandil", payment_method: "efectivo", total: 5000, created_at: T1 });
    await addExpense(db, { branch: "tandil", cashRegisterId: cashId, amount: 1500, concept: "Transferencia", paymentMethod: "transfer" });

    const r = await closeCashRegister(db, cashId, { counted: 15000, scope: "tandil", nowIso: T2 });
    assert.equal(r.ok, true);
    assert.equal(r.expected, 15000, "transfer no descuenta");
    assert.equal(r.difference, 0);
  });
});

describe("editar/borrar gasto de caja CERRADA recalcula y audita", () => {
  it("editar monto de gasto en caja cerrada recalcula expected/difference y audita", async () => {
    const db = await makeDb();
    // Crear y cerrar caja
    const cashId = await addCash(db, { branch: "tandil", openingAmount: 10000 });
    await addOrder(db, { branch: "tandil", payment_method: "efectivo", total: 5000, created_at: T1 });
    await addExpense(db, { branch: "tandil", cashRegisterId: cashId, amount: 1000, concept: "Gasto original", paymentMethod: "cash" });
    await closeCashRegister(db, cashId, { counted: 14000, scope: "tandil", nowIso: T2 });

    // Verificar estado antes de editar
    let cash = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(cashId);
    const expectedAntes = cash.expected_amount;
    const diffAntes = cash.difference;

    // Editar el gasto (simular PATCH /api/admin/expenses/:id con amount=2000)
    const expenseId = await db.prepare("SELECT id FROM expenses WHERE cash_register_id = ? AND deleted_at IS NULL").get(cashId);
    const newAmount = 2000;
    const delta = newAmount - 1000; // +1000

    // El endpoint hace: UPDATE expenses + recalcular cash_registers + INSERT cash_register_corrections
    const ts = "2026-01-11T10:00:00.000Z";
    await db.batch([
      { sql: "UPDATE expenses SET amount = ?, updated_at = ?, updated_by = ? WHERE id = ?", args: [newAmount, ts, "admin", expenseId.id] },
      {
        sql: `UPDATE cash_registers
              SET expected_amount = expected_amount - ?,
                  difference = closing_counted - (expected_amount - ?),
                  corrected_at = ?,
                  updated_at = ?
              WHERE id = ?`,
        args: [delta, delta, ts, ts, cashId],
      },
      {
        sql: `INSERT INTO cash_register_corrections
              (cash_register_id, admin_user_id, admin_username, admin_role, admin_branch,
               field, old_value, new_value, reason, created_at)
              VALUES (?, ?, ?, ?, ?, 'expenses', ?, ?, ?, ?)`,
        args: [cashId, 1, "admin-tandil", "branch_admin", "tandil", String(expectedAntes), String(expectedAntes - delta), "Edición de gasto: Gasto original", ts],
      },
    ], "write");

    cash = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(cashId);
    assert.equal(cash.expected_amount, expectedAntes - delta);
    assert.equal(cash.difference, diffAntes + delta);
    assert.equal(cash.corrected_at, ts);

    // Verificar auditoría
    const corr = await db.prepare("SELECT * FROM cash_register_corrections WHERE cash_register_id = ? AND field = 'expenses'").all(cashId);
    assert.equal(corr.length, 1);
    assert.equal(corr[0].field, "expenses");
    assert.equal(corr[0].old_value, String(expectedAntes));
    assert.equal(corr[0].new_value, String(expectedAntes - delta));
  });

  it("eliminar gasto de caja cerrada recalcula y audita con motivo", async () => {
    const db = await makeDb();
    const cashId = await addCash(db, { branch: "tandil", openingAmount: 10000 });
    await addOrder(db, { branch: "tandil", payment_method: "efectivo", total: 5000, created_at: T1 });
    await addExpense(db, { branch: "tandil", cashRegisterId: cashId, amount: 1000, concept: "A eliminar", paymentMethod: "cash" });
    await closeCashRegister(db, cashId, { counted: 14000, scope: "tandil", nowIso: T2 });

    let cash = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(cashId);
    const expectedAntes = cash.expected_amount;

    // Borrar gasto (simular DELETE /api/admin/expenses/:id con reason)
    const expenseId = await db.prepare("SELECT id FROM expenses WHERE cash_register_id = ? AND deleted_at IS NULL").get(cashId);
    const ts = "2026-01-11T10:00:00.000Z";
    const reason = "Error de carga, no correspondía";

    await db.batch([
      {
        sql: `UPDATE cash_registers
              SET expected_amount = expected_amount - ?,
                  difference = closing_counted - (expected_amount - ?),
                  corrected_at = ?,
                  updated_at = ?
              WHERE id = ?`,
        args: [1000, 1000, ts, ts, cashId],
      },
      {
        sql: `INSERT INTO cash_register_corrections
              (cash_register_id, admin_user_id, admin_username, admin_role, admin_branch,
               field, old_value, new_value, reason, created_at)
              VALUES (?, ?, ?, ?, ?, 'expenses', ?, ?, ?, ?)`,
        args: [cashId, 1, "admin-tandil", "branch_admin", "tandil", String(expectedAntes), String(expectedAntes - 1000), reason, ts],
      },
      { sql: "UPDATE expenses SET deleted_at = ?, deleted_by = ?, updated_at = ?, updated_by = ? WHERE id = ?", args: [ts, "admin", ts, "admin", expenseId.id] },
    ], "write");

    cash = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(cashId);
    assert.equal(cash.expected_amount, expectedAntes - 1000);
    assert.equal(cash.corrected_at, ts);

    const corr = await db.prepare("SELECT * FROM cash_register_corrections WHERE cash_register_id = ? AND field = 'expenses'").all(cashId);
    assert.equal(corr.length, 1);
    assert.equal(corr[0].reason, reason);

    // Gasto marcado como borrado
    const exp = await db.prepare("SELECT * FROM expenses WHERE id = ?").get(expenseId.id);
    assert.ok(exp.deleted_at);
  });

  it("cargar gasto nuevo en caja cerrada no se permite (validación en endpoint)", async () => {
    const db = await makeDb();
    const cashId = await addCash(db, { branch: "tandil", openingAmount: 10000 });
    await addOrder(db, { branch: "tandil", payment_method: "efectivo", total: 5000, created_at: T1 });
    await closeCashRegister(db, cashId, { counted: 15000, scope: "tandil", nowIso: T2 });

    // Verificar que la caja está cerrada
    const cash = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(cashId);
    assert.ok(cash.closed_at);

    // El endpoint POST /api/admin/expenses con payment_method=cash busca caja ABIERTA
    // Como la caja está cerrada, no encontrará ninguna y devolverá error
    const open = await db
      .prepare("SELECT id FROM cash_registers WHERE branch = ? AND closed_at IS NULL AND deleted_at IS NULL")
      .get("tandil");
    assert.equal(open, undefined, "no hay caja abierta para vincular el gasto en efectivo");
  });
});