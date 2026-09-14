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
