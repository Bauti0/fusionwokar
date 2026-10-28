// ============================================================
// Mensajes de error para el checkout (función pura, testeable)
// ============================================================

/**
 * Traduce el fallo de POST /api/orders a lo que ve el cliente.
 *
 * Antes se decidía con `err.contactWhatsApp ? "No pudimos calcular el envío…"`
 * sobre un flag que el backend encendía para DOS fallos distintos: no se pudo
 * cotizar el envío y no se pudo generar el link de pago. Con un token de
 * Mercado Pago inválido, el cliente veía "No pudimos calcular el envío" ante un
 * fallo de pago. Ahora cada `code` del servidor tiene su mensaje.
 *
 * `retryable` viene del server: con credenciales inválidas reintentar no sirve
 * nunca (solo WhatsApp), con una caída de MP sí.
 */
export function describeOrderError(err) {
  switch (err.code) {
    case "shipping_unavailable":
      return {
        message: err.message,
        canRetry: true,
        note: "Para cobrar con Mercado Pago necesitamos saber el costo de envío.",
      };
    case "mp_unauthorized":
      return {
        message:
          "El pago con Mercado Pago no está disponible en este momento. Tu pedido quedó " +
          "registrado: escribinos por WhatsApp con el número y lo coordinamos.",
        canRetry: false,
        note: "No hace falta que reintentes: el problema es de nuestro lado, no tuyo.",
      };
    case "mp_unavailable":
    case "mp_link_missing":
      return {
        message:
          "No pudimos generar el link de pago de Mercado Pago. Podés reintentar en un " +
          "momento o escribirnos por WhatsApp con el número de tu pedido.",
        canRetry: true,
      };
    case "orders_paused":
      // 423: la sucursal está pausada por el local. El pedido NO se creó.
      // El mensaje del server ya incluye hasta cuándo y mensaje opcional.
      // `canRetry: false` porque reintentar sin que el local reabra no sirve.
      // La salida es volver al menú y esperar (el checkout muestra pauseNotice).
      return {
        message: err.message,
        canRetry: false,
        note: "La sucursal está pausada. Podés volver al menú e intentar más tarde.",
      };
    default:
      return { message: err.message || "No se pudo iniciar el pago.", canRetry: true };
  }
}