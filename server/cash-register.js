// ============================================================
// Corrección de CIERRES DE CAJA (monto inicial / efectivo cobrado /
// contado / notas de un arqueo ya cerrado).
//
// Campos: en un cierre cerrado hay dos inputs humanos y dos calculados.
//   · openingAmount (fondo inicial) y closingCounted (contado físico):
//     editables. `efectivoCobrado` (el esperado original menos el fondo,
//     congelado al cerrar) también es editable: si un pedido cambió de
//     medio de pago DESPUÉS del cierre, el efectivo real del turno
//     cambió y el congelado queda mal. El admin carga el valor a mano;
//     NO se recalcula solo desde los pedidos.
//   · expectedAmount = openingAmount + efectivoCobrado.
//   · difference = closingCounted - expectedAmount.
// Los dos últimos JAMÁS se editan directo: se recalculan y se registran
// en la auditoría marcados como derivados (la UI los rotula
// "(recalculado)").
//
// Lógica pura al estilo de server/order-edit.js: compute / apply / get
// se testean contra SQLite en memoria; los endpoints (index.js) son
// puro pegamento.
// ============================================================

// Tope de monto de una corrección: $100.000.000, enteros positivos
// (validado también en el front con el mismo tope y mensaje claro).
export const MAX_CASH_AMOUNT = 100_000_000;
const MONTO_INVALIDO = "Monto inválido: debe ser un entero entre 0 y 100000000";
const MOTIVO_MIN = 5;

// La forma camelCase que devuelve GET /api/admin/cash-register (la
// consumen el panel, el ticket y los tests).
export function rowToCashRegister(row) {
  return {
    id: row.id,
    branch: row.branch,
    openingAmount: row.opening_amount,
    openedAt: row.opened_at,
    closingCounted: row.closing_counted,
    closedAt: row.closed_at,
    expectedAmount: row.expected_amount,
    difference: row.difference,
    notes: row.notes,
    correctedAt: row.corrected_at,
  };
}

// Entero en [0, MAX_CASH_AMOUNT] o null si no sirve. El campo vacío NO
// es $0: la distinción entre "no vino" y "vino vacío" la hace el
// llamador (campo ausente = sin cambio).
function parseMonto(v) {
  if (typeof v === "string") {
    if (v.trim() === "") return null;
    v = Number(v);
  }
  if (!Number.isInteger(v) || v < 0 || v > MAX_CASH_AMOUNT) return null;
  return v;
}

// Lógica pura de la corrección. `row` es la fila ACTUAL de
// cash_registers (ya validada: cerrada y de la sucursal del admin).
// Devuelve:
//   { error }                      → validación con { status, error }
//   { noop: true }                 → nada cambió, no se escribe nada
//   { updates, changed, reason }   → valores nuevos + lista antes/después
// changed[] trae los 4 campos editables y los derivados marcados.
export function computeCashCorrection(row, body = {}) {
  if (!row.closed_at) return { error: { status: 400, error: "Solo se corrigen cajas cerradas" } };

  const reason = String(body.reason ?? "").trim();
  if (reason.length < MOTIVO_MIN) {
    return { error: { status: 400, error: `Ingresá un motivo (mínimo ${MOTIVO_MIN} caracteres)` } };
  }

  // Valores vigentes. El efectivo cobrado congelado al cerrar se deriva,
  // nunca se guardó como columna propia.
  const vigente = {
    openingAmount: Number(row.opening_amount),
    efectivoCobrado: Number(row.expected_amount) - Number(row.opening_amount),
    closingCounted: Number(row.closing_counted),
    notes: row.notes ?? "",
  };

  // Campo ausente en el body = sin cambio; campo presente pero inválido
  // = 400 con el nombre del campo (hay 3 montos, hay que saber cuál).
  const montos = ["openingAmount", "efectivoCobrado", "closingCounted"];
  const nuevo = { ...vigente };
  for (const f of montos) {
    if (body[f] === undefined || body[f] === null) continue;
    const m = parseMonto(body[f]);
    if (m === null) return { error: { status: 400, error: `${f}: ${MONTO_INVALIDO}` } };
    nuevo[f] = m;
  }
  if (body.notes !== undefined && body.notes !== null) {
    nuevo.notes = String(body.notes).slice(0, 500);
  }

  // Derivados: SIEMPRE recalculados de los editables, nunca del body.
  const expectedAmount = nuevo.openingAmount + nuevo.efectivoCobrado;
  const difference = nuevo.closingCounted - expectedAmount;
  const updates = {
    openingAmount: nuevo.openingAmount,
    closingCounted: nuevo.closingCounted,
    expectedAmount,
    difference,
    notes: nuevo.notes,
  };

  const changed = [];
  for (const f of [...montos, "notes"]) {
    if (String(vigente[f]) !== String(nuevo[f])) {
      changed.push({ field: f, oldValue: vigente[f], newValue: nuevo[f], derived: false });
    }
  }
  for (const [f, oldV, newV] of [
    ["expectedAmount", row.expected_amount, expectedAmount],
    ["difference", row.difference, difference],
  ]) {
    if (Number(oldV) !== Number(newV)) {
      changed.push({ field: f, oldValue: oldV, newValue: newV, derived: true });
    }
  }

  // No-op: ningún campo EDITABLE cambió (un derivado solo cambia si
  // cambió un editable). No se escribe absolutamente nada.
  if (!changed.some((c) => !c.derived)) return { noop: true, updates };

  return { updates, changed, reason };
}

// Condición compare-and-set: la fila sigue EXACTAMENTE como se leyó al
// computar. `IS ?` compara valores admitiendo NULL (corrected_at es NULL
// hasta la primera corrección). Con esto dos correcciones simultáneas
// no se pisan: la segunda no aplica NADA y responde 409.
const CAS_WHERE = `
  id = ? AND opening_amount = ? AND closing_counted IS ?
  AND expected_amount IS ? AND difference IS ? AND notes = ?
  AND corrected_at IS ? AND deleted_at IS NULL`;

function casArgs(row) {
  return [
    row.id,
    row.opening_amount,
    row.closing_counted,
    row.expected_amount,
    row.difference,
    row.notes,
    row.corrected_at ?? null,
  ];
}

export async function applyCashCorrection(db, row, result, admin, nowIso) {
  const auditSql = `
    INSERT INTO cash_register_corrections
      (cash_register_id, admin_user_id, admin_username, admin_role, admin_branch,
       field, old_value, new_value, reason, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM cash_registers WHERE ${CAS_WHERE})`;

  // Los INSERT de auditoría van ANTES del UPDATE dentro del mismo
  // batch: todos revalidan los valores leídos. db.batch(stmts, "write")
  // envuelve todo en UNA transacción (si un INSERT falla, el UPDATE se
  // revierte: nunca BEGIN/COMMIT sueltos, ver server/order-edit.js).
  const stmts = [];
  for (const c of result.changed) {
    stmts.push({
      sql: auditSql,
      args: [
        row.id,
        admin?.userId ?? null,
        admin?.username ?? (admin?.role === "superadmin" ? "superadmin" : "unknown"),
        admin?.role ?? "unknown",
        admin?.branch ?? "",
        c.field,
        c.oldValue == null ? null : String(c.oldValue),
        c.newValue == null ? null : String(c.newValue),
        result.reason,
        nowIso,
        ...casArgs(row),
      ],
    });
  }
  stmts.push({
    sql: `UPDATE cash_registers
      SET opening_amount = ?, closing_counted = ?, expected_amount = ?, difference = ?,
          notes = ?, corrected_at = ?, updated_at = ?
      WHERE ${CAS_WHERE}`,
    args: [
      result.updates.openingAmount,
      result.updates.closingCounted,
      result.updates.expectedAmount,
      result.updates.difference,
      result.updates.notes,
      nowIso,
      nowIso,
      ...casArgs(row),
    ],
  });

  const results = await db.batch(stmts, "write");
  // Si otra corrección se coló entre la lectura y el batch, el UPDATE
  // no toca nada (rowsAffected=0) y los INSERT tampoco por el WHERE EXISTS.
  const info = results[results.length - 1];
  if (!info.rowsAffected) return { conflict: true };
  return { ok: true };
}

// Corrección completa: lectura con scope → validación/cómputo →
// escritura atómica. El scope hace que una caja ajena responda con el
// mismo 404 que una inexistente (igual que closeCashRegister).
export async function correctCashRegister(db, id, body, { scope, admin, nowIso } = {}) {
  if (!Number.isInteger(id) || id <= 0) {
    return { error: { status: 404, error: "Arqueo no encontrado" } };
  }
  // Las anuladas (soft delete) no se corrigen: mismo 404 que inexistente.
  const row = await db.prepare("SELECT * FROM cash_registers WHERE id = ? AND deleted_at IS NULL").get(id);
  if (!row || (scope && row.branch !== scope)) {
    return { error: { status: 404, error: "Arqueo no encontrado" } };
  }
  const result = computeCashCorrection(row, body);
  if (result.error) return result;
  if (result.noop) return { ok: true, row, message: "Sin cambios" };
  const w = await applyCashCorrection(db, row, result, admin, nowIso);
  if (w.conflict) {
    return { error: { status: 409, error: "La caja cambió, recargá y reintentá" } };
  }
  const updated = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(id);
  return { ok: true, row: updated };
}

// Historial de correcciones de un arqueo: SOLO superadmin (403 al
// branch_admin aunque la caja sea de su sucursal). Una fila por campo;
// la UI las agrupa por (admin, created_at, reason).
export async function getCashCorrections(db, admin, id) {
  if (admin?.role !== "superadmin") {
    return { error: { status: 403, error: "Solo el administrador principal puede ver el historial" } };
  }
  if (!Number.isInteger(id) || id <= 0) {
    return { error: { status: 404, error: "Arqueo no encontrado" } };
  }
  const row = await db.prepare("SELECT id FROM cash_registers WHERE id = ?").get(id);
  if (!row) return { error: { status: 404, error: "Arqueo no encontrado" } };
  const rows = await db
    .prepare(
      `SELECT id, field, old_value, new_value, reason,
              admin_user_id, admin_username, admin_role, admin_branch, created_at
       FROM cash_register_corrections WHERE cash_register_id = ?
       ORDER BY created_at DESC, id DESC`
    )
    .all(id);
  return { rows };
}

// ============================================================
// ANULACIÓN de caja (soft delete): la fila NO se borra, queda
// marcada con deleted_at + deleted_reason y una fila de auditoría
// (field = 'deleted') registra quién lo hizo, el motivo y una foto
// JSON de la caja al anularla (para reconstruirla: la corrección
// posterior queda bloqueada, así que la fila ya no cambia).
//
// Sirve para cajas abiertas Y cerradas (el caso típico: se abrió
// una caja en la sucursal equivocada). Anular una ABIERTA libera la
// sucursal para abrir otra (todas las lecturas y el índice único
// ignoran deleted_at). Una caja ya anulada responde 400.
// ============================================================

// CAS de la anulación: la fila sigue EXACTAMENTE como se leyó
// (deleted_at sigue NULL). `IS ?` compara admitiendo NULL.
const DELETE_CAS_WHERE = `
  id = ? AND opening_amount = ? AND closing_counted IS ?
  AND expected_amount IS ? AND difference IS ? AND notes = ?
  AND closed_at IS ? AND deleted_at IS NULL`;

function deleteCasArgs(row) {
  return [
    row.id,
    row.opening_amount,
    row.closing_counted,
    row.expected_amount,
    row.difference,
    row.notes,
    row.closed_at ?? null,
  ];
}

// Escritura atómica: INSERT de auditoría condicionado (WHERE EXISTS con
// el CAS) ANTES del UPDATE, en UN db.batch. Si la caja cambió entremedio
// (otra anulación, cierre concurrente), nada aplica y devuelve conflict.
export async function applyCashDeletion(db, row, { reason, snapshot, admin, nowIso } = {}) {
  const stmts = [
    {
      sql: `INSERT INTO cash_register_corrections
        (cash_register_id, admin_user_id, admin_username, admin_role, admin_branch,
         field, old_value, new_value, reason, created_at)
        SELECT ?, ?, ?, ?, ?, 'deleted', NULL, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM cash_registers WHERE ${DELETE_CAS_WHERE})`,
      args: [
        row.id,
        admin?.userId ?? null,
        admin?.username ?? (admin?.role === "superadmin" ? "superadmin" : "unknown"),
        admin?.role ?? "unknown",
        admin?.branch ?? "",
        snapshot,
        reason,
        nowIso,
        ...deleteCasArgs(row),
      ],
    },
    {
      sql: `UPDATE cash_registers SET deleted_at = ?, deleted_reason = ?, updated_at = ?
        WHERE ${DELETE_CAS_WHERE}`,
      args: [nowIso, reason, nowIso, ...deleteCasArgs(row)],
    },
  ];
  const results = await db.batch(stmts, "write");
  if (!results[results.length - 1].rowsAffected) return { conflict: true };
  return { ok: true };
}

export async function deleteCashRegister(db, id, body = {}, { scope, admin, nowIso } = {}) {
  if (!Number.isInteger(id) || id <= 0) {
    return { error: { status: 404, error: "Arqueo no encontrado" } };
  }
  const row = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(id);
  // Caja ajena = mismo 404 que inexistente (igual que cierre/corrección).
  if (!row || (scope && row.branch !== scope)) {
    return { error: { status: 404, error: "Arqueo no encontrado" } };
  }
  const reason = String(body.reason ?? "").trim();
  if (reason.length < MOTIVO_MIN) {
    return { error: { status: 400, error: `Ingresá un motivo (mínimo ${MOTIVO_MIN} caracteres)` } };
  }
  if (row.deleted_at) {
    return { error: { status: 400, error: "Esta caja ya está anulada" } };
  }

  // Foto de la caja al anularla (estado incluido), para reconstruirla.
  const snapshot = JSON.stringify({
    branch: row.branch,
    estado: row.closed_at ? "cerrada" : "abierta",
    openingAmount: row.opening_amount,
    openedAt: row.opened_at,
    closingCounted: row.closing_counted,
    closedAt: row.closed_at,
    expectedAmount: row.expected_amount,
    difference: row.difference,
    notes: row.notes,
    deletedAt: nowIso,
  });

  const w = await applyCashDeletion(db, row, { reason, snapshot, admin, nowIso });
  if (w.conflict) {
    return { error: { status: 409, error: "La caja cambió, recargá y reintentá" } };
  }
  const updated = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(id);
  return { ok: true, row: updated };
}

// Historial de anulaciones (las filas field='deleted' de la auditoría,
// con la foto JSON de cada caja anulada). SOLO superadmin: 403 al
// branch_admin, y su UI ni siquiera hace la llamada.
export async function getDeletedCashRegisters(db, admin) {
  if (admin?.role !== "superadmin") {
    return { error: { status: 403, error: "Solo el administrador principal puede ver el historial" } };
  }
  const rows = await db
    .prepare(
      `SELECT corr.id, corr.cash_register_id, corr.reason, corr.new_value,
              corr.admin_user_id, corr.admin_username, corr.admin_role, corr.admin_branch,
              corr.created_at, c.deleted_at
       FROM cash_register_corrections corr
       JOIN cash_registers c ON c.id = corr.cash_register_id
       WHERE corr.field = 'deleted'
       ORDER BY corr.created_at DESC, corr.id DESC
       LIMIT 100`
    )
    .all();
  return { rows };
}
