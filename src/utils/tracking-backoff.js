// ============================================================
// Tracking público — backoff exponencial (función pura, testeable)
// ============================================================
// Exportada para que TrackOrder.jsx y test/tracking-poll-rate-limit.test.js
// compartan EXACTAMENTE la misma lógica. Sin dependencias de React ni DOM.
//
// Reglas:
// - baseInterval: intervalo base (TRACK_POLL_INTERVAL_MS = 10000)
// - consecutiveErrors: contador de errores consecutivos (0 en éxito)
// - maxInterval: tope (60000 ms = 60s)
// - Fórmula: min(baseInterval * 2^consecutiveErrors, maxInterval)
//
// NOTA: NO se implementa Retry-After (el server no lo manda y ApiError
// no expone headers). El backoff exponencial con tope de 60s es suficiente.
export function computeBackoffInterval(baseInterval, consecutiveErrors, maxInterval = 60000) {
  if (consecutiveErrors <= 0) return baseInterval;
  const next = baseInterval * Math.pow(2, consecutiveErrors);
  return Math.min(next, maxInterval);
}