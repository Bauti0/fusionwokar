// Reportes del panel (venta y devoluciones).
//
// Igual que coupons.js y refunds.js, recibe `db` por parÃƒÂ¡metro para poder
// probarse contra un SQLite en memoria sin importar el singleton de db.js
// (importarlo dispararÃƒÂ­a las migraciones contra la base real).

// Lo devuelto NO se filtra por payment_status. Un pedido con devoluciÃƒÂ³n total
// pasa a 'refunded' y sale de la venta a propÃƒÂ³sito, pero la plata que se
// devolviÃƒÂ³ tiene que verse igual; si se filtrara por 'approved' esa devoluciÃƒÂ³n
// quedarÃƒÂ­a invisible. Se atribuye por fecha del PEDIDO (created_at), el mismo
// criterio que la venta, para que los dos nÃƒÂºmeros sean comparables.
export function refundedQuery({ fromIso, toIso, branch } = {}) {
  const conds = ["refunded_amount > 0", "created_at >= ?", "created_at <= ?"];
  const args = [fromIso, toIso];
  if (branch) {
    conds.push("branch = ?");
    args.push(branch);
  }
  return {
    sql: `SELECT branch, COALESCE(SUM(refunded_amount), 0) AS s FROM orders WHERE ${conds.join(" AND ")} GROUP BY branch`,
    args,
  };
}

// Suma las filas de refundedQuery.
export function sumRefunded(rows) {
  return rows.reduce((sum, r) => sum + Number(r.s || 0), 0);
}

// Desglose por local: el total y cuÃƒÂ¡nto se devolviÃƒÂ³ en cada sucursal, para
// que el panel pueda decir DE QUÃƒâ€° local es cada nÃƒÂºmero y no solo el agregado.
export function refundedByBranch(rows) {
  const byBranch = new Map();
  let total = 0;
  for (const r of rows) {
    const amount = Number(r.s || 0);
    byBranch.set(r.branch, (byBranch.get(r.branch) || 0) + amount);
    total += amount;
  }
  return { total, byBranch };
}

// La venta que se muestra en el panel es NETA: lo vendido menos lo devuelto.
// Lo devuelto se muestra aparte, asÃƒÂ­ que acÃƒÂ¡ solo se descuenta.
export function netAmount(gross, refunded) {
  return Math.max(0, (gross || 0) - (refunded || 0));
}

// Fecha YYYY-MM-DD en la zona del local (Argentina, UTC-3 fijo) para el
// agrupado diario de ventas. Antes se usaba la fecha UTC del created_at: los
// pedidos de 21:00Ã¢â‚¬â€œ03:00 AR caÃƒÂ­an en el dÃƒÂ­a equivocado. Node 20+ trae ICU.
const AR_DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Argentina/Buenos_Aires",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function arDay(iso) {
  // Sin este filtro, arDay(null) daba "1969-12-31" (new Date(null) es una
  // fecha VÃƒÂLIDA) y el grÃƒÂ¡fico de ventas mostraba un dÃƒÂ­a fantasma de 1970.
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return AR_DAY_FORMAT.format(d);
}

// Reporte de /api/admin/sales: los mismos nÃƒÂºmeros que devuelve la consulta
// (bruto, por mÃƒÂ©todo, por dÃƒÂ­a) mÃƒÂ¡s la NETA, que es lo que va en la tarjeta
// titular del panel.
//
// - `total` sigue siendo el BRUTO: es lo que suman los desgloses por mÃƒÂ©todo y
//   por dÃƒÂ­a, asÃƒÂ­ que cambiarlo los dejarÃƒÂ­a sin cuadrar.
// - `net` es la neta (bruto - devuelto), el mismo nÃƒÂºmero que muestra
//   /api/admin/stats. Es lo que se pinta grande.
// - `average` sale de la neta, NO del bruto: si saliera del bruto, dividir la
//   tarjeta titular por los pedidos darÃƒÂ­a un nÃƒÂºmero distinto al que se ve.
// - `dayOf` es inyectable para poder probar la agrupaciÃƒÂ³n por dÃƒÂ­a sin
//   depender del huso del servidor; en producciÃƒÂ³n es `arDay`.
export function buildSalesReport({ rows = [], refunded = 0, dayOf = arDay } = {}) {
  let total = 0;
  const byMethod = new Map(); // method -> { method, count, total }
  const byDay = new Map(); // YYYY-MM-DD -> { date, count, total }

  for (const r of rows) {
    total += r.total;
    const m = byMethod.get(r.payment_method) || { method: r.payment_method, count: 0, total: 0 };
    m.count += 1;
    m.total += r.total;
    byMethod.set(r.payment_method, m);

    const day = dayOf(r.created_at);
    const d = byDay.get(day) || { date: day, count: 0, total: 0 };
    d.count += 1;
    d.total += r.total;
    byDay.set(day, d);
  }

  const net = netAmount(total, refunded);
  return {
    total,
    net,
    devuelto: refunded || 0,
    count: rows.length,
    average: rows.length > 0 ? Math.round(net / rows.length) : 0,
    byMethod: [...byMethod.values()].sort((a, b) => b.total - a.total),
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
