// ============================================================
// FUSIÓN WOK — Utilidades de texto para la impresora térmica (58mm)
// ============================================================

// Por qué: la térmica de 58mm no tiene fuente Unicode. El driver la maneja con
// una tabla de códigos de un byte (CP437/CP850 según el modelo) y varias están
// configuradas en modo "carácter chino de doble byte". En ese modo cualquier
// byte fuera de ASCII se combina con el siguiente y en el papel aparecen
// ideogramas: "FUSIÓN WOK" salía como "FUSI觀 WOK" (la Ó seguida de la N),
// "1× Ramen" como "1識amen" y "Tandil — Chaca..." como "Tandil 集Chaca...".
//
// Todo el texto que se imprime pasa por acá. La base de datos NO se toca: los
// productos siguen guardados con sus tildes y símbolos, la limpieza es solo al
// imprimir. Por eso vive acá y no en el guardado.

// Sustituye los símbolos que aparecen en el ticket por su equivalente ASCII.
// El signo de multiplicación va a "x" (las cantidades se leen "1 x Ramen"); los
// separadores (punto medio, viñeta, rayas) van a "-".
const SIMBOLOS = [
  // Multiplicación: "2 × Salsa" → "2 x Salsa"
  [/×/g, "x"],
  // Separadores: "·", "•", "‣", "–", "—", "−" → "-"
  [/[·•‣–—−]/g, "-"],
  // Comillas tipográficas → comillas simples y dobles
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  // Los puntos suspensivos Unicode entran como 3 caracteres ASCII
  [/…/g, "..."],
  // Espacios que no son ASCII: el precio de Intl viene como "$\u00A036.000"
  // (espacio duro) y la fecha como "10:05\u202Fa. m." en Chrome (espacio
  // finísimo). Se vuelven un espacio normal para no comerse la separación
  // entre los campos.
  [/[\u00A0\u202F\u2009\u2007]/g, " "],
];

// "¡Gracias por tu pedido!" y "¿...?" se imprimen sin los signos de apertura:
// en la térmica salían como "Â¡Gracias" y "Â¿".
const A_BORRAR = /[¡¿�]/g;

// Cualquier cosa fuera del ASCII imprimible (0x20-0x7E) se borra: emojis,
// ideogramas sueltos, acentos que sobrevivieron y símbolos Unicode.
// Se conservan \n y \t porque el texto se arma por líneas y por columnas.
//
// OJO: esta función se aplica SOLO sobre los textos (nombres, direcciones,
// notas). Si algún día la impresión pasa a mandar bytes ESC/POS crudos, hay que
// llamar a sanitizeForPrinter() antes de componer el comando, nunca sobre el
// comando ya armado: acá se borran los bytes de control.
export function sanitizeForPrinter(value) {
  let out = String(value ?? "")
    // Descomponer y tirar los diacríticos: á→a, é→e, ñ→n, Á→A.
    .normalize("NFD")
    .replace(/\p{M}/gu, "");

  out = out.replace(A_BORRAR, "");
  for (const [pattern, replacement] of SIMBOLOS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/[^\n\t\x20-\x7E]/g, "");
}

// Ordena los ítems de MAYOR a MENOR cantidad para imprimir. Es solo una copia:
// el orden guardado en la base de datos (y el que ve el panel) no se toca.
//
// Array.prototype.sort es estable (ES2019), así que los empates conservan el
// orden en que llegaron: si dos platos están igual, la cocina los quiere en el
// orden que los pidió el cliente. La cantidad se lee con Number porque puede
// venir como texto de la base y `null`/"" darían NaN en el comparador, que
// rompe el orden de todo el array.
export function sortItemsByQty(items) {
  return [...items].sort((a, b) => cantidad(b) - cantidad(a));
}

function cantidad(it) {
  const n = Number(it?.qty);
  return Number.isFinite(n) ? n : 0;
}