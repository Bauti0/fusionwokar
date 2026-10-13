// ============================================================
// Lógica pura de la alarma de pedidos nuevos del panel admin.
// Sin DOM, sin AudioContext, sin React: vive acá para poder
// testearse con pedidos reales (toPublicOrder sobre filas de
// createDb). El sonido en sí está en notifySound.js.
// ============================================================

// Estados que cuentan como "en curso" (todavía no se entregó ni se canceló).
// Mismo criterio que tenía AdminPanel.jsx antes de extraerse: NO es el
// isActiveOrder de utils/orders.js (ese incluye pending_payment y no mira
// el pago); acá manda este.
export const ACTIVE_STATUS_IDS = new Set(["received", "preparing", "ready", "out_for_delivery"]);

// Un pedido programado para más adelante (con +1h de holgura) no cuenta como
// "en curso" ni dispara el aviso sonoro hasta que llegue su momento.
export function isFutureScheduled(o) {
  if (!o?.scheduledFor) return false;
  const t = new Date(o.scheduledFor).getTime();
  return !Number.isNaN(t) && t > Date.now() + 60 * 60000;
}

export function isActiveOrder(o) {
  return ACTIVE_STATUS_IDS.has(o.status) && o.paymentStatus !== "rejected" && !isFutureScheduled(o);
}

// IDs de pedidos que están en la lista, siguen activos y nadie vio todavía.
// Es la misma lista que alimenta el badge de "no vistos" de la barra.
export function unseenActiveIds(orders, seen) {
  return (orders || []).filter(isActiveOrder).map((o) => o.id).filter((id) => !seen.has(id));
}

// ¿Tiene que estar sonando la alarma? True solo si queda AL MENOS UN pedido
// activo sin ver en la lista (si el pedido desaparece o cambia de estado,
// deja de contar y la alarma se corta).
export function shouldAlarm(orders, seen) {
  return unseenActiveIds(orders, seen).length > 0;
}
