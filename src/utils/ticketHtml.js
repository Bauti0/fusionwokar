import { BRANCHES } from "../data/branches.js";
import { paymentLabel, statusLabel } from "../constants.js";
import { formatPrice } from "./format.js";
import { sanitizeForPrinter, sortItemsByQty } from "./printer.js";

// ============================================================
// Armado de los dos documentos que salen por la impresora térmica:
//   buildTicketHtml  → ticket para la bolsa del pedido (importes, cliente, etc.)
//   buildComandaHtml → comanda para la cocina (solo qué y cuántas unidades)
// Vienen en un .js (y no adentro del componente) para poder testearlos con
// node:test, que no parsea JSX.
//
// Todo el texto que se imprime pasa por esc(), que limpia los caracteres que la
// térmica no puede representar (ver sanitizeForPrinter) y después escapa el
// HTML. El orden de los ítems se arma de mayor a menor cantidad con
// sortItemsByQty; el orden guardado en la base de datos no se toca.
// ============================================================

// Limpia el texto para la impresora y lo escapa para el HTML. El escapado va
// DESPUÉS de la limpieza. Cubre los dos documentos: nombre de sucursal,
// dirección, cliente, productos, variantes, notas, rótulos y precios.
function esc(value) {
  return sanitizeForPrinter(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// El precio de Intl viene con un espacio duro entre el $ y el número
// ("$\u00A036.000"): también pasa por la limpieza.
function precio(value) {
  return esc(formatPrice(value));
}

// La nota de un ítem o la del pedido, ya limpia para la impresora y escapada
// para el HTML. Si no hay nada que decir (nota vacía o de solo espacios) devuelve
// cadena vacía, así no se imprime ni una línea en blanco ni un título suelto.
function nota(value) {
  const limpio = sanitizeForPrinter(value).trim();
  return limpio ? esc(limpio) : "";
}

function fechaDe(order) {
  return new Date(order.createdAt).toLocaleString("es-AR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function modalidad(order) {
  return order.orderMode === "delivery" ? "DELIVERY" : "RETIRO";
}

export function buildTicketHtml(order) {
  const branch = BRANCHES[order.branch];
  const date = fechaDe(order);

  // De mayor a menor cantidad, sin tocar el array del pedido.
  const items = sortItemsByQty(order.items)
    .map((it) => {
      const lines = [];
      // Producto principal: nombre (+ " x n" si hay más de 1) y a la derecha el
      // precio base TOTAL del renglón (unitario × cantidad). Así se ve de un
      // vistazo cuál es el plato y cuánto vale.
      const qtyLabel = it.qty > 1 ? ` x ${esc(it.qty)}` : "";
      lines.push(`<tr><td>${esc(it.name)}${qtyLabel}</td><td class="right">${precio(it.unitPrice * it.qty)}</td></tr>`);
      // Adicionales seleccionados (salsa, palitos, galletas…): debajo del
      // producto, subordinados visualmente, cada uno con su precio (× cantidad)
      // y los sin costo en $0.
      if (it.extras?.length) {
        for (const e of it.extras) {
          lines.push(`<tr><td class="sub">&nbsp;&nbsp;- ${esc(e.label)}</td><td class="right">${precio(e.price * it.qty)}</td></tr>`);
        }
      }
      if (it.notes) {
        lines.push(`<tr><td colspan="2" class="sub">&nbsp;&nbsp;Nota: ${esc(it.notes)}</td></tr>`);
      }
      return lines.join("");
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Ticket ${esc(order.orderNumber)}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; font-weight:bold; }
  @page { size:58mm auto; margin:0; }
  @media print { html, body { width:48mm; height:auto; margin:0; overflow:hidden; } }
  html, body { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { width:48mm; font-family:'Arial',sans-serif; font-weight:bold; font-size:14px; color:#000; padding:2mm; -webkit-font-smoothing:none; }
  .center { text-align:center; }
  h1 { font-size:18px; margin-bottom:2px; }
  .line { border-top:2px solid #000; margin:6px 0; }
  table { width:100%; border-collapse:collapse; }
  td { vertical-align:top; padding:1px 0; word-break:break-word; }
  .right { text-align:right; white-space:nowrap; }
  .sub { font-size:13px; color:#000; }
  .b { font-weight:bold; }
  .big { font-size:17px; }
  .mt { margin-top:8px; }
  .section { margin-top:6px; }
</style></head><body>
  <div class="center">
    <h1>FUSION WOK</h1>
    <div>${esc(branch.name)} - ${esc(branch.address)}</div>
    <div>Pedido online - ${esc(date)}</div>
  </div>
  <div class="line"></div>
  <div class="center big b"># ${esc(order.orderNumber)}</div>
  <div class="line"></div>
  <table>
    <tr><td><b>Estado:</b> ${esc(statusLabel(order.status))}</td></tr>
    <tr><td><b>Pago:</b> ${esc(paymentLabel(order.paymentStatus))} (${esc(order.paymentMethod)})</td></tr>
    <tr><td><b>Entrega:</b> ${modalidad(order)}</td></tr>
    ${order.orderMode === "delivery" && order.address ? `<tr><td><b>Direccion:</b> ${esc(order.address)}</td></tr>` : ""}
    <tr><td><b>Cliente:</b> ${esc(order.customer?.name)}</td></tr>
    <tr><td><b>Tel:</b> ${esc(order.customer?.phone)}</td></tr>
  </table>
  <div class="line"></div>
  <table>${items}
    <tr><td class="b big">TOTAL</td><td class="right b big">${precio(order.total)}</td></tr>
  </table>
  ${order.notes ? `<div class="section"><b>${order.orderMode === "delivery" ? "Observaciones de entrega" : "Nota"}:</b> ${esc(order.notes)}</div>` : ""}
  <div class="line"></div>
  <div class="center">Gracias por tu pedido!</div>
</body></html>`;
}

// Comanda de cocina: SOLO cantidades y nombre del producto, más lo que el plato
// necesita para salir bien. Sin cliente, sin importes y sin pie de cortesía:
// este papel lo lee quien cocina.
export function buildComandaHtml(order) {
  const branch = BRANCHES[order.branch];
  const date = fechaDe(order);
  const notaPedido = nota(order.notes);

  // De mayor a menor cantidad, sin tocar el array del pedido.
  const items = sortItemsByQty(order.items)
    .map((it) => {
      const row = `<tr><td class="qty">${esc(it.qty)} x</td><td>${esc(it.name)}</td></tr>`;
      // Los opcionales (salsa, palitos, galletas) también van en la comanda:
      // la cocina necesita saber qué incluye cada plato.
      const extras = (it.extras || [])
        .map((e) => `<tr><td class="qty"></td><td class="sub">&nbsp;- ${esc(e.label)}</td></tr>`)
        .join("");
      // La nota del ítem va debajo de sus variantes, con un asterisco para
      // distinguirla de un adicional. Como sale del .map() sobre los ítems ya
      // ordenados, la nota viaja con su plato.
      const notaItem = nota(it.notes);
      const filaNota = notaItem
        ? `<tr><td class="qty"></td><td class="sub">&nbsp;* ${notaItem}</td></tr>`
        : "";
      return row + extras + filaNota;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Comanda ${esc(order.orderNumber)}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; font-weight:bold; }
  @page { size:58mm auto; margin:0; }
  @media print { html, body { width:48mm; height:auto; margin:0; overflow:hidden; } }
  html, body { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { width:48mm; font-family:'Arial',sans-serif; font-weight:bold; font-size:17px; color:#000; padding:2mm; -webkit-font-smoothing:none; }
  .center { text-align:center; }
  h1 { font-size:19px; margin-bottom:2px; }
  .line { border-top:2px solid #000; margin:6px 0; }
  table { width:100%; border-collapse:collapse; }
  td { vertical-align:top; padding:2px 0; word-break:break-word; }
  .qty { width:22%; white-space:nowrap; }
  .sub { font-size:15px; color:#000; }
  .b { font-weight:bold; }
  .big { font-size:21px; }
</style></head><body>
  <div class="center">
    <h1>FUSION WOK</h1>
    <div>${esc(branch.name)}</div>
  </div>
  <div class="line"></div>
  <div class="center big b">COMANDA - ${esc(order.orderNumber)}</div>
  <div class="center">${esc(date)} - ${modalidad(order)}</div>
  <div class="line"></div>
  <table>${items}</table>${notaPedido ? `
  <div class="line"></div>
  <div>NOTA: ${notaPedido}</div>` : ""}
</body></html>`;
}