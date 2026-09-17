import { useEffect, useRef, useState } from "react";
import { BRANCHES } from "../data/branches.js";
import { paymentLabel, statusLabel } from "../constants.js";
import { formatPrice } from "../utils/format.js";
import ConfirmModal from "./ui/ConfirmModal.jsx";

// ============================================================
// TicketPrint — imprime el ticket de cocina/entrega en 58mm.
// Abre una ventana con el ticket listo y dispara print()
// (la impresora térmica debe estar configurada como predeterminada)
// Prop `variant`:
//   "ticket"  → ticket completo para la bolsa del pedido (importes, cliente, etc.)
//   "comanda" → comanda para la cocina, SOLO cantidades y nombre del producto
// ============================================================

// Escapa texto para evitar inyección de HTML/XSS en el ticket
function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildTicketHtml(order) {
  const branch = BRANCHES[order.branch];
  const date = new Date(order.createdAt).toLocaleString("es-AR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  const items = order.items
    .map((it) => {
      const lines = [`<tr><td colspan="2">${it.qty}× ${esc(it.name)}</td></tr>`];
      if (it.extras?.length) {
        lines.push(`<tr><td class="sub">&nbsp;&nbsp;· ${it.extras.map((e) => esc(e.label)).join(", ")}</td><td class="right">${formatPrice(it.extras.reduce((a, e) => a + e.price, 0) * it.qty)}</td></tr>`);
      }
      if (it.notes) {
        lines.push(`<tr><td colspan="2" class="sub">&nbsp;&nbsp;Nota: ${esc(it.notes)}</td></tr>`);
      }
      lines.push(`<tr><td class="sub">&nbsp;&nbsp;${formatPrice(it.unitPrice)} c/u × ${it.qty}</td><td class="right">${formatPrice(it.unitPrice * it.qty)}</td></tr>`);
      return lines.join("");
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Ticket ${esc(order.orderNumber)}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  @page { size:58mm auto; margin:0; }
  @media print { html, body { width:48mm; margin:0; } }
  html, body { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { width:48mm; font-family:'Courier New',monospace; font-weight:bold; font-size:13px; color:#000; padding:2mm; -webkit-font-smoothing:none; }
  .center { text-align:center; }
  h1 { font-size:17px; margin-bottom:2px; }
  .line { border-top:2px solid #000; margin:6px 0; }
  table { width:100%; border-collapse:collapse; }
  td { vertical-align:top; padding:1px 0; word-break:break-word; }
  .right { text-align:right; white-space:nowrap; }
  .sub { font-size:12px; color:#000; }
  .b { font-weight:bold; }
  .big { font-size:16px; }
  .mt { margin-top:8px; }
  .section { margin-top:6px; }
</style></head><body>
  <div class="center">
    <h1>FUSIÓN WOK</h1>
    <div>${esc(branch.name)} — ${esc(branch.address)}</div>
    <div>Pedido online · ${esc(date)}</div>
  </div>
  <div class="line"></div>
  <div class="center big b">${esc(order.orderNumber)}</div>
  <div class="line"></div>
  <table>
    <tr><td><b>Estado:</b> ${esc(statusLabel(order.status))}</td></tr>
    <tr><td><b>Pago:</b> ${esc(paymentLabel(order.paymentStatus))} (${esc(order.paymentMethod)})</td></tr>
    <tr><td><b>Entrega:</b> ${order.orderMode === "delivery" ? "DELIVERY 🛵" : "RETIRO 🥡"}</td></tr>
    ${order.orderMode === "delivery" && order.address ? `<tr><td><b>Dirección:</b> ${esc(order.address)}</td></tr>` : ""}
    <tr><td><b>Cliente:</b> ${esc(order.customer?.name)}</td></tr>
    <tr><td><b>Tel:</b> ${esc(order.customer?.phone)}</td></tr>
  </table>
  <div class="line"></div>
  <table>${items}
    <tr><td class="b big">TOTAL</td><td class="right b big">${formatPrice(order.total)}</td></tr>
  </table>
  ${order.notes ? `<div class="section"><b>${order.orderMode === "delivery" ? "Observaciones de entrega" : "Nota"}:</b> ${esc(order.notes)}</div>` : ""}
  <div class="line"></div>
  <div class="center">¡Gracias por tu pedido!</div>
</body></html>`;
}

// Comanda de cocina: SOLO cantidades y nombre del producto.
function buildComandaHtml(order) {
  const branch = BRANCHES[order.branch];
  const date = new Date(order.createdAt).toLocaleString("es-AR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  const items = order.items
    .map((it) => `<tr><td class="qty">${it.qty}×</td><td>${esc(it.name)}</td></tr>`)
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Comanda ${esc(order.orderNumber)}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  @page { size:58mm auto; margin:0; }
  @media print { html, body { width:48mm; margin:0; } }
  html, body { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { width:48mm; font-family:'Courier New',monospace; font-weight:bold; font-size:16px; color:#000; padding:2mm; -webkit-font-smoothing:none; }
  .center { text-align:center; }
  h1 { font-size:18px; margin-bottom:2px; }
  .line { border-top:2px solid #000; margin:6px 0; }
  table { width:100%; border-collapse:collapse; }
  td { vertical-align:top; padding:2px 0; word-break:break-word; }
  .qty { width:22%; white-space:nowrap; }
  .b { font-weight:bold; }
  .big { font-size:20px; }
</style></head><body>
  <div class="center">
    <h1>FUSIÓN WOK</h1>
    <div>${esc(branch.name)}</div>
  </div>
  <div class="line"></div>
  <div class="center big b">COMANDA · ${esc(order.orderNumber)}</div>
  <div class="center">${esc(date)} · ${order.orderMode === "delivery" ? "DELIVERY 🛵" : "RETIRO 🥡"}</div>
  <div class="line"></div>
  <table>${items}</table>
</body></html>`;
}

export default function TicketPrint({ order, onClose, variant = "ticket" }) {
  const done = useRef(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const win = window.open("", "_blank", "width=300,height=600");
    if (!win) {
      setBlocked(true);
      return;
    }
    win.document.write(variant === "comanda" ? buildComandaHtml(order) : buildTicketHtml(order));
    win.document.close();
    const t = setTimeout(() => {
      win.focus();
      win.print();
      const t2 = setTimeout(() => win.close(), 300);
      setTimeout(() => onClose(), 200);
      clearTimeout(t2);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (blocked) {
    return (
      <ConfirmModal
        title="No se pudo imprimir"
        message="Permití las ventanas emergentes para este sitio y volvé a intentarlo."
        cancelText={null}
        confirmText="Entendido"
        onConfirm={() => {}}
        onClose={onClose}
      />
    );
  }

  return null;
}