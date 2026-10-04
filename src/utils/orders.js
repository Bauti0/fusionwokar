// ============================================================
// Utilidades de pedidos — combinación y deduplicación
// ============================================================

export const ACTIVE_STATUSES = new Set([
  "received",
  "preparing",
  "ready",
  "out_for_delivery",
  "pending_payment",
]);

export function isActiveOrder(order) {
  return Boolean(order?.status && ACTIVE_STATUSES.has(order.status));
}

export function sameDayWithinMinutes(a, b, minutes = 15) {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  return Math.abs(da - db) <= minutes * 60 * 1000;
}

/**
 * Combina pedidos del servidor (by-phone) con el historial local.
 * - Deduplica por orderNumber exacto.
 * - Registros locales sin orderNumber: si coinciden en total y fecha (±15 min)
 *   con un pedido del servidor, se descartan (no se duplican).
 * - Pedidos activos (no completed/cancelled) arriba, ordenados por fecha desc.
 * - Históricos abajo, ordenados por fecha desc.
 * - Devuelve array con items: { order, source: 'server'|'local', canRepeat, isActive }
 */
export function combineOrders(serverOrders, localHistory, currentBranchId) {
  const serverByNumber = new Map();
  for (const o of serverOrders) {
    if (o.orderNumber) serverByNumber.set(o.orderNumber, o);
  }

  const usedLocalIds = new Set();
  const combined = [];

  // 1) Pedidos del servidor (fuente principal)
  for (const so of serverOrders) {
    const localMatch = localHistory.find(
      (lo) =>
        lo.orderNumber === so.orderNumber ||
        (!lo.orderNumber &&
          lo.total === so.total &&
          sameDayWithinMinutes(lo.date, so.createdAt))
    );

    if (localMatch) usedLocalIds.add(localMatch.id);

    combined.push({
      order: so,
      source: "server",
      canRepeat:
        localMatch != null && localMatch.branch === currentBranchId,
      isActive: isActiveOrder(so),
    });
  }

  // 2) Historial local que NO coincidió con servidor
  for (const lo of localHistory) {
    if (usedLocalIds.has(lo.id)) continue;

    combined.push({
      order: lo,
      source: "local",
      canRepeat: lo.branch === currentBranchId,
      isActive: false, // locales viejos no tienen status confiable
    });
  }

  // 3) Ordenar: activos primero (fecha desc), luego históricos (fecha desc)
  combined.sort((a, b) => {
    if (a.isActive !== b.isActive) return b.isActive - a.isActive;
    const da = new Date(a.order.createdAt || a.order.date).getTime();
    const db = new Date(b.order.createdAt || b.order.date).getTime();
    return db - da;
  });

  return combined;
}

// ============================================================
// Clave de idempotencia del intento de pedido (clientRequestId)
// ============================================================
//
// POST /api/orders puede guardarse el pedido y perder la respuesta (red caída,
// deploy, 5xx del proxy). El cliente no sabe si quedó y la pantalla "No pudimos
// confirmar" le ofrece "Reintentar el pedido": ese reintento, sin más, creaba un
// SEGUNDO pedido y consumía un SEGUNDO uso de cupón.
//
// La clave resuelve eso: un UUID por intento que el server guarda con el pedido.
// Si vuelve la misma clave con el mismo contenido, el server devuelve el pedido
// que ya existe en vez de crear otro (ver server/order-idempotency.js).
//
// Dos reglas, y las dos son del frontend:
//
//  1. La clave se REUSA en cada reintento del mismo intento. Si el cliente la
//     generara de nuevo en cada click, el reintento sería un pedido distinto y
//     el mecanismo no serviría de nada.
//  2. La clave se ATA al contenido del intento: si el cliente cambia el carrito,
//     la sucursal, la modalidad, la dirección, el teléfono, el cupón o el
//     método de pago, ya NO es un reintento sino otro pedido, y tiene que llevar
//     clave nueva (o el server respondería 409). Por eso la clave no se guarda
//     sola sino junto con la firma de esos datos, y se reutiliza únicamente
//     mientras la firma no cambie.

// crypto.randomUUID() solo existe en CONTEXTO SEGURO (https o localhost). En
// http:// plano —probar la tienda desde la LAN, p. ej. http://192.168.x.x:5173—
// no está, y sin este fallback el checkout se rompe justo en el escenario de
// prueba. getRandomValues sí existe en todos los navegadores. El server valida
// el formato de la clave, así que el fallback tiene que armar un v4 de verdad.
export function newClientRequestId() {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // versión 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Firma del intento: lo que, si cambia, hace que el pedido sea OTRO pedido.
//
// Es la misma lista de datos que mira la huella del server (orderFingerprint en
// server/order-idempotency.js) más la sucursal: si las dos listas se corrieran,
// un cambio legítimo del cliente caería en el 409 del server. El texto libre
// (notes) queda afuera a propósito por el mismo motivo que allá: escribir "sin
// cebolla" no es otro pedido.
export function orderAttemptSignature({
  branch = "",
  items = [],
  orderMode = "",
  address = "",
  phone = "",
  couponCode = "",
  paymentMethod = "",
} = {}) {
  const lines = (Array.isArray(items) ? items : []).map((it) =>
    [
      String(it?.productId ?? ""),
      Number(it?.qty) || 0,
      Number(it?.unitPrice) || 0,
      (Array.isArray(it?.extras) ? it.extras : [])
        .map((e) => `${String(e?.id ?? "")}:${Number(e?.price) || 0}`)
        .sort()
        .join("|"),
    ].join("~")
  );
  lines.sort(); // el mismo carrito en otro orden es el mismo pedido
  return [
    String(branch ?? ""),
    String(orderMode ?? ""),
    String(paymentMethod ?? ""),
    String(couponCode ?? "").trim().toUpperCase(),
    String(address ?? "").trim().toLowerCase(),
    String(phone ?? "").replace(/\D/g, ""),
    lines.join(";"),
  ].join("|");
}

// Clave a mandar en este intento. `prev` es lo que quedó guardado del intento
// anterior ({ id, signature }) o null. Si la firma es la misma, se reusa la
// clave: es el mismo pedido y el server devuelve el que ya guardó. Si cambió
// cualquier cosa, sale una clave nueva porque es otro pedido.
export function clientRequestIdFor(prev, signature) {
  if (prev && prev.signature === signature && prev.id) return prev;
  return { signature, id: newClientRequestId() };
}

// ¿El server RECHAZÓ el pedido (4xx)? Entonces no se creó nada —la validación
// corre antes del INSERT y ningún 4xx lleva número de pedido— así que el
// próximo intento tiene que ser un pedido NUEVO y su clave se descarta.
//
// Con red caída, timeout o 5xx (status 0) pasa lo contrario: el server nunca
// respondió y puede que el pedido sí se haya guardado, así que la clave se
// conserva y el reintento recupera ese pedido en vez de duplicarlo. Es la misma
// regla que decideDirectOrderOutcome (src/utils/whatsapp.js) usa para decidir si
// abre WhatsApp.
export function isOrderRejected(err) {
  const status = Number(err?.status) || 0;
  return status >= 400 && status < 500;
}
