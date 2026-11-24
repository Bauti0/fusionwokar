// ============================================================
// FUSIÓN WOK — Utilidades de teléfono compartidas
// Usadas tanto por el servidor (admin-queries) como por el cliente (AdminNewOrder)
// ============================================================

/**
 * Normaliza un teléfono a solo dígitos y devuelve los últimos 10 dígitos
 * (formato usado en BD y API). Elimina espacios, guiones, paréntesis, +54, 0 inicial, 15.
 * @param {string} phone - Teléfono en cualquier formato
 * @returns {string} - Últimos 10 dígitos normalizados
 */
export function normalizePhone(phone) {
  if (!phone) return "";
  let digits = phone.replace(/\D/g, "");
  // Quitar código de país +54 si está al inicio
  if (digits.startsWith("54")) digits = digits.slice(2);
  // Quitar 0 o 15 inicial (código de área nacional / móvil)
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (digits.startsWith("15")) digits = digits.slice(2);
  // Tomar últimos 10 dígitos (código de área + número)
  if (digits.length > 10) digits = digits.slice(-10);
  return digits;
}