// ============================================================
// Decisión pura: ¿se cachea en el navegador el resultado de una
// cotización de envío (incluido su error)?
//
// El checkout la consulta con un debounce de 1,5 s y la cachea 10 min por
// dirección. Qué se cachea importa:
//
//   - Un fallo TRANSITORIO cacheado deja al cliente sin envío calculado durante
//     10 minutos por un saturón de 3 segundos, y lo manda a "envío a
//     confirmar" (o le bloquea el pago con Mercado Pago).
//   - Un fallo DEFINITIVO cacheado no cuesta nada: no lo encontramos o queda
//     fuera de la zona de reparto, y reconsultar da exactamente lo mismo.
//
// La decisión se toma por el CÓDIGO del error (el `code` del ApiError de
// src/api.js, que sale del body de POST /api/shipping/quote, ver
// server/index.js) y por su status HTTP. NUNCA por el texto del mensaje: los
// mensajes están en español y se reescriben con cada ajuste de redacción, así
// que un regex sobre ellos se queda viejo en silencio (un día cachea un
// saturón, otro día no cachea un timeout) sin que nadie se entere.
//
// Tests: test/shipping-cache.test.js
// ============================================================

// Códigos que implican "no lo vamos a encontrar nunca": se cachean.
const DEFINITIVOS = new Set(["unknown", "zone"]);

export function shouldCacheQuoteError(err = null) {
  if (!err) return true; // éxito: la cotización sí se cachea

  const code = String(err.code || "");
  if (DEFINITIVOS.has(code)) return true;
  if (code === "transient") return false;

  // Sin código de negocio no hay decisión del backend que respetar: es un fallo
  // de transporte o del servidor, y todos son reintentables.
  //   status 0  → la petición ni siquiera llegó (sin internet, timeout/abort del
  //                fetch: ni siquiera hay un ApiError con status).
  //   408/429   → timeout del server o cuota/rate limit.
  //   5xx       → el server no pudo responder.
  const status = Number(err.status || 0);
  if (status === 0 || status === 408 || status === 429 || status >= 500) return false;

  // 4xx con un código que no conocemos: no es un fallo de transporte, el
  // server lo rechazó y pedirlo de nuevo no cambia la respuesta.
  return true;
}

export default { shouldCacheQuoteError };
