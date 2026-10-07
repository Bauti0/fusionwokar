// ============================================================
// FUSIÓN WOK — Lógica pura de edición de pedidos (admin)
// Separada para ser testeable contra SQLite en memoria
// sin importar db.js (que dispara migraciones contra Turso real).
// ============================================================

import { computeShipping } from "./shipping.js";

const VALID_PAYMENT_METHODS = ["mercadopago", "efectivo", "transferencia"];
const VALID_ORDER_MODES = ["delivery", "pickup"];

/**
 * Calcula el envío para pickup → delivery.
 * Si se proporciona manualShippingCost (>=0), lo usa.
 * Si no, llama a computeShipping (solo Tandil).
 * Devuelve { cost, blocks } o lanza error con .code.
 */
async function calculateShippingForPickupToDelivery(branch, address, manualShippingCost) {
  const addr = String(address || "").trim();
  if (!addr) {
    const err = new Error("Falta la dirección de entrega para delivery");
    err.code = "missing_address";
    err.status = 400;
    throw err;
  }

  if (typeof manualShippingCost === "number" && manualShippingCost >= 0) {
    const cost = Math.round(manualShippingCost);
    let blocks = 0;
    if (branch === "tandil" && cost > 0) {
      const base = Number(process.env.SHIPPING_BASE_COST || 4000);
      const perBlock = Number(process.env.SHIPPING_PER_BLOCK || 100);
      const flat = Number(process.env.SHIPPING_FLAT_BLOCKS || 20);
      blocks = cost <= base ? flat : flat + Math.ceil((cost - base) / perBlock);
    }
    return { cost, blocks };
  }

  // computeShipping automático (solo Tandil implementado)
  if (branch === "tandil") {
    try {
      const ship = await computeShipping(branch, addr);
      return { cost: ship.cost, blocks: ship.blocks };
    } catch (err) {
      if (err.code === "zone" || err.code === "unknown") {
        throw err; // 400 definitivo
      }
      // transient u otro: exigir manual
      const e = new Error("No se pudo calcular el envío automático. Ingresá el costo manual (shippingCost).");
      e.code = "shipping_unavailable";
      e.status = 400;
      throw e;
    }
  }

  // Necochea u otra sin computeShipping: exige manual
  const e = new Error("Envío automático no disponible para esta sucursal. Ingresá shippingCost manual.");
  e.code = "shipping_unavailable";
  e.status = 400;
  throw e;
}

/**
 * Lógica pura de edición de pedido.
 * No toca la BD; devuelve los cambios a aplicar y las entradas de auditoría.
 * El caller (endpoint) ejecuta la transacción.
 *
 * @param {Object} row - Fila del pedido (de orders)
 * @param {Object} changes - { orderMode?, paymentMethod?, address?, shippingCost? }
 * @param {Object} admin - { role, branch, userId?, username? }
 * @param {Function} nowIso - fn que devuelve ISO string (para testabilidad)
 * @returns {Object} { changes: { field: value }, auditEntries: [], errors: [] }
 */
export async function computeOrderEdits(row, changes, admin, nowIso) {
  const { orderMode, paymentMethod, address, shippingCost: manualShippingCost } = changes || {};

  // shippingCost presente pero inválido (negativo, string, NaN) → 400.
  // Un costo de envío silenciosamente ignorado es peor que un error claro.
  if (
    manualShippingCost !== undefined &&
    (typeof manualShippingCost !== "number" || !Number.isFinite(manualShippingCost) || manualShippingCost < 0)
  ) {
    return { error: { status: 400, message: "shippingCost debe ser un número mayor o igual a 0" } };
  }

  // Validaciones base
  if (row.status === "cancelled") {
    return { error: { status: 400, message: "No se puede editar un pedido cancelado" } };
  }

  const isMpApproved = row.payment_method === "mercadopago" && row.payment_status === "approved";
  if (isMpApproved) {
    return {
      error: {
        status: 400,
        message: "Este pedido se pagó online con MercadoPago, ajustalo desde MercadoPago",
      },
    };
  }

  // Valores originales
  const orig = {
    total: Number(row.total),
    shipping: Number(row.shipping) || 0,
    shippingKm: Number(row.shipping_km) || 0,
    address: row.address || "",
    orderMode: row.order_mode,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    status: row.status,
  };

  // Valores nuevos (empiezan igual)
  let newTotal = orig.total;
  let newShipping = orig.shipping;
  let newShippingKm = orig.shippingKm;
  let newAddress = orig.address;
  let newOrderMode = orig.orderMode;
  let newPaymentMethod = orig.paymentMethod;
  let newPaymentStatus = orig.paymentStatus;
  let newStatus = orig.status;

  const auditEntries = [];
  // Al tocar el envío (cambio de modalidad u override manual) se limpia
  // shipping_pending: el costo ya no está pendiente de cálculo.
  let clearShippingPending = false;

  const addAudit = (field, oldVal, newVal, oldTotalVal, newTotalVal) => {
    if (String(oldVal) === String(newVal)) return;
    auditEntries.push({
      order_id: row.id,
      admin_user_id: admin?.userId ?? null,
      admin_username: admin?.username ?? (admin?.role === "superadmin" ? "superadmin" : "unknown"),
      admin_role: admin?.role ?? "unknown",
      admin_branch: admin?.branch ?? "",
      field,
      old_value: oldVal == null ? null : String(oldVal),
      new_value: newVal == null ? null : String(newVal),
      old_total: oldTotalVal,
      new_total: newTotalVal,
      created_at: nowIso(),
    });
  };

  // --- orderMode ---
  if (orderMode && orderMode !== orig.orderMode) {
    if (!VALID_ORDER_MODES.includes(orderMode)) {
      return { error: { status: 400, message: "Modalidad inválida" } };
    }
    const oldMode = orig.orderMode;
    const oldShip = orig.shipping;
    const oldAddr = orig.address;
    clearShippingPending = true;

    if (orderMode === "pickup" && orig.orderMode === "delivery") {
      // delivery -> pickup: resta envío guardado, limpia address y shipping
      newOrderMode = "pickup";
      newTotal = Math.max(0, newTotal - oldShip);
      newShipping = 0;
      newShippingKm = 0;
      newAddress = "";
      addAudit("orderMode", oldMode, newOrderMode, orig.total, newTotal);
      addAudit("address", oldAddr, "", orig.total, newTotal);
      addAudit("shipping", oldShip, 0, orig.total, newTotal);
    } else if (orderMode === "delivery" && orig.orderMode === "pickup") {
      // pickup -> delivery: requiere address, calcula envío.
      // Los errores (dirección faltante, zona, sin cálculo) vuelven como
      // { error } y NO se propagan: si se propagaran, el catch general del
      // endpoint respondería 500 en vez de 400 con el mensaje claro.
      let ship;
      try {
        ship = await calculateShippingForPickupToDelivery(row.branch, address, manualShippingCost);
      } catch (err) {
        return { error: { status: err.status || 400, message: err.message } };
      }
      newOrderMode = "delivery";
      newAddress = String(address || "").trim().slice(0, 200);
      newShipping = ship.cost;
      newShippingKm = ship.blocks;
      newTotal = newTotal + ship.cost;
      addAudit("orderMode", oldMode, newOrderMode, orig.total, newTotal);
      addAudit("address", oldAddr, newAddress, orig.total, newTotal);
      addAudit("shipping", 0, newShipping, orig.total, newTotal);
    }
  }

  // --- paymentMethod ---
  if (paymentMethod && paymentMethod !== orig.paymentMethod) {
    if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
      return { error: { status: 400, message: "Método de pago inválido" } };
    }

    const oldMethod = orig.paymentMethod;

    // Bloquear cambio A mercadopago desde el panel
    if (paymentMethod === "mercadopago") {
      return {
        error: {
          status: 400,
          message: "No se puede cambiar a MercadoPago desde el panel",
        },
      };
    }

    newPaymentMethod = paymentMethod;

    // Cambio A efectivo/transferencia:
    // - Solo cambia payment_status si estaba "pending" (MP pendiente)
    // - Solo cambia status si estaba "pending_payment"
    // - En pedidos ya avanzados (preparing, ready, etc.) NO tocar status
    if (["efectivo", "transferencia"].includes(paymentMethod)) {
      newPaymentStatus = "approved";
      if (orig.status === "pending_payment") {
        newStatus = "received";
      }
    }
    // NOTA: El cambio desde mercadopago (pending) -> efectivo/transferencia
    // deja el mp_order_id en la BD. shouldReconcile ya no lo tocará porque
    // filtra por payment_method === "mercadopago". La order de MP expirará
    // sola (24h) o el cliente no podrá pagarla porque el medio cambió.

    addAudit("paymentMethod", oldMethod, newPaymentMethod, orig.total, newTotal);
  }

  // --- address (solo si delivery y no se cambió orderMode ya) ---
  if (address !== undefined && address !== orig.address && !orderMode) {
    if (orig.orderMode !== "delivery") {
      return { error: { status: 400, message: "La dirección solo aplica en pedidos delivery" } };
    }
    const addr = String(address || "").trim();
    if (!addr) {
      return { error: { status: 400, message: "La dirección no puede estar vacía en delivery" } };
    }
    newAddress = addr.slice(0, 200);
    addAudit("address", orig.address, newAddress, orig.total, newTotal);
  }

  // --- shippingCost manual (override en delivery, sin cambiar orderMode) ---
  // La validación de forma (negativo/no numérico) ya se hizo arriba.
  if (manualShippingCost !== undefined && !orderMode) {
    if (orig.orderMode !== "delivery") {
      return { error: { status: 400, message: "El costo de envío manual solo aplica en pedidos delivery" } };
    }
  }
  if (
    manualShippingCost !== undefined &&
    typeof manualShippingCost === "number" &&
    manualShippingCost >= 0 &&
    orig.orderMode === "delivery" &&
    !orderMode
  ) {
    const oldShip = orig.shipping;
    const delta = Math.round(manualShippingCost) - oldShip;
    newShipping = Math.round(manualShippingCost);
    newTotal = Math.max(0, newTotal + delta);
    if (row.branch === "tandil" && newShipping > 0) {
      const base = Number(process.env.SHIPPING_BASE_COST || 4000);
      const perBlock = Number(process.env.SHIPPING_PER_BLOCK || 100);
      const flat = Number(process.env.SHIPPING_FLAT_BLOCKS || 20);
      newShippingKm = newShipping <= base ? flat : flat + Math.ceil((newShipping - base) / perBlock);
    } else {
      newShippingKm = 0;
    }
    addAudit("shipping", oldShip, newShipping, orig.total, newTotal);
    clearShippingPending = true;
  }

  // Construir SET clauses para UPDATE
  const sets = [];
  const values = [];

  if (newOrderMode !== orig.orderMode) { sets.push("order_mode = ?"); values.push(newOrderMode); }
  if (newAddress !== orig.address) { sets.push("address = ?"); values.push(newAddress); }
  if (newShipping !== orig.shipping) { sets.push("shipping = ?"); values.push(newShipping); }
  if (newShippingKm !== orig.shippingKm) { sets.push("shipping_km = ?"); values.push(newShippingKm); }
  if (clearShippingPending && Number(row.shipping_pending)) { sets.push("shipping_pending = 0"); }
  if (newTotal !== orig.total) { sets.push("total = ?"); values.push(newTotal); }
  if (newPaymentMethod !== orig.paymentMethod) { sets.push("payment_method = ?"); values.push(newPaymentMethod); }
  if (newPaymentStatus !== orig.paymentStatus) { sets.push("payment_status = ?"); values.push(newPaymentStatus); }
  if (newStatus !== orig.status) { sets.push("status = ?"); values.push(newStatus); }

  // No-op
  if (sets.length === 0) {
    return { noop: true, order: row };
  }

  values.push(nowIso(), row.id);

  return {
    sql: `UPDATE orders SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`,
    values,
    auditEntries,
    newValues: {
      total: newTotal,
      shipping: newShipping,
      shippingKm: newShippingKm,
      address: newAddress,
      orderMode: newOrderMode,
      paymentMethod: newPaymentMethod,
      paymentStatus: newPaymentStatus,
      status: newStatus,
    },
  };
}

// ============================================================
// Escritura del resultado: UN solo batch atómico.
//
// Antes eran db.exec("BEGIN") / COMMIT / ROLLBACK sueltos, y eso no es
// transacción de verdad: cada db.exec() corre sobre executeMultiple(), que
// abre una conexión lógica NUEVA por llamada (documentado en @libsql/core
// api.d.ts) y libera la conexión haciendo rollback. O sea: el BEGIN moría al
// terminar su llamada, el UPDATE corría en autocommit y el ROLLBACK del
// catch fallía con "cannot rollback - no transaction is active", tapando el
// error original (bug en producción: 500 con los datos ya aplicados).
//
// db.batch(stmts, "write") envuelve todas las sentencias en UNA transacción
// y las revierte todas si una falla — es el mismo mecanismo que usa el resto
// del repo (creación de pedido, idempotencia, caja).
// ============================================================
const AUDIT_INSERT_SQL = `
  INSERT INTO order_audit_log
    (order_id, admin_user_id, admin_username, admin_role, admin_branch, field, old_value, new_value, old_total, new_total, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export async function applyOrderEdit(db, result) {
  const stmts = [{ sql: result.sql, args: result.values }];
  for (const a of result.auditEntries) {
    stmts.push({
      sql: AUDIT_INSERT_SQL,
      args: [
        a.order_id,
        a.admin_user_id,
        a.admin_username,
        a.admin_role,
        a.admin_branch,
        a.field,
        a.old_value,
        a.new_value,
        a.old_total,
        a.new_total,
        a.created_at,
      ],
    });
  }
  await db.batch(stmts, "write");
}

// ============================================================
// Lectura de la auditoría de un pedido.
// La decisión de permiso vive acá (y no solo en el endpoint) para que
// se pueda testear contra SQLite en memoria: un branch_admin recibe
// 403 aunque llame al endpoint directamente. El superadmin (del .env,
// admin_user_id NULL) ve los pedidos de TODAS las sucursales.
// ============================================================
export async function getAuditLogs(db, admin, orderId) {
  // Solo el superadmin lee la auditoría: 403 para branch_admin, aunque
  // el pedido sea de su propia sucursal.
  if (admin?.role !== "superadmin") {
    return { error: { status: 403, message: "Solo el administrador principal puede ver la auditoría" } };
  }
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return { error: { status: 400, message: "ID inválido" } };
  }
  const row = await db.prepare("SELECT id FROM orders WHERE id = ?").get(orderId);
  if (!row) return { error: { status: 404, message: "Pedido no encontrado" } };
  const logs = await db
    .prepare(
      `SELECT id, field, old_value, new_value, old_total, new_total,
              admin_user_id, admin_username, admin_role, admin_branch, created_at
       FROM order_audit_log WHERE order_id = ? ORDER BY created_at DESC, id DESC`
    )
    .all(orderId);
  return { logs };
}