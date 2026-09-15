import { formatPrice } from "./format.js";

// ============================================================
// Construcción del mensaje de WhatsApp y apertura de wa.me
// ============================================================

// Detalle legible de un item del carrito
function itemLines(item) {
  const lines = [`• ${item.qty}× ${item.name} — ${formatPrice(item.unitPrice * item.qty)}`];
  if (item.extras && item.extras.length) {
    lines.push(`    · ${item.extras.map((e) => `${e.label} (+${formatPrice(e.price)})`).join(", ")}`);
  }
  if (item.notes) {
    lines.push(`    · Nota: ${item.notes}`);
  }
  return lines;
}

// Arma el texto completo del pedido
export function buildOrderMessage({ branch, order, customer, orderMode, paymentMethod, address, deliveryNotes, coupon, discount, scheduledFor, shipping }) {
  const header =
    `🍜 *NUEVO PEDIDO — Fusión Wok* 🍜\n` +
    `Sucursal: *${branch.name}*\n` +
    `Modalidad: *${orderMode === "delivery" ? "Delivery 🛵" : "Retiro en el local 🥡"}*\n\n`;

  const items = order.items.map(itemLines).flat().join("\n");

  const subtotal = order.items.reduce((acc, it) => acc + it.unitPrice * it.qty, 0);
  const extrasTotal = order.items.reduce(
    (acc, it) => acc + (it.extras || []).reduce((a, e) => a + e.price, 0) * it.qty,
    0
  );
  const total = subtotal + extrasTotal;
  const shippingCost = Math.round(Number(shipping?.cost) || 0);
  const shippingKm = Math.round(Number(shipping?.km) || 0);

  let totals =
    `\n\n*Subtotal:* ${formatPrice(subtotal)}\n`;
  if (discount > 0) {
    totals += `🏷️ *Descuento (${coupon}):* -${formatPrice(discount)}\n`;
  }
  if (shippingCost > 0) {
    totals += `🛵 *Envío*${shippingKm ? ` (~${shippingKm} km)` : ""}: ${formatPrice(shippingCost)}\n`;
  }
  totals += `*Total: ${formatPrice(Math.max(total - (discount || 0) + shippingCost, 0))}*`;
  if (scheduledFor) {
    try {
      totals += `\n🕒 *Programado para:* ${new Date(scheduledFor).toLocaleString("es-AR")}`;
    } catch {
      /* fecha inválida: se omite */
    }
  }

  const customerBlock =
    `\n\n👤 *Cliente*\n` +
    `Nombre: ${customer.name}\n` +
    `Celular: ${customer.phone}` +
    (orderMode === "delivery" && address ? `\nDirección: ${address}` : "") +
    (orderMode === "delivery" && deliveryNotes ? `\nObservaciones: ${deliveryNotes}` : "");

  const payment = `\n💳 Pago: ${paymentMethod}`;

  return `${header}*DETALLE*\n${items}${totals}${customerBlock}${payment}\n\nEnviado desde fusionwok.ar`;
}

// Abre WhatsApp con el mensaje prellenado hacia el número de la sucursal
export function sendOrderByWhatsApp({ branch, order, customer, orderMode, paymentMethod, address, deliveryNotes, coupon, discount, scheduledFor, shipping }) {
  const message = buildOrderMessage({ branch, order, customer, orderMode, paymentMethod, address, deliveryNotes, coupon, discount, scheduledFor, shipping });
  const url = `https://wa.me/${branch.whatsapp}?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank");
}