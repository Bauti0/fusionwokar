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

// Tipos de identificación que devuelve GET /v1/identification_types de MP
// para Argentina (consultado con credenciales de prueba el 2026-10-02).
// El valor es [min, max] de DÍGITOS que acepta cada tipo. El id "Otro"
// llega tal cual de la API (con mayúscula inicial) y así se manda de vuelta.
export const IDENTIFICATION_TYPES = {
  DNI: [7, 8],
  CI: [1, 9],
  LC: [6, 7],
  LE: [6, 7],
  Otro: [5, 20],
};

// Identificación del comprador (viaja como payer.identification a MP).
// El número se normaliza a solo dígitos (sin puntos ni espacios), igual que
// hace el teléfono: el cliente tipea "12.345.678" y MP recibe "12345678".
// Es dato sensible: el server valida acá, lo pasa directo al body de la
// order y NO lo persiste ni lo loguea.
export function isValidIdentification(type, number) {
  const limits = IDENTIFICATION_TYPES[type];
  if (!limits) return false;
  const digits = String(number || "").replace(/[\s.-]/g, "");
  if (!/^\d+$/.test(digits)) return false;
  return digits.length >= limits[0] && digits.length <= limits[1];
}
