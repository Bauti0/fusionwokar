import { parseRefunds, refundableAmount } from "./refunds.js";

// ============================================================
// Proyecciones de la fila `orders` al formato público de la API.
// Son funciones PURAS: viven aparte de db.js para que los tests
// las importen sin disparar las migraciones contra Turso (db.js
// corre DDL apenas se carga el módulo).
// ============================================================

// Convierte una fila de la BD en el objeto público del pedido
export function toPublicOrder(row) {
  if (!row) return null;
  const refundedAmount = row.refunded_amount || 0;
  return {
    id: row.id,
    orderNumber: row.order_number,
    branch: row.branch,
    // El email se expone SOLO acá (panel admin). toPublicOrderPublic, que
    // alimenta los endpoints públicos de tracking, no lo incluye.
    customer: {
      name: row.customer_name,
      phone: row.customer_phone,
      email: row.customer_email || "",
      firstName: row.customer_first_name || "",
      lastName: row.customer_last_name || "",
    },
    address: row.address,
    orderMode: row.order_mode,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    status: row.status,
    items: JSON.parse(row.items),
    total: row.total,
    discount: row.discount || 0,
    couponCode: row.coupon_code || "",
    shippingCost: row.shipping || 0,
    shippingBlocks: row.shipping_km || 0,
    shipping: {
      cost: row.shipping || 0,
      blocks: row.shipping_km || 0,
      pending: !!row.shipping_pending,
    },
    scheduledFor: row.scheduled_for || "",
    notes: row.notes,
    source: row.source || "web",
    mpOrderId: row.mp_order_id || "",
    mpPaymentId: row.mp_payment_id,
    refundedAmount,
    refundableAmount: refundableAmount(row),
    refunds: parseRefunds(row.refunds_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Proyección SIN datos personales para endpoints públicos
// (tracking y polling). No expone nombre, teléfono, dirección ni notas.
export function toPublicOrderPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderNumber: row.order_number,
    branch: row.branch,
    orderMode: row.order_mode,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    status: row.status,
    // Ítems SIN la nota libre del cliente: como este endpoint es público y los
    // id/número de pedido son correlativos, las notas no deben exponerse a
    // terceros que conozcan el número de un pedido ajeno.
    items: (JSON.parse(row.items) || []).map(({ notes, ...item }) => item),
    total: row.total,
    discount: row.discount || 0,
    shippingCost: row.shipping || 0,
    shippingBlocks: row.shipping_km || 0,
    shipping: {
      cost: row.shipping || 0,
      blocks: row.shipping_km || 0,
      pending: !!row.shipping_pending,
    },
    scheduledFor: row.scheduled_for || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
