// Migraciones de arranque de las tablas de CAJA (cash_registers).
//
// Vive en su propio módulo (sin side-effects al importar) para que los
// tests puedan correr la migración COMPLETA contra un SQLite en
// memoria — importar db.js dispararía las migraciones contra Turso.
//
// ORDEN OBLIGATORIO dentro de migrateCashRegisters:
//   1) ensureColumn de TODAS las columnas nuevas (corrected_at,
//      deleted_at, deleted_reason): en una base vieja sin ellas,
//      cualquier SQL posterior que las nombre rompería el arranque.
//   2) Limpieza de cajas abiertas duplicadas (ya puede usar deleted_at).
//   3) Índice único: se crea el NUEVO (con otro nombre) y recién
//      después se dropea el viejo, para no dejar nunca la tabla sin
//      índice único en el medio.
//
// Es idempotente: correrla dos veces es un no-op.

async function ensureColumn(db, table, column, ddl) {
  const cols = await db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export async function migrateCashRegisters(db, nowIso) {
  // 1) Columnas nuevas.
  // corrected_at: fecha de la última corrección de montos de UN cierre
  // (cash-register.js). NULL = nunca corregido.
  await ensureColumn(db, "cash_registers", "corrected_at", "corrected_at TEXT");
  // Anulación de caja (soft delete: la fila NO se borra, conserva el
  // rastro). NULL = vigente. deleted_reason guarda el motivo obligatorio.
  await ensureColumn(db, "cash_registers", "deleted_at", "deleted_at TEXT");
  await ensureColumn(db, "cash_registers", "deleted_reason", "deleted_reason TEXT");

  // 2) Cierre de cajas abiertas duplicadas: una apertura concurrente vieja
  // podía dejar DOS cajas abiertas para la misma sucursal (SELECT + INSERT
  // separados). Se cierran todas menos la más reciente de cada sucursal
  // (las anuladas no cuentan: ya no son cajas).
  const dupOpenCash = await db
    .prepare(
      `SELECT c.id FROM cash_registers c
     WHERE c.closed_at IS NULL AND c.deleted_at IS NULL
       AND c.id <> (SELECT c2.id FROM cash_registers c2
                    WHERE c2.branch = c.branch AND c2.closed_at IS NULL AND c2.deleted_at IS NULL
                    ORDER BY c2.opened_at DESC, c2.id DESC LIMIT 1)`
    )
    .all();
  for (const d of dupOpenCash) {
    await db
      .prepare(
        "UPDATE cash_registers SET closed_at = ?, notes = notes || ' [cierre por duplicado]', updated_at = ? WHERE id = ?"
      )
      .run(nowIso, nowIso, d.id);
  }

  // 3) Índice único de "una caja abierta por sucursal": el predicado
  // ignora las anuladas (anular una caja ABIERTA tiene que permitir
  // reabrir). Se crea el nuevo con otro nombre ANTES de dropear el viejo:
  // nunca queda la tabla sin índice único en el medio.
  try {
    await db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_registers_open_branch_active
        ON cash_registers(branch) WHERE closed_at IS NULL AND deleted_at IS NULL;
      DROP INDEX IF EXISTS uq_cash_registers_open_branch;
    `);
  } catch (err) {
    // Si algún estado raro impide el índice, la apertura sigue protegida por el
    // INSERT condicional del endpoint; solo se pierde la garantía de respaldo.
    console.error("No se pudo crear uq_cash_registers_open_branch_active:", err.message);
  }
}
