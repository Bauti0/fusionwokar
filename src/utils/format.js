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

// Precio de una línea del carrito: unitario + extras, por cantidad.
// Así el número de la derecha "cierra" con los extras mostrados debajo.
export function lineTotal(item) {
  const extras = (item.extras || []).reduce((acc, e) => acc + e.price, 0);
  return (item.unitPrice + extras) * item.qty;
}

// Clave de item de carrito (para identificarlo de forma única)
export function cartKey(item) {
  const extrasKey = (item.extras || [])
    .map((e) => e.id)
    .sort()
    .join(",");
  return `${item.productId}|${extrasKey}`;
}