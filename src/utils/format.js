// Formateo de precios en pesos argentinos
// Ej: 18900 -> "$18.900"
export function formatPrice(value) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

// Variante compacta, sin espacio tras el símbolo: "$22.900". Intl devuelve
// "$ 22.900" con un espacio duro (U+00A0) y en el botón "Continuar" y en las
// filas angostas del carrito ese hueco se veía como un precio partido.
// formatPrice queda intacta porque el ticket impreso depende de ese espacio.
export function formatPriceCompact(value) {
  return formatPrice(value).replace(/\s+/g, "");
}

// Precio de una línea del carrito: unitario + extras + opciones, por cantidad.
// Así el número de la derecha "cierra" con los extras mostrados debajo.
export function lineTotal(item) {
  const extras = (item.extras || []).reduce((acc, e) => acc + e.price, 0);
  const opciones = (item.options || []).reduce((acc, o) => acc + (o.extraPrice || 0), 0);
  return (item.unitPrice + extras + opciones) * item.qty;
}

// Clave de item de carrito (para identificarlo de forma única)
export function cartKey(item) {
  const extrasKey = (item.extras || [])
    .map((e) => e.id)
    .sort()
    .join(",");
  const optionsKey = (item.options || [])
    .map((o) => `${o.groupId}:${o.optionId}`)
    .sort()
    .join(",");
  // La nota forma parte de la clave: dos líneas iguales con notas distintas
  // son líneas separadas (antes se fusionaban y la segunda pisaba la nota
  // de la primera). Se normaliza con trim para que "sin cebolla" y
  // " sin cebolla " no generen dos líneas.
  // Formato: producto|extras|opciones|nota
  return `${item.productId}|${extrasKey}|${optionsKey}|${(item.notes || "").trim()}`;
}