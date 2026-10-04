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

// Arma el texto completo del pedido.
// - `orderNumber`: número que devolvió el server (ej. FW-00006). Viaja en el
//   mensaje para que el local lo cruce con el panel; sin él no hay forma de
//   encontrar la fila.
// - `notRegistered`: el server no pudo CONFIRMAR el pedido (red/timeout/5xx).
//   La respuesta se perdió, así que el pedido PUEDE haberse creado igual: el
//   mensaje arranca con la marca que se lo aclara al local.
export function buildOrderMessage({ branch, order, customer, orderMode, paymentMethod, address, deliveryNotes, coupon, discount, scheduledFor, shipping, orderNumber, notRegistered }) {
  const warning = notRegistered
    ? "⚠️ PEDIDO POSIBLEMENTE NO REGISTRADO EN LA WEB — buscar en el panel por teléfono antes de cargarlo a mano\n\n"
    : "";
  const header =
    `🍜 *NUEVO PEDIDO — Fusión Wok* 🍜\n` +
    (orderNumber ? `N° de pedido: *${orderNumber}*\n` : "") +
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
  const shippingBlocks = Math.round(Number(shipping?.blocks) || 0);

  let totals =
    `\n\n*Subtotal:* ${formatPrice(subtotal)}\n`;
  if (discount > 0) {
    totals += `🏷️ *Descuento (${coupon}):* -${formatPrice(discount)}\n`;
  }
  if (shippingCost > 0) {
    totals += `🛵 *Envío*${shippingBlocks ? ` (~${shippingBlocks} cuadras)` : ""}: ${formatPrice(shippingCost)}\n`;
  }
  totals += `*Total: ${formatPrice(Math.max(total - (discount || 0) + shippingCost, 0))}*`;
  if (scheduledFor) {
    try {
      totals += `\n🕒 *Programado para:* ${new Date(scheduledFor).toLocaleString("es-AR", { hour12: false })}`;
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

  return `${warning}${header}*DETALLE*\n${items}${totals}${customerBlock}${payment}\n\nEnviado desde fusionwok.net`;
}

// Link de wa.me con el mensaje prellenado, SIN abrir ninguna ventana.
// Es la parte pura de sendOrderByWhatsApp: el flujo efectivo/transferencia
// la usa para abrir la ventana en el mismo click del usuario y cargarle
// la URL cuando el pedido ya existe (Safari iOS bloquea window.open
// después de un await).
export function buildWhatsAppOrderUrl(orderData) {
  const message = buildOrderMessage(orderData);
  return `https://wa.me/${orderData.branch.whatsapp}?text=${encodeURIComponent(message)}`;
}

// Abre WhatsApp con el mensaje prellenado hacia el número de la sucursal
export function sendOrderByWhatsApp({ branch, order, customer, orderMode, paymentMethod, address, deliveryNotes, coupon, discount, scheduledFor, shipping }) {
  window.open(buildWhatsAppOrderUrl({ branch, order, customer, orderMode, paymentMethod, address, deliveryNotes, coupon, discount, scheduledFor, shipping }), "_blank");
}

// Link de WhatsApp para cuando el pedido YA quedó guardado en la base pero el
// pago automático no se pudo completar (Mercado Pago caído, credenciales
// inválidas, sin costo de envío). Es el último resort: si no lleva el número de
// pedido, el local no tiene forma de encontrar la fila y el pedido se pierde.
export function waLinkForUnpaidOrder(branch, { orderNumber, reason = "" } = {}) {
  const text =
    `Hola! Hice el pedido ${orderNumber} en ${branch?.name || "Fusión Wok"} y no pude completar el pago en la página.\n` +
    (reason ? `\nMotivo que me muestra la web: ${reason}\n` : "\n") +
    "¿Me confirmás si puedo pagar por otro medio?";
  return `https://wa.me/${branch?.whatsapp || ""}?text=${encodeURIComponent(text)}`;
}

// Decisión del flujo efectivo/transferencia cuando POST /api/orders falló.
// Es pura (test/direct-order-fallback.test.js) para poder fijar los TRES
// comportamientos por separado:
//
// - Rechazo del server (4xx con `error`, ej. "Producto no disponible"): el
//   pedido NO existe. No se abre WhatsApp (nada que mandar: el local no lo
//   puede cargar porque está rechazado), se muestra el mensaje EXACTO del
//   server en el checkout y el carrito queda intacto.
// - Falla de red, timeout o 5xx: el server no confirmó nada, PERO puede que
//   haya creado el pedido igual y se haya perdido la respuesta. WhatsApp no se
//   abre solo: se le ofrecen al cliente las dos salidas (reintentar o avisar),
//   el mensaje va marcado (`notRegistered`) y la pantalla avisa que no se pudo
//   confirmar que esté guardado.
//
// Antes de esta función el catch del flujo se comía cualquier error igual:
// un 400 abría WhatsApp con un pedido que el panel nunca iba a recibir.
export function decideDirectOrderOutcome(err) {
  const status = Number(err?.status) || 0;
  const raw = err?.message || "no pudimos comunicarnos con el servidor";
  // Para el aviso de pantalla, que va en el medio de una frase: el server
  // manda los mensajes con punto final y sin este recorte quedan dos puntos.
  const reason = raw.replace(/\.\s*$/, "");

  // 4xx: la validación del server corre ANTES del INSERT (server/index.js),
  // así que ningún rechazo tiene orderNumber: no hay pedido que rescatar.
  if (status >= 400 && status < 500) {
    return {
      kind: "rejected",
      openWhatsApp: false,
      notRegistered: false,
      registerInHistory: false,
      // El mensaje textual del server, tal cual: reescribirlo le quita al
      // cliente la pista de qué corregir (ej. qué producto no está disponible).
      message: raw,
      note: "No registramos ningún pedido y tu carrito quedó como estaba.",
    };
  }

  // status 0 (red/timeout) o 5xx: el server nunca respondió. El pedido puede
  // haber quedado creado, así que el aviso NO dice "no está registrado": dice
  // que no pudimos confirmarlo y le da al local la forma de buscarlo.
  return {
    kind: "unreachable",
    openWhatsApp: true,
    notRegistered: true,
    registerInHistory: false,
    message:
      `⚠️ No pudimos confirmar que tu pedido se haya guardado: ${reason}. ` +
      "El servidor puede haberlo creado igual, así que el local tiene que buscarlo por tu teléfono " +
      "en el panel antes de cargarlo a mano. Podés reintentar el pedido o avisarnos por WhatsApp. " +
      "Tu carrito queda intacto.",
    note: "",
  };
}