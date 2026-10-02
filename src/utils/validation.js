// ============================================================
// Validaciones de formulario compartidas
// ============================================================

// Teléfono: acepta "+" inicial, dígitos, espacios, guiones y paréntesis.
// Exige entre 8 y 15 dígitos: cubre celulares argentinos con o sin
// código de área (ej: 2262 555555 / +54 9 2262 555555 / 02262-55-5555).
export function isValidPhone(value) {
  const v = String(value || "").trim();
  if (!/^\+?[0-9\s()-]+$/.test(v)) return false;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15;
}

// Email del cliente: se manda a Mercado Pago como payer.email, que la doc
// de Orders exige dentro de payer. Formato pragmático (algo@algo.tld): la
// API de MP no valida más que eso, y el límite de 100 caracteres es el que
// documenta para el campo. La normalización (trim + minúsculas) la hace
// el server ANTES de llamarla, igual que con el teléfono.
export function isValidEmail(value) {
  const v = String(value || "").trim();
  if (v.length === 0 || v.length > 100) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
