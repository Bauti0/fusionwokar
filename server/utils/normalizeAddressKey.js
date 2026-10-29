// ============================================================
// Normalización de claves de caché para direcciones (copia server-side).
// Duplicada de src/utils/normalizeAddressKey.js para no crear dependencia
// del backend hacia el frontend. Test en test/normalize-address-key.test.js
// verifica que ambas versiones dan el mismo resultado.
// ============================================================

/**
 * Normaliza una dirección para usarla como clave de caché.
 * - minúsculas
 * - quita tildes/diacríticos (NFD + quitar marcas combinatorias)
 * - colapsa espacios múltiples en uno
 * - trim
 * NO expande abreviaturas ("Av." sigue siendo "av.").
 */
export function normalizeAddressKey(address) {
  if (typeof address !== "string") return "";
  return address
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // quita tildes y diacríticos
    .replace(/\s+/g, " ")   // colapsa espacios
    .trim();
}

export default { normalizeAddressKey };