import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { openCashRegister, closeCashRegister } from "../server/admin-queries.js";
import {
  rowToCashRegister,
  computeCashCorrection,
  applyCashCorrection,
  correctCashRegister,
  getCashCorrections,
  MAX_CASH_AMOUNT,
} from "../server/cash-register.js";

// ============================================================
// cash-register.js — corrección de cierres de caja.
//
// Reglas que fija:
//   - Solo se corrigen cajas CERRADAS (una abierta responde 400).
//   - Editables: openingAmount, efectivoCobrado (el congelado al cerrar),
//     closingCounted y notes. expectedAmount y difference JAMÁS se
//     editan: se recalculan y se registran en la auditoría como
//     derivados, para que el historial muestre el impacto completo.
//   - Motivo obligatorio (trim, mínimo 5 caracteres). Un no-op no
//     escribe absolutamente nada.
//   - Scope igual que el cierre: una caja ajena responde con el mismo
//     404 que una inexistente.
//   - Compare-and-set: la corrección aplica UPDATE + INSERTs condicionados
//     a los valores leídos en UN db.batch atómico; si otra corrección se
//     coló, no se aplica nada y responde 409.
//   - Historial de correcciones: SOLO superadmin (403 al branch_admin).
// ============================================================

// Los clientes nativos de libsql se cierran todos en el after: si quedan
// abiertos el proceso muere con 0xC0000005 al terminar (mismo motivo que
// test/admin-cash.test.js).
const clients = [];
after(() => {
  for (const c of clients) c.close();
});

// Mismo esquema que db.js (cash_registers ya tiene corrected_at; las
// migraciones corren solas al iniciar el server contra Turso, acá las
// tablas se crean a mano porque nada corre db.js).
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
      corrected_at TEXT,
      deleted_at TEXT,
      deleted_reason TEXT,
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
const T3 = "2026-01-11T10:00:00.000Z";
const SUPER = { role: "superadmin", userId: null, branch: null };
const ADMIN_TANDIL = { role: "branch_admin", userId: 7, branch: "tandil", username: "admin-tandil" };

async function addCashOrder(db, total) {
  await db
    .prepare(
      `INSERT INTO orders (order_number, branch, payment_method, payment_status, status, total, created_at, updated_at)
       VALUES (?, 'tandil', 'efectivo', 'approved', 'completed', ?, ?, ?)`
    )
    .run(`FW-${Math.random().toString(16).slice(2)}`, total, T1, T1);
}

// Caja cerrada en tandil: fondo 10000 + un pedido en efectivo de 5000
// → esperado 15000, y se cierra contando `counted`.
async function cajaCerrada(db, { branch = "tandil", counted = 13000, notes = "cierre original" } = {}) {
  const r = await openCashRegister(db, { branch, openingAmount: 10000, nowIso: T0 });
  if (branch === "tandil") await addCashOrder(db, 5000);
  await closeCashRegister(db, r.id, { counted, notes, scope: branch, nowIso: T2 });
  return db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(r.id);
}

const auditCount = (db, cashId) =>
  db.prepare("SELECT COUNT(*) AS n FROM cash_register_corrections WHERE cash_register_id = ?").get(cashId).then((r) => r.n);

describe("correctCashRegister", () => {
  it("edición válida: recalcula expected/difference, marca corrected_at y audita los 4 campos + los 2 derivados", async () => {
    const db = await makeDb();
    const cash = await cajaCerrada(db, { counted: 13000 }); // esperado 15000, diferencia -2000
    const r = await correctCashRegister(db, cash.id, {
      openingAmount: 12000,
      efectivoCobrado: 6000,
      closingCounted: 18000,
      notes: "nota corregida",
      reason: "  Fondo inicial mal cargado  ",
    }, { scope: null, admin: SUPER, nowIso: T3 });
    assert.ifError(r.error);

    const updated = r.row;
    assert.equal(updated.opening_amount, 12000);
    assert.equal(updated.expected_amount, 18000, "esperado = 12000 + 6000");
    assert.equal(updated.difference, 0, "diferencia = 18000 - 18000");
    assert.equal(updated.notes, "nota corregida");
    assert.equal(updated.corrected_at, T3);
    assert.equal(cash.corrected_at, null, "antes no estaba corregida");

    const rows = await db
      .prepare("SELECT * FROM cash_register_corrections WHERE cash_register_id = ? ORDER BY id")
      .all(cash.id);
    const byField = Object.fromEntries(rows.map((x) => [x.field, x]));
    // Editables
    assert.deepEqual([byField.openingAmount.old_value, byField.openingAmount.new_value], ["10000", "12000"]);
    assert.deepEqual([byField.efectivoCobrado.old_value, byField.efectivoCobrado.new_value], ["5000", "6000"]);
    assert.deepEqual([byField.closingCounted.old_value, byField.closingCounted.new_value], ["13000", "18000"]);
    assert.deepEqual([byField.notes.old_value, byField.notes.new_value], ["cierre original", "nota corregida"]);
    // Derivados (viejo -> nuevo): el historial muestra el impacto completo
    assert.deepEqual([byField.expectedAmount.old_value, byField.expectedAmount.new_value], ["15000", "18000"]);
    assert.deepEqual([byField.difference.old_value, byField.difference.new_value], ["-2000", "0"]);
    assert.equal(rows.length, 6);
    // Identidad compartida de la corrección: misma fecha, autor y motivo (trimmeado)
    for (const x of rows) {
      assert.equal(x.created_at, T3);
      assert.equal(x.reason, "Fondo inicial mal cargado");
      assert.equal(x.admin_role, "superadmin");
      assert.equal(x.admin_user_id, null, "el superadmin del .env no tiene userId");
    }
  });

  it("motivo faltante o muy corto → 400 y no escribe nada", async () => {
    const db = await makeDb();
    const cash = await cajaCerrada(db);
    for (const reason of ["", "   ", "abcd"]) {
      const r = await correctCashRegister(db, cash.id, { closingCounted: 14000, reason }, { scope: null, admin: SUPER, nowIso: T3 });
      assert.equal(r.error.status, 400);
      assert.match(r.error.error, /motivo/i);
    }
    assert.equal(await auditCount(db, cash.id), 0);
    const row = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(cash.id);
    assert.equal(row.corrected_at, null, "no queda marca de corrección");
  });

  it("monto inválido (negativo, decimal, vacío, gigante) → 400 con mensaje claro", async () => {
    const db = await makeDb();
    const cash = await cajaCerrada(db);
    for (const value of [-1, 10.5, "", MAX_CASH_AMOUNT + 1, Infinity, "abc"]) {
      const r = await correctCashRegister(db, cash.id, { closingCounted: value, reason: "motivo válido" }, { scope: null, admin: SUPER, nowIso: T3 });
      assert.equal(r.error.status, 400, `value=${value} debe rechazarse`);
      assert.match(r.error.error, /entero entre 0 y 100000000/);
    }
    const ok = await correctCashRegister(db, cash.id, { closingCounted: 0, reason: "cuenta exacta en cero" }, { scope: null, admin: SUPER, nowIso: T3 });
    assert.ifError(ok.error, "el 0 es un monto válido");
  });

  it("caja abierta → 400 (solo se corrigen cierres)", async () => {
    const db = await makeDb();
    const r = await openCashRegister(db, { branch: "tandil", openingAmount: 10000, nowIso: T0 });
    const res = await correctCashRegister(db, r.id, { openingAmount: 5000, reason: "motivo válido" }, { scope: "tandil", admin: ADMIN_TANDIL, nowIso: T3 });
    assert.equal(res.error.status, 400);
    assert.match(res.error.error, /cerradas/);
  });

  it("branch_admin sobre caja de otra sucursal → 404 (igual que inexistente)", async () => {
    const db = await makeDb();
    const cash = await cajaCerrada(db, { branch: "tandil" });
    const r = await correctCashRegister(db, cash.id, { closingCounted: 99999, reason: "motivo válido" }, {
      scope: "necochea",
      admin: { role: "branch_admin", branch: "necochea", userId: 9, username: "admin-necochea" },
      nowIso: T3,
    });
    assert.equal(r.error.status, 404);
    assert.equal(await auditCount(db, cash.id), 0);
  });

  it("historial: branch_admin → 403; superadmin → las filas ordenadas", async () => {
    const db = await makeDb();
    const cash = await cajaCerrada(db);
    await correctCashRegister(db, cash.id, { closingCounted: 14000, reason: "Corte de turno mal contado" }, { scope: "tandil", admin: ADMIN_TANDIL, nowIso: T3 });

    const denied = await getCashCorrections(db, ADMIN_TANDIL, cash.id);
    assert.equal(denied.error.status, 403);

    const ok = await getCashCorrections(db, SUPER, cash.id);
    assert.ifError(ok.error);
    assert.equal(ok.rows.length, 2, "un campo editado + su derivado (la diferencia)");
    assert.equal(ok.rows[0].admin_username, "admin-tandil");
    assert.equal(ok.rows[0].reason, "Corte de turno mal contado");
  });

  it("no-op (valores iguales): no escribe filas ni marca corrected_at", async () => {
    const db = await makeDb();
    const cash = await cajaCerrada(db, { counted: 13000 });
    const r = await correctCashRegister(db, cash.id, {
      openingAmount: 10000,
      efectivoCobrado: 5000,
      closingCounted: 13000,
      notes: "cierre original",
      reason: "motivo que no cambia nada",
    }, { scope: null, admin: SUPER, nowIso: T3 });
    assert.ifError(r.error);
    assert.equal(r.message, "Sin cambios");
    assert.equal(await auditCount(db, cash.id), 0);
    const row = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(cash.id);
    assert.equal(row.corrected_at, null);
  });

  it("atomicidad: si un INSERT de auditoría falla, el UPDATE se revierte", async () => {
    const db = await makeDb();
    const cash = await cajaCerrada(db);
    await db.exec(`
      CREATE TRIGGER fail_corr BEFORE INSERT ON cash_register_corrections
      BEGIN SELECT RAISE(ABORT, 'falló el INSERT'); END;
    `);
    await assert.rejects(
      correctCashRegister(db, cash.id, { closingCounted: 14000, reason: "motivo válido" }, { scope: null, admin: SUPER, nowIso: T3 }),
      /falló el INSERT/
    );
    const row = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(cash.id);
    assert.equal(row.closing_counted, 13000, "el UPDATE no quedó aplicado");
    assert.equal(row.corrected_at, null, "ni siquiera la marca pendiente");
  });

  it("compare-and-set: si otra corrección se coló, se responde conflicto y no se aplica nada", async () => {
    const db = await makeDb();
    const cash = await cajaCerrada(db);
    // Corrección A leída sobre el estado original...
    const result = computeCashCorrection(cash, { closingCounted: 20000, reason: "Corrección A tardía" });
    assert.ifError(result.error);
    // ...pero otra corrección aplica primero.
    const b = await correctCashRegister(db, cash.id, { closingCounted: 16000, reason: "Corrección B primera" }, { scope: null, admin: SUPER, nowIso: T3 });
    assert.ifError(b.error);
    const antes = await auditCount(db, cash.id);

    // A aplica con su lectura VIEJA: nada se aplica y vuelve conflicto (409).
    const w = await applyCashCorrection(db, cash, result, SUPER, T3);
    assert.ok(w.conflict);
    const rowAfter = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(cash.id);
    assert.equal(rowAfter.closing_counted, 16000, "gana la corrección que llegó primero");
    assert.equal(rowAfter.corrected_at, T3, "la marca es la de B, no la de A");
    assert.equal(await auditCount(db, cash.id), antes, "la corrección en conflicto no audita nada");
    assert.equal(antes > 0, true, "la corrección B sí quedó auditada");
  });

  it("rowToCashRegister expone correctedAt (null si nunca se corrigió)", async () => {
    const db = await makeDb();
    const cash = await cajaCerrada(db);
    assert.equal(rowToCashRegister(cash).correctedAt, null);
    await correctCashRegister(db, cash.id, { notes: "", reason: "borrado de nota original" }, { scope: null, admin: SUPER, nowIso: T3 });
    const updated = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(cash.id);
    assert.equal(rowToCashRegister(updated).correctedAt, T3);
  });
});
