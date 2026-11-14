// ============================================================
// FUSIÓN WOK — Texto de envío de la tienda (única fuente de verdad)
// ============================================================
// Arma el texto que ve el cliente a partir de la configuración de envío
// de la sucursal (endpoint público /api/shipping-config/:branch).
// Tanto el menú como el checkout usan ESTA función, para que nunca se
// contradigan entre sí.
// ============================================================
import { formatPriceCompact } from "./format.js";

// Valores actuales del código (los de .env / código de hoy), usados como
// respaldo mientras la configuración pública carga o si falla.
export const DEFAULT_SHIPPING_CONFIG = {
  auto_enabled: 1,
  base_cost: 4000,
  flat_blocks: 20,
  per_block: 100,
  max_blocks: 0,
};

export function buildShippingText(cfg) {
  const c = { ...DEFAULT_SHIPPING_CONFIG, ...cfg };
  // Cálculo automático apagado: el local coordina el envío por WhatsApp.
  if (c.auto_enabled === 0) return "El envío se coordina por WhatsApp";
  return `Envío: ${formatPriceCompact(c.base_cost)} hasta ${c.flat_blocks} cuadras a la redonda · +${formatPriceCompact(c.per_block)} por cuadra extra`;
}
