// Contabilidad de devoluciones.
//
// Vive aparte de index.js por el mismo motivo que coupons.js: es lógica de
// dinero y tiene que poder probarse contra un SQLite en memoria. Recibe `db`
// por parámetro en vez de importarlo, porque importar el singleton de db.js
// dispararía las migraciones contra la base real al correr los tests.

// Historial de devoluciones: [{ id, amount, at }]. Tolerante a filas viejas o
// con el JSON corrupto (devuelve lista vacía en vez de romper el endpoint).
export function parseRefunds(json) {
  if (!json) return [];
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Fusiona las devoluciones que reporta MP con las que ya teníamos anotadas,
// identificadas por el id del reembolso: así el webhook puede repetirse sin
// duplicar historial y, si el admin devolvió desde el panel de MP, lo vemos.
export function mergeRefunds(existing, mpRefunds) {
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const r of mpRefunds) {
    byId.set(r.id, { id: r.id, amount: r.amount, at: byId.get(r.id)?.at || now() });
  }
  return Array.from(byId.values()).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// Cuánto queda por devolver. Se usa tanto para mostrarlo en el panel como para
// rechazar una devolución que supere el total.
export function refundableAmount(row) {
  return Math.max(0, (row.total || 0) - (row.refunded_amount || 0));
}

function now() {
  return new Date().toISOString();
}

// Aplica a la BD el resultado de una devolución (o el estado de reembolsos que
// reporta MP) con un UPDATE condicional que hace de compare-and-set:
//
//   WHERE id = ? AND refunded_amount = <lo que leímos>
//
// Si otro request cambió el pedido entre nuestra lectura y la escritura, el
// UPDATE no matchea (changes === 0) y se reintenta con el estado fresco. Sin
// esto dos devoluciones parciales simultáneas se pisaban: cada una sumaba
// sobre el refunds_json viejo y la última reemplazaba la columna entera, así
// que MP devolvía $300 y la base quedaba diciendo $200 — y el panel ofrecía
// devolver plata que ya no existía.
//
// La suma se hace SIEMPRE acá adentro, sobre la fila recién leída: es la única
// forma de que el merge y la escritura sean atómicos. `mpRefunds` es lo que
// reportó MP (fuente de verdad del monto: si MP aceptó la devolución, se
// registra, porque no registrarla dejaría la base más equivocada todavía).
// `patch(row, { refunds, refundedAmount })` devuelve las columnas extra que
// cada camino necesita escribir (payment_status, status, mp_payment_id...).
export async function applyRefunds(db, orderId, { mpRefunds = [], patch, maxAttempts = 5 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const row = await db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!row) return { ok: false, reason: "not_found", attempts: attempt };

    const refunds = mergeRefunds(parseRefunds(row.refunds_json), mpRefunds);
    const refundedAmount = refunds.reduce((sum, r) => sum + (r.amount || 0), 0);
    const extra = (patch && patch(row, { refunds, refundedAmount })) || {};
    const values = {
      refunded_amount: refundedAmount,
      refunds_json: JSON.stringify(refunds),
      ...extra,
      updated_at: now(),
    };
    const cols = Object.keys(values);
    const changes = await db
      .prepare(
        `UPDATE orders SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND refunded_amount = ?`
      )
      .run(...cols.map((c) => values[c]), orderId, row.refunded_amount || 0)
      .then((r) => r.changes);

    // changes === 1: ganamos la carrera. === 0: otro escribió primero → reintento.
    if (changes === 1) return { ok: true, row: { ...row, ...values }, attempts: attempt };
  }
  return { ok: false, reason: "conflict", attempts: maxAttempts };
}
