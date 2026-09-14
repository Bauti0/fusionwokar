// ============================================================
// FUSIÓN WOK — Constantes de estados y etiquetas compartidas
// ============================================================

// Estados del pedido (orden de preparación)
export const ORDER_STATUSES = [
  { id: "received", label: "Pedido recibido", emoji: "📥" },
  { id: "preparing", label: "En elaboración", emoji: "👨‍🍳" },
  { id: "ready", label: "Listo", emoji: "✅" },
  { id: "out_for_delivery", label: "En camino", emoji: "🛵" },
  { id: "completed", label: "Entregado", emoji: "🍜" },
];

export const STATUS_CANCELLED = { id: "cancelled", label: "Cancelado", emoji: "❌" };
export const STATUS_PENDING_PAYMENT = { id: "pending_payment", label: "Esperando pago", emoji: "⏳" };

export function statusLabel(id) {
  const found = [...ORDER_STATUSES, STATUS_CANCELLED, STATUS_PENDING_PAYMENT].find((s) => s.id === id);
  return found ? found.label : id;
}

export function statusEmoji(id) {
  const found = [...ORDER_STATUSES, STATUS_CANCELLED, STATUS_PENDING_PAYMENT].find((s) => s.id === id);
  return found ? found.emoji : "📦";
}

// Estados de pago
export const PAYMENT_LABELS = {
  approved: "Pagado",
  pending: "Pago pendiente",
  rejected: "Pago rechazado",
};

export function paymentLabel(id) {
  return PAYMENT_LABELS[id] || id;
}

// Índice de un estado dentro del flujo (para la barra de progreso)
export function statusIndex(id) {
  return ORDER_STATUSES.findIndex((s) => s.id === id);
}