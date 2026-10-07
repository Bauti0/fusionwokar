// Utilidades puras para el desglose visual del pedido (panel admin + tracking).
// No importan server/db.js ni disparan side-effects; solo reciben el objeto
// que devuelve toPublicOrder (o toPublicOrderPublic) y devuelven estructura
// lista para renderizar: filas de items con extras, descuento, envío, total.

import { lineTotal } from "./format.js";

// Devuelve las filas de items con sus extras, cada una con precio.
// Orden: mayor a menor cantidad (igual que el ticket).
// Cada fila: { name, qty, unitPrice, lineTotal, extras: [{ label, price, lineTotal }], notes }
export function buildItemRows(order) {
  if (!order?.items?.length) return [];

  // Copia y ordena de mayor a menor cantidad (sin mutar el original)
  const items = [...order.items].sort((a, b) => (b.qty || 0) - (a.qty || 0));

  return items.map((it) => {
    const extras = (it.extras || []).map((e) => ({
      label: e.label,
      price: e.price,
      lineTotal: e.price * (it.qty || 1),
    }));
    return {
      name: it.name,
      qty: it.qty || 1,
      unitPrice: it.unitPrice,
      lineTotal: lineTotal(it),
      extras,
      notes: it.notes,
    };
  });
}

// Devuelve true si el pedido tiene descuento aplicado.
export function hasDiscount(order) {
  return !!order && Number(order.discount) > 0;
}

// Devuelve la línea de descuento para mostrar (null si no hay).
export function buildDiscountRow(order) {
  if (!hasDiscount(order)) return null;
  return {
    label: order.couponCode ? `Descuento (${order.couponCode})` : "Descuento",
    amount: -Number(order.discount),
  };
}

// Devuelve la línea de envío para mostrar (null si no corresponde).
// Solo en delivery. Si shipping.pending → "a confirmar".
export function buildShippingRow(order) {
  if (!order || order.orderMode !== "delivery") return null;
  const cost = Number(order.shipping?.cost ?? order.shippingCost ?? 0) || 0;
  const pending = !!order.shipping?.pending;
  if (cost === 0 && !pending) return null;
  return {
    label: "Envío",
    amount: pending ? null : cost,
    pending,
  };
}

// Calcula el subtotal de items (con extras incluidos).
export function computeItemsSubtotal(order) {
  if (!order?.items?.length) return 0;
  return order.items.reduce((acc, it) => acc + lineTotal(it), 0);
}

// Verifica que el desglose cierre: itemsSubtotal + discount + shipping = total
// discount es negativo o 0. shipping es 0 o positivo.
// Devuelve { ok: boolean, diff: number, itemsSubtotal, discount, shipping, total }
export function verifyOrderBreakdown(order) {
  if (!order) return { ok: false, diff: NaN, itemsSubtotal: 0, discount: 0, shipping: 0, total: 0 };
  const itemsSubtotal = computeItemsSubtotal(order);
  const discount = -Number(order.discount || 0);
  const shipping = Number(order.shipping?.cost ?? order.shippingCost ?? 0) || 0;
  const total = Number(order.total || 0);
  const calculated = itemsSubtotal + discount + shipping;
  const diff = Math.round(calculated - total);
  return {
    ok: diff === 0,
    diff,
    itemsSubtotal,
    discount,
    shipping,
    total,
  };
}

// Construye el resumen completo listo para renderizar en una tabla.
// Devuelve: { rows: [...], total }
// rows incluye: items (con extras anidados), discountRow (opcional), shippingRow (opcional), totalRow
export function buildOrderSummaryRows(order) {
  const itemRows = buildItemRows(order);
  const rows = [...itemRows];

  const discountRow = buildDiscountRow(order);
  if (discountRow) rows.push({ type: "discount", ...discountRow });

  const shippingRow = buildShippingRow(order);
  if (shippingRow) rows.push({ type: "shipping", ...shippingRow });

  rows.push({
    type: "total",
    label: "Total",
    amount: Number(order?.total || 0),
  });

  return { rows, total: Number(order?.total || 0) };
}