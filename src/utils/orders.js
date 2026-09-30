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