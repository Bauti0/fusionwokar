import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { openCashRegister, closeCashRegister, getCashRegisterState } from "../server/admin-queries.js";
import { deleteCashRegister, applyCashDeletion, getDeletedCashRegisters } from "../server/cash-register.js";
import { migrateCashRegisters } from "../server/migrations-cash.js";

// ============================================================
// cash-register.js — ANULACIÓN de caja (soft delete).
//
// Reglas que fija:
//   - La fila NO se borra: deleted_at + deleted_reason, y una fila de
//     auditoría (field='deleted') con la foto JSON de la caja.
//   - Motivo obligatorio (trim, mínimo 5). Anular dos veces → 400.
//   - Caja ajena a un branch_admin → 404 (igual que cierre/corrección).
//   - La anulada desaparece de TODO: caja abierta, historial (y con él
//     el ticket de cierre, que sale de data.history) y la validación de
//     "ya hay una caja abierta" (se puede reabrir en la sucursal).
//   - CAS: UPDATE + INSERT de auditoría condicionados a los valores
//     leídos en UN db.batch; una carrera → 409 y no escribe nada.
//   - Historial de anulaciones: SOLO superadmin (403 al branch_admin).
//   - Migración de arranque: una base vieja (sin deleted_at y con el
//     índice único viejo) migra sin error, conserva datos y queda con
//     el índice nuevo; correrla dos veces es un no-op.
// ============================================================

// Los clientes nativos de libsql se cierran todos en el after: si quedan
// abiertos el proceso muere con 0xC0000005 al terminar (mismo motivo que
// test/admin-cash.test.js).
const clients = [];
after(() => {
  for (const c of clients) c.close();
});

// Mismo esquema que db.js POST-migraciones (las tablas se crean a mano
// porque createDb es solo la facade SQL y nada corre db.js). El índice
// único "active" (ignora las anuladas) lo crea migrateCashRegisters.
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
const T9 = "2026-01-12T09:00:00.000Z";
const SUPER = { role: "superadmin", userId: null, branch: null };
const ADMIN_TANDIL = { role: "branch_admin", userId: 7, branch: "tandil", username: "admin-tandil" };

// Caja abierta en `branch` con fondo 10000.
async function cajaAbierta(db, branch = "tandil") {
  const r = await openCashRegister(db, { branch, openingAmount: 10000, nowIso: T0 });
  return r.id;
}
async function cajaCerrada(db, branch = "tandil") {
  const id = await cajaAbierta(db, branch);
  await closeCashRegister(db, id, { counted: 12000, notes: "cierre", scope: branch, nowIso: T1 });
  return id;
}

describe("deleteCashRegister", () => {
  it("anular un cierre válido: desaparece del historial (y con él del ticket) y audita con foto", async () => {
    const db = await makeDb();
    const id = await cajaCerrada(db, "tandil");

    const r = await deleteCashRegister(db, id, { reason: "Caja abierta en sucursal equivocada" }, { admin: SUPER, nowIso: T2 });
    assert.equal(r.ok, true);
    assert.ok(r.row.deleted_at, "queda marcada, no borrada");
    assert.equal(r.row.deleted_reason, "Caja abierta en sucursal equivocada");

    // Ni la caja abierta ni el historial la muestran (el ticket del cierre
    // sale de data.history: al no estar, tampoco se puede imprimir).
    const state = await getCashRegisterState(db, "tandil");
    assert.equal(state.open, null);
    assert.equal(state.history.length, 0);

    // Auditoría: una fila field='deleted' con la foto JSON de la caja.
    const audit = await db
      .prepare("SELECT * FROM cash_register_corrections WHERE cash_register_id = ? AND field = 'deleted'")
      .get(id);
    assert.ok(audit, "hay fila de auditoría");
    assert.equal(audit.reason, "Caja abierta en sucursal equivocada");
    const foto = JSON.parse(audit.new_value);
    assert.equal(foto.branch, "tandil");
    assert.equal(foto.estado, "cerrada");
    assert.equal(foto.openingAmount, 10000);
    assert.equal(foto.closingCounted, 12000);
    assert.equal(foto.expectedAmount, 10000);
    assert.equal(foto.difference, 2000);
    assert.equal(foto.deletedAt, T2);
  });

  it("anular una caja ABIERTA: desaparece de la abierta y libera la sucursal para reabrir", async () => {
    const db = await makeDb();
    const id = await cajaAbierta(db, "tandil");

    const r = await deleteCashRegister(db, id, { reason: "Se abrió donde no era" }, { admin: ADMIN_TANDIL, nowIso: T2 });
    assert.equal(r.ok, true);
    const foto = JSON.parse(r.row.deleted_reason && (await db
      .prepare("SELECT new_value FROM cash_register_corrections WHERE cash_register_id = ? AND field = 'deleted'")
      .get(id)).new_value);
    assert.equal(foto.estado, "abierta");
    assert.equal(foto.closingCounted, null);

    // La validación "ya hay una caja abierta" ignora la anulada:
    // reabrir en la misma sucursal tiene que funcionar.
    const r2 = await openCashRegister(db, { branch: "tandil", openingAmount: 5000, nowIso: T9 });
    assert.equal(r2.ok, true, "se puede abrir una nueva caja en la sucursal");
    assert.notEqual(r2.id, id);
  });

  it("sin motivo (o corto) → 400 y no escribe nada", async () => {
    const db = await makeDb();
    const id = await cajaCerrada(db, "tandil");

    for (const reason of ["", "   ", "x"]) {
      const r = await deleteCashRegister(db, id, { reason }, { admin: SUPER, nowIso: T2 });
      assert.equal(r.error.status, 400);
      assert.match(r.error.error, /motivo/i);
    }
    const row = await db.prepare("SELECT deleted_at FROM cash_registers WHERE id = ?").get(id);
    assert.equal(row.deleted_at, null, "la caja sigue vigente");
  });

  it("anular dos veces → 400 'ya está anulada'", async () => {
    const db = await makeDb();
    const id = await cajaCerrada(db, "tandil");
    const motivo = { reason: "duplicada por error de sucursal" };

    const r1 = await deleteCashRegister(db, id, motivo, { admin: SUPER, nowIso: T1 });
    assert.equal(r1.ok, true);
    const r2 = await deleteCashRegister(db, id, motivo, { admin: SUPER, nowIso: T2 });
    assert.equal(r2.error.status, 400);
    assert.match(r2.error.error, /anulada/);
    // Una sola fila de auditoría, no dos.
    const n = await db
      .prepare("SELECT COUNT(*) AS n FROM cash_register_corrections WHERE cash_register_id = ? AND field = 'deleted'")
      .get(id);
    assert.equal(n.n, 1);
  });

  it("branch_admin sobre caja ajena → 404 (mismo que inexistente); la propia sí se anula", async () => {
    const db = await makeDb();
    const ajena = await cajaCerrada(db, "necochea");
    const propia = await cajaCerrada(db, "tandil");

    const rNone = await deleteCashRegister(db, ajena, { reason: "motivo válido" }, { scope: "tandil", admin: ADMIN_TANDIL, nowIso: T2 });
    assert.equal(rNone.error.status, 404);

    const rOk = await deleteCashRegister(db, propia, { reason: "motivo válido" }, { scope: "tandil", admin: ADMIN_TANDIL, nowIso: T2 });
    assert.equal(rOk.ok, true, "el branch_admin SÍ anula la de su sucursal");
  });

  it("no se cierra, corrige ni reaparece una caja anulada", async () => {
    const db = await makeDb();
    const abierta = await cajaAbierta(db, "tandil");
    await deleteCashRegister(db, abierta, { reason: "prueba de anulación" }, { admin: SUPER, nowIso: T1 });

    // Cerrar → 404 (las anuladas no existen para close ni correct).
    const rc = await closeCashRegister(db, abierta, { counted: 10000, scope: "tandil", nowIso: T2 });
    assert.equal(rc.status, 404);
  });

  it("historial de anulaciones: superadmin lo ve, branch_admin recibe 403", async () => {
    const db = await makeDb();
    const id = await cajaCerrada(db, "tandil");
    await deleteCashRegister(db, id, { reason: "motivo de prueba" }, { admin: ADMIN_TANDIL, nowIso: T2 });

    const r403 = await getDeletedCashRegisters(db, ADMIN_TANDIL);
    assert.equal(r403.error.status, 403);

    const rOk = await getDeletedCashRegisters(db, SUPER);
    assert.equal(rOk.rows.length, 1);
    const foto = JSON.parse(rOk.rows[0].new_value);
    assert.equal(foto.branch, "tandil");
    assert.equal(foto.estado, "cerrada");
    assert.equal(rOk.rows[0].reason, "motivo de prueba");
    assert.equal(rOk.rows[0].admin_username, "admin-tandil");
  });

  it("CAS: si la caja cambió entre la lectura y el batch → 409 y no escribe nada", async () => {
    const db = await makeDb();
    const id = await cajaCerrada(db, "tandil");
    const row = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(id);

    // Entremedio alguien corrigió la caja: los valores leídos ya no matchean.
    await db
      .prepare("UPDATE cash_registers SET opening_amount = 99999, updated_at = ? WHERE id = ?")
      .run(T9, id);

    const w = await applyCashDeletion(db, row, {
      reason: "motivo con carrera",
      snapshot: "{}",
      admin: SUPER,
      nowIso: T9,
    });
    assert.deepEqual(w, { conflict: true }, "el wrapper traduce conflict a 409");
    const post = await db.prepare("SELECT opening_amount, deleted_at FROM cash_registers WHERE id = ?").get(id);
    assert.equal(post.opening_amount, 99999, "no pisó la corrección");
    assert.equal(post.deleted_at, null, "no quedó anulada");
    const auditN = await db
      .prepare("SELECT COUNT(*) AS n FROM cash_register_corrections WHERE cash_register_id = ?")
      .get(id);
    assert.equal(auditN.n, 0, "el INSERT de auditoría tampoco aplicó");
  });

  it("atomicidad: si falla el INSERT de auditoría, el UPDATE queda revertido", async () => {
    const db = await makeDb();
    const id = await cajaCerrada(db, "tandil");
    const row = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(id);
    await db.exec("DROP TABLE cash_register_corrections");

    await assert.rejects(() =>
      applyCashDeletion(db, row, { reason: "va a fallar", snapshot: "{}", admin: SUPER, nowIso: T9 })
    );
    const post = await db.prepare("SELECT deleted_at FROM cash_registers WHERE id = ?").get(id);
    assert.equal(post.deleted_at, null, "la transacción se revirtió entera");
  });
});

describe("migración de arranque con base vieja", () => {
  it("migra sin fallar, conserva datos, deja el índice nuevo y es idempotente", async () => {
    // Base VIEJA: cash_registers sin deleted_at/deleted_reason/corrected_at
    // y con el índice único viejo (solo WHERE closed_at IS NULL).
    const client = createClient({ url: "file::memory:" });
    clients.push(client);
    const db = createDb(client);
    await db.exec(`
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
      CREATE UNIQUE INDEX uq_cash_registers_open_branch
        ON cash_registers(branch) WHERE closed_at IS NULL;
    `);
    await db.prepare(
      `INSERT INTO cash_registers (branch, opening_amount, opened_at, created_at, updated_at)
       VALUES ('tandil', 10000, ?, ?, ?)`
    ).run(T0, T0, T0);
    await db.prepare(
      `INSERT INTO cash_registers (branch, opening_amount, opened_at, closing_counted, closed_at, expected_amount, difference, notes, created_at, updated_at)
       VALUES ('necochea', 5000, ?, 7000, ?, 5000, 2000, 'viejo', ?, ?)`
    ).run(T0, T1, T0, T1);

    await migrateCashRegisters(db, T2);

    const cols = (await db.prepare("PRAGMA table_info(cash_registers)").all()).map((c) => c.name);
    for (const c of ["corrected_at", "deleted_at", "deleted_reason"]) {
      assert.ok(cols.includes(c), `columna ${c} agregada`);
    }
    const rows = await db.prepare("SELECT * FROM cash_registers ORDER BY id").all();
    assert.equal(rows.length, 2, "no perdió filas");
    assert.equal(rows[0].opening_amount, 10000);
    assert.equal(rows[1].closing_counted, 7000);
    assert.equal(rows[0].deleted_at, null);

    const idx = (await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all()).map((i) => i.name);
    assert.ok(idx.includes("uq_cash_registers_open_branch_active"), "está el índice nuevo");
    assert.ok(!idx.includes("uq_cash_registers_open_branch"), "el viejo ya no está");

    // Idempotente: correrla de nuevo no falla ni cambia nada.
    await migrateCashRegisters(db, T9);
    const rowsAgain = await db.prepare("SELECT COUNT(*) AS n FROM cash_registers").get();
    assert.equal(rowsAgain.n, 2);
  });

  it("con el índice nuevo, anular una caja abierta permite reabrir (la garantía de respaldo no bloquea)", async () => {
    const client = createClient({ url: "file::memory:" });
    clients.push(client);
    const db = createDb(client);
    await db.exec(`
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
      CREATE UNIQUE INDEX uq_cash_registers_open_branch
        ON cash_registers(branch) WHERE closed_at IS NULL;
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
    `);
    await migrateCashRegisters(db, T0);
    const r1 = await openCashRegister(db, { branch: "tandil", openingAmount: 1000, nowIso: T0 });
    const d = await deleteCashRegister(db, r1.id, { reason: "sucursal equivocada" }, { admin: SUPER, nowIso: T1 });
    assert.equal(d.ok, true);
    // Sin el filtro deleted_at en el índice, este INSERT rompería por UNIQUE.
    const r2 = await openCashRegister(db, { branch: "tandil", openingAmount: 2000, nowIso: T2 });
    assert.equal(r2.ok, true, "el índice nuevo no bloquea la reapertura");
  });
});
