// ============================================================
// Normalización de claves de caché para direcciones.
// Usada por server/shipping.js y src/components/Checkout.jsx
// SOLO para la clave del caché; la query al geocodificador NO cambia.
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