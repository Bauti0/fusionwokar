// ============================================================
// Funciones puras para el checkout (testables sin React/DOM)
// ============================================================

/**
 * Devuelve el label del total según el estado del envío.
 * Regresión: cuando el envío no está calculado (Tandil, efectivo/transferencia)
 * el label debe ser "Total estimado" + "envío a confirmar", no "Total (N items)".
 */
export function getTotalLabel({ count, shippingUnavailable, isMp }) {
  if (shippingUnavailable && !isMp) {
    return { main: `Total estimado (${count} items)`, sub: "envío a confirmar" };
  }
  return { main: `Total (${count} items)`, sub: null };
}

/**
 * Determina si el botón de envío principal debe estar deshabilitado.
 * Regresión: el botón se deshabilita en los mismos casos que antes:
 * - busy (enviando)
 * - retryingLink (reintentando link de pago)
 * - paused (sucursal pausada)
 * - orderId sin canRetry (pedido guardado sin pago reintentable)
 */
export function isSubmitDisabled({ busy, retryingLink, paused, serverError }) {
  return busy || retryingLink || paused || (!!serverError?.orderId && !serverError.canRetry);
}