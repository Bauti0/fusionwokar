// ============================================================
// FUSIÓN WOK — Queries del panel admin con aislamiento por
// sucursal (Etapa B del plan de roles).
//
// Igual que coupons.js / admin-users.js: recibe `db` inyectable
// para probarse contra un SQLite en memoria (createDb) sin
// importar el singleton de db.js, que dispararía las migraciones
// contra la base real.
//
// Convenio de `scope` (TODA la etapa):
//   - null  → superadmin: ve y toca todo (comportamiento actual).
//   - "necochea" / "tandil" → branch_admin: SOLO su sucursal.
//     Para rutas con :id, una fila ajena se trata como 404 (null),
//     nunca 403, para no confirmar su existencia.
// La sucursal del admin sale SIEMPRE de req.admin (resuelta del
// token), nunca de un parámetro del cliente.
// ============================================================

import { MENUS } from "../src/data/menus.js";
import { refundedQuery, sumRefunded, refundedByBranch, netAmount, buildSalesReport, arDay } from "./reports.js";

// Listado de pedidos del panel: filtros + búsqueda + paginación.
// `branch` es el filtro del ?branch= del query, que SOLO aplica
// para el superadmin (scope null): el endpoint ni se lo pasa si
// viene de un branch_admin, y si igual llega con scope, acá se
// ignora — el scope manda.
export async function listOrders(db, { scope, branch, search, status, payment, includePending, page, limit } = {}) {
  const conds = [];
  const params = [];

  if (scope) {
    conds.push("branch = ?");
    params.push(scope);
  } else if (branch) {
    conds.push("branch = ?");
    params.push(branch);
  }
  if (status && status !== "all") {
    conds.push("status = ?");
    params.push(status);
  }
  if (payment && payment !== "all") {
    conds.push("payment_status = ?");
    params.push(payment);
  }

  // Por defecto no se muestran los pagos de MP pendientes (pedidos
  // no confirmados)
  if (includePending !== "1") {
    conds.push("(payment_method != 'mercadopago' OR payment_status != 'pending')");
  }

  if (search) {
    conds.push("(order_number LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const offset = (safePage - 1) * safeLimit;
  const totalRow = await db.prepare(`SELECT COUNT(*) AS n FROM orders ${where}`).get(...params);
  const total = totalRow.n;
  const rows = await db
    .prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, safeLimit, offset);
  return { rows, total, page: safePage, limit: safeLimit, hasMore: offset + rows.length < total };
}

// Carga un pedido por id respetando el scope: fila ajena → null
// (el endpoint responde 404, sin confirmar la existencia).
export async function getOrderScoped(db, id, scope) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!row) return null;
  if (scope && row.branch !== scope) return null;
  return row;
}

// Sucursal efectiva de una operación de ESCRITURA (crear pedido
// manual, producto, categoría…). El branch_admin cae SIEMPRE en
// su sucursal, venga lo que venga en el body; el superadmin
// elige, pero la sucursal tiene que existir de verdad (MENUS).
export function effectiveBranch(admin, requested) {
  if (admin?.role === "branch_admin") return { branch: admin.branch };
  if (typeof requested === "string" && MENUS[requested.trim()]) {
    return { branch: requested.trim() };
  }
  return { error: "Sucursal inválida" };
}

// ============================================================
// Reporte de ventas del panel (antes inline en GET /api/admin/sales).
//
// `total` es el BRUTO (es lo que suman los desgloses por método y
// por día); `net` es la neta (bruto − devuelto), el número que se
// pinta grande. La devolución de la OTRA sucursal no puede restar.
// `branch` es el filtro del panel del superadmin y solo aplica con
// scope null (igual que en listOrders).
// ============================================================
export async function getSalesReport(db, { fromIso, toIso, scope, branch } = {}) {
  const conds = ["payment_status = 'approved'", "status != 'cancelled'", "created_at >= ?", "created_at <= ?"];
  const params = [fromIso, toIso];
  const filtro = scope || branch;
  if (filtro) {
    conds.push("branch = ?");
    params.push(filtro);
  }
  const where = `WHERE ${conds.join(" AND ")}`;

  const rows = await db.prepare(`SELECT payment_method, total, created_at FROM orders ${where}`).all(...params);

  // Lo devuelto va por afuera de la consulta de arriba, que filtra
  // 'approved': si no, una devolución total (payment_status 'refunded')
  // quedaría invisible. Ver server/reports.js.
  const rq = refundedQuery({ fromIso, toIso, branch: filtro });
  const devuelto = sumRefunded(await db.prepare(rq.sql).all(...rq.args));

  // El panel muestra `net` (bruto - devuelto) como titular, igual que
  // /api/admin/stats. `total` sigue siendo el bruto.
  const report = buildSalesReport({ rows, refunded: devuelto, dayOf: arDay });
  return { period: { from: fromIso, to: toIso }, ...report };
}

// ============================================================
// Clientes del panel (antes inline en GET /api/admin/customers):
// agregado por teléfono NORMALIZADO (solo dígitos), para que los
// pedidos con formato viejo (espacios/guiones/+54) no abran un
// cliente duplicado. Se muestra el formato más reciente.
//
// Con scope, el gasto total y el historial se calculan SOLO con
// los pedidos de la sucursal del admin (decisión 9 del dueño).
// ============================================================
export async function listCustomers(db, { scope, branch, search } = {}) {
  const conds = [];
  const params = [];
  const filtro = scope || branch;
  if (filtro) {
    conds.push("branch = ?");
    params.push(filtro);
  }
  if (search) {
    conds.push("(customer_name LIKE ? OR customer_phone LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  // Por cliente (teléfono): nombre y dirección más recientes,
  // cantidad de pedidos, gasto total y fecha del último pedido.
  const rows = await db
    .prepare(
      `SELECT
       customer_phone AS phone,
       customer_name AS name,
       address,
       branch,
       total,
       created_at
     FROM orders ${where}
     ORDER BY created_at DESC`
    )
    .all(...params);

  const byPhone = new Map();
  for (const r of rows) {
    const key = String(r.phone || "").replace(/\D/g, "");
    if (!key) continue;
    const entry = byPhone.get(key) || {
      phone: r.phone,
      name: r.name,
      address: "",
      branch: r.branch,
      ordersCount: 0,
      totalSpent: 0,
      lastOrderAt: r.created_at,
    };
    entry.phone = r.phone || entry.phone;
    entry.name = r.name || entry.name;
    entry.ordersCount += 1;
    entry.totalSpent += r.total;
    if (!entry.address && r.address) entry.address = r.address;
    byPhone.set(key, entry);
  }
  return Array.from(byPhone.values()).sort(
    (a, b) => new Date(b.lastOrderAt) - new Date(a.lastOrderAt)
  );
}

// ============================================================
// Arqueo de caja (antes inline en los endpoints /cash-register).
//
// `scope` es el convenio de la etapa: el branch_admin opera SOLO
// su sucursal (requestedBranch se ignora); el superadmin mantiene
// el comportamiento actual y elige con ?branch=/body.
// El módulo devuelve rows crudas: el mapeo a la respuesta del
// panel (rowToCashRegister) queda en el endpoint.
// ============================================================

// Efectivo aprobado (no cancelado) de una sucursal desde una fecha.
// Lo esperado de la caja = apertura + esto.
async function cashIncomeSince(db, branch, sinceIso) {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(total), 0) AS s FROM orders
     WHERE branch = ? AND payment_method = 'efectivo' AND payment_status = 'approved'
       AND status != 'cancelled' AND created_at >= ?`
    )
    .get(branch, sinceIso);
  return Number(row.s) || 0;
}

export async function getCashRegisterState(db, scope, requestedBranch) {
  const branch = scope || requestedBranch;
  if (!branch) return { open: null, history: [], expectedNow: null };
  const results = await db.batch(
    [
      {
        sql: "SELECT * FROM cash_registers WHERE branch = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",
        args: [branch],
      },
      {
        sql: "SELECT * FROM cash_registers WHERE branch = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 30",
        args: [branch],
      },
    ],
    "read"
  );
  const open = results[0].rows[0] || null;
  const history = results[1].rows;

  let expectedNow = null;
  if (open) {
    expectedNow = open.opening_amount + (await cashIncomeSince(db, branch, open.opened_at));
  }
  return { open, history, expectedNow };
}

export async function openCashRegister(db, { branch, openingAmount, nowIso } = {}) {
  if (!branch) return { error: "Falta la sucursal", status: 400 };
  // Campo vacío no debe interpretarse como $0 (Number("") === 0)
  if (String(openingAmount ?? "").trim() === "") {
    return { error: "Ingresá el monto inicial", status: 400 };
  }
  const amount = Number(openingAmount);
  if (!Number.isFinite(amount) || amount < 0) return { error: "Monto inicial inválido", status: 400 };
  const already = await db
    .prepare("SELECT id FROM cash_registers WHERE branch = ? AND closed_at IS NULL")
    .get(branch);
  if (already) return { error: "Ya hay una caja abierta en esta sucursal", status: 400 };
  // INSERT condicional y atómico (el WHERE NOT EXISTS se evalúa dentro de la
  // misma sentencia): dos aperturas simultáneas no pueden crear cajas
  // duplicadas. El índice único parcial de db.js es la garantía de respaldo.
  const info = await db
    .prepare(
      `INSERT INTO cash_registers (branch, opening_amount, opened_at, notes, created_at, updated_at)
       SELECT ?, ?, ?, '', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM cash_registers WHERE branch = ? AND closed_at IS NULL)`
    )
    .run(branch, Math.round(amount), nowIso, nowIso, nowIso, branch);
  if (info.changes === 0) {
    return { error: "Ya hay una caja abierta en esta sucursal", status: 400 };
  }
  return { ok: true, id: Number(info.lastInsertRowid) };
}

export async function closeCashRegister(db, id, { counted, notes, scope, nowIso } = {}) {
  if (!Number.isInteger(id) || id <= 0) return { error: "Arqueo no encontrado", status: 404 };
  const row = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(id);
  // Arqueo ajeno = mismo error que inexistente: 404, sin confirmar
  // que exista (igual que los pedidos).
  if (!row || (scope && row.branch !== scope)) {
    return { error: "Arqueo no encontrado", status: 404 };
  }
  if (row.closed_at) return { error: "Esta caja ya está cerrada", status: 400 };
  // Campo vacío no debe interpretarse como $0 (Number("") === 0)
  if (String(counted ?? "").trim() === "") {
    return { error: "Ingresá el monto contado", status: 400 };
  }
  const monto = Number(counted);
  if (!Number.isFinite(monto) || monto < 0) return { error: "Monto contado inválido", status: 400 };

  const expected = row.opening_amount + (await cashIncomeSince(db, row.branch, row.opened_at));
  const difference = Math.round(monto) - expected;

  await db.prepare(
    `UPDATE cash_registers
   SET closing_counted = ?, closed_at = ?, expected_amount = ?, difference = ?, notes = ?, updated_at = ?
   WHERE id = ?`
  ).run(Math.round(monto), nowIso, expected, difference, String(notes || "").slice(0, 500), nowIso, id);

  return { ok: true, expected, difference };
}

// ============================================================
// Menú para el panel de productos (antes inline en GET
// /api/admin/products). Devuelve las ROWS CRUDAS del SELECT con
// el scope aplicado: el agrupado por sucursal/categoría (la forma
// {branchId, categories} que consume el panel) queda en el
// endpoint, que ya lo hacía.
// ============================================================
export async function listMenuForAdmin(db, { scope } = {}) {
  const where = scope ? "WHERE p.branch = ?" : "";
  const params = scope ? [scope] : [];
  return db
    .prepare(
      `SELECT p.*, c.id AS _catRowId FROM products p
     LEFT JOIN categories c ON c.branch = p.branch AND c.category_id = p.category_id
     ${where}
     ORDER BY COALESCE(c.sort_order, 999999), p.sort_order`
    )
    .all(...params);
}

// Producto por id respetando el scope: ajeno → null (404 sin
// confirmar la existencia, igual que los pedidos).
export async function getScopedProduct(db, id, scope) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  if (!row) return null;
  if (scope && row.branch !== scope) return null;
  return row;
}

// Categoría por id con el mismo convenio.
export async function getScopedCategory(db, id, scope) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
  if (!row) return null;
  if (scope && row.branch !== scope) return null;
  return row;
}

// ============================================================
// Cupones del panel (antes inline en GET /api/admin/coupons).
//
// Con scope de branch_admin ve SOLO los cupones de su sucursal:
// ni los de la otra ni los globales (branch '', que crea el dueño
// y valen en ambas). El superadmin (scope null) sigue viendo todo.
//
// El used_count es POR FILA: el de un cupón local refleja solo los
// usos de su sucursal, sin cálculo extra en el endpoint.
// ============================================================
export async function listCoupons(db, { scope } = {}) {
  const where = scope ? "WHERE branch = ?" : "";
  const params = scope ? [scope] : [];
  return db.prepare(`SELECT * FROM coupons ${where} ORDER BY id DESC`).all(...params);
}

// Cupón por id respetando el scope: ajeno o global (para el
// branch_admin) → null (404 sin confirmar la existencia, igual que
// pedidos y productos).
export async function getScopedCoupon(db, id, scope) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await db.prepare("SELECT * FROM coupons WHERE id = ?").get(id);
  if (!row) return null;
  if (scope && row.branch !== scope) return null;
  return row;
}

// ¿Ya existe un cupón con ese código? La unicidad del código es
// GLOBAL (opción 2 del dueño): el chequeo NO mira la sucursal, y el
// endpoint que lo usa responde un error genérico ("Ese código ya está
// en uso") sin revelar en cuál está tomado. `excludeId` es para el
// PUT: editar sin cambiar el código no puede chocar consigo mismo.
export async function isCouponCodeTaken(db, code, { excludeId } = {}) {
  if (excludeId) {
    const row = await db
      .prepare("SELECT 1 FROM coupons WHERE code = ? AND id != ?")
      .get(code, excludeId);
    return !!row;
  }
  const row = await db.prepare("SELECT 1 FROM coupons WHERE code = ?").get(code);
  return !!row;
}

// ============================================================
// Estadísticas del panel (antes inline en GET /api/admin/stats).
//
// "Venta neta" = total de pedidos confirmados (payment_status
// approved y status != cancelled) menos lo devuelto; lo devuelto
// se atribuye por fecha del PEDIDO, el mismo criterio que la
// venta, para que los dos números cuadren.
//
// Con scope de branch_admin:
//   - la venta/devolución/ticket/pedidos/tops son SOLO de su
//     sucursal;
//   - el desglose por local (ventaTandil/ventaNecochea/…) no
//     tiene sentido y no se devuelve;
//   - los eventos (analytics) quedan SOLO para el superadmin
//     (decisión 3 del dueño): ni siquiera se consultan.
// ============================================================
export async function getStats(db, { fromIso, toIso, scope } = {}) {
  const branchCond = scope ? " AND branch = ?" : "";
  const branchArgs = scope ? [scope] : [];
  const confirmedSql = `SELECT branch, total FROM orders
     WHERE payment_status = 'approved' AND status != 'cancelled'
       AND created_at >= ? AND created_at <= ?${branchCond}`;
  const confirmedArgs = [fromIso, toIso, ...branchArgs];
  const itemsSql = `SELECT items FROM orders
     WHERE payment_status = 'approved' AND status != 'cancelled'
       AND created_at >= ? AND created_at <= ?${branchCond}`;
  // refundedQuery no filtra por payment_status: una devolución total
  // pasa a 'refunded' y sale de la venta, pero la plata devuelta
  // tiene que verse igual (ver server/reports.js).
  const rq = refundedQuery({ fromIso, toIso, branch: scope });

  const stmts = [
    { sql: confirmedSql, args: confirmedArgs },
    { sql: itemsSql, args: confirmedArgs },
    rq,
  ];
  if (!scope) {
    stmts.push(
      {
        sql: "SELECT type, COUNT(*) AS n FROM events WHERE created_at >= ? AND created_at <= ? GROUP BY type",
        args: [fromIso, toIso],
      },
      {
        sql: "SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE type = 'page_view' AND visitor_id IS NOT NULL AND created_at >= ? AND created_at <= ?",
        args: [fromIso, toIso],
      }
    );
  }
  const results = await db.batch(stmts, "read");
  const confirmed = results[0].rows;
  const confirmedItems = results[1].rows;

  let ventaBruta = 0;
  for (const o of confirmed) ventaBruta += o.total;
  const pedidos = confirmed.length;

  // Productos más vendidos (por cantidad) y que más facturan
  // (netos, en $), calculado a partir de los mismos pedidos
  // confirmados del período.
  const productAgg = new Map(); // name -> { name, qty, revenue }
  for (const row of confirmedItems) {
    let items;
    try { items = JSON.parse(row.items); } catch { items = []; }
    for (const it of items) {
      const extrasTotal = (it.extras || []).reduce((a, e) => a + (e.price || 0), 0);
      const lineRevenue = (it.unitPrice + extrasTotal) * it.qty;
      const key = it.name || it.productId;
      const entry = productAgg.get(key) || { name: key, qty: 0, revenue: 0 };
      entry.qty += it.qty;
      entry.revenue += lineRevenue;
      productAgg.set(key, entry);
    }
  }
  const allProducts = Array.from(productAgg.values());
  const topSelling = [...allProducts].sort((a, b) => b.qty - a.qty).slice(0, 8);
  const topRevenue = [...allProducts].sort((a, b) => b.revenue - a.revenue).slice(0, 8);

  if (scope) {
    const devuelto = sumRefunded(results[2].rows);
    const ventaNeta = netAmount(ventaBruta, devuelto);
    return {
      period: { from: fromIso, to: toIso },
      ventaBruta,
      ventaNeta,
      devuelto,
      ticketPromedio: pedidos > 0 ? Math.round(ventaNeta / pedidos) : 0,
      pedidos,
      topSelling,
      topRevenue,
    };
  }

  // Superadmin: consolidado + desglose por local + analytics.
  const eventRows = results[3].rows;
  const visitantes = Number((results[4].rows[0] || {}).n || 0);
  const devueltoPorLocal = refundedByBranch(results[2].rows);
  const devuelto = devueltoPorLocal.total;
  const devueltoTandil = devueltoPorLocal.byBranch.get("tandil") || 0;
  const devueltoNecochea = devueltoPorLocal.byBranch.get("necochea") || 0;

  let ventaNecocheaBruta = 0;
  let ventaTandilBruta = 0;
  for (const o of confirmed) {
    if (o.branch === "necochea") ventaNecocheaBruta += o.total;
    if (o.branch === "tandil") ventaTandilBruta += o.total;
  }
  // Lo que se muestra en el panel es la venta NETA (lo vendido menos
  // lo devuelto). Lo devuelto va aparte, y también por local.
  const ventaNeta = netAmount(ventaBruta, devuelto);
  const ventaTandil = netAmount(ventaTandilBruta, devueltoTandil);
  const ventaNecochea = netAmount(ventaNecocheaBruta, devueltoNecochea);
  const ticketPromedio = pedidos > 0 ? Math.round(ventaNeta / pedidos) : 0;

  // Conteo de eventos en el período
  const counts = { page_view: 0, product_view: 0, checkout_started: 0, order_created: 0 };
  for (const row of eventRows) {
    if (row.type in counts) counts[row.type] = row.n;
  }

  return {
    period: { from: fromIso, to: toIso },
    ventaBruta,
    ventaNeta,
    ventaTandil,
    ventaNecochea,
    ventaTandilBruta,
    ventaNecocheaBruta,
    devuelto,
    devueltoTandil,
    devueltoNecochea,
    ticketPromedio,
    pedidos,
    checkouts: counts.checkout_started || 0,
    productosVistos: counts.product_view || 0,
    visitas: visitantes,
    pageViews: counts.page_view || 0,
    conversion: visitantes > 0 ? Math.round((pedidos / visitantes) * 1000) / 10 : 0,
    topSelling,
    topRevenue,
  };
}
