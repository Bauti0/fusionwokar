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
    seenAt: row.seen_at || null,
  };
}

// Proyección SIN datos personales para endpoints públicos
// (tracking y polling). No expone nombre, teléfono, dirección, notas ni sucursal.
export function toPublicOrderPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderNumber: row.order_number,
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

// Proyección EXTENDIDA para panel admin: incluye seenAt (no va al cliente).
export function toAdminOrder(row) {
  const base = toPublicOrder(row);
  if (!base) return null;
  return {
    ...base,
    seenAt: row.seen_at || null,
  };
}

// ============================================================
// Utilidades puras para verificación de teléfono (testing sin DB)
// ============================================================

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

// Respuesta genérica SIEMPRE igual para cualquier fallo
export const GENERIC_FAILURE_RESPONSE = { address: "" };
export const GENERIC_FAILURE_STATUS = 200;

// Verifica si el orderNumber tiene formato válido
export function isValidOrderNumberFormat(num) {
  return /^FW-\d{4,10}$/.test(String(num || "").trim().toUpperCase());
}

// Lógica de decisión pura: dado row e inputPhone, decide la respuesta
// No toca BD, no loguea, no usa rate limit.
export function decideVerifiedDeliveryResponse(row, phoneInput) {
  const inputPhone = normalizePhone(phoneInput);
  // Formato inválido → fallo genérico
  if (!isValidPhone(phoneInput)) return GENERIC_FAILURE_RESPONSE;
  // Sin row (no existe) → fallo genérico
  if (!row) return GENERIC_FAILURE_RESPONSE;
  // No es delivery → fallo genérico
  if (row.order_mode !== "delivery") return GENERIC_FAILURE_RESPONSE;
  const storedPhone = normalizePhone(row.customer_phone);
  // Pedido sin teléfono en BD → fallo genérico
  if (!storedPhone) return GENERIC_FAILURE_RESPONSE;
  // Input vacío → fallo genérico
  if (!inputPhone) return GENERIC_FAILURE_RESPONSE;
  // Mismatch → fallo genérico
  if (storedPhone !== inputPhone) return GENERIC_FAILURE_RESPONSE;
  // Éxito: devuelve dirección (puede ser "" si delivery sin dirección)
  const address = row.address || "";
  return { address };
}

// Re-export isValidPhone para tests (desde validation.js no se puede importar en tests sin db)
export function isValidPhone(value) {
  const v = String(value || "").trim();
  if (!/^\+?[0-9\s()-]+$/.test(v)) return false;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15;
}

// ============================================================
// Rate limiter por pedido: cuenta SOLO fallos, resetea en acierto
// ============================================================
const orderDetailsBuckets = new Map();

export function checkOrderRateLimit(orderNumber) {
  const key = `order:${String(orderNumber || "").trim().toUpperCase()}`;
  const now = Date.now();
  const bucket = orderDetailsBuckets.get(key);
  if (!bucket || bucket.reset < now) {
    orderDetailsBuckets.set(key, { failures: 0, reset: now + 15 * 60 * 1000 });
    return { allowed: true, bucket: orderDetailsBuckets.get(key) };
  }
  if (bucket.failures >= 5) {
    return { allowed: false, bucket };
  }
  return { allowed: true, bucket };
}

export function recordOrderFailure(orderNumber) {
  const key = `order:${String(orderNumber || "").trim().toUpperCase()}`;
  const now = Date.now();
  let bucket = orderDetailsBuckets.get(key);
  if (!bucket || bucket.reset < now) {
    bucket = { failures: 0, reset: now + 15 * 60 * 1000 };
    orderDetailsBuckets.set(key, bucket);
  }
  bucket.failures += 1;
}

export function recordOrderSuccess(orderNumber) {
  const key = `order:${String(orderNumber || "").trim().toUpperCase()}`;
  orderDetailsBuckets.delete(key); // reset completo en acierto
}

// Función para tests: inspeccionar estado del bucket
export function _getOrderBucketForTest(orderNumber) {
  const key = `order:${String(orderNumber || "").trim().toUpperCase()}`;
  return orderDetailsBuckets.get(key) || null;
}

// Función para tests: limpiar buckets
export function _clearOrderBucketsForTest() {
  orderDetailsBuckets.clear();
}


