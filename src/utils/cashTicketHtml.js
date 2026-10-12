import { BRANCHES } from "../data/branches.js";
import { sanitizeForPrinter } from "./printer.js";
import { esc, precio, PIE } from "./ticketHtml.js";

// ============================================================
// Ticket del CIERRE DE CAJA para la impresora térmica (58mm).
// Mismo formato y estilo que el ticket de pedidos (buildTicketHtml):
// misma hoja, misma tipografía, sin colores nuevos.
//
// Datos que usa, cada uno de su fuente de verdad:
//   · cash  → el registro del cierre con la forma EXACTA que devuelve
//     GET /api/admin/cash-register (rowToCashRegister de server/index.js).
//     Fondo inicial, efectivo esperado, contado y diferencia son valores
//     FIJOS del cierre: acá no se recalcula nada.
//   · sales → el reporte de ventas del turno (GET /api/admin/sales con
//     from=openedAt y to=closedAt, siempre de la sucursal del cierre).
//     Trae el desglose por medio de pago, la cantidad de pedidos y las
//     devoluciones. Si la llamada falló viene null: el ticket sale igual,
//     sin desglose y con una nota (nunca bloquea la impresión).
//
// Quién abrió/cerró la caja NO existe en la base: no se muestra ni se
// inventa.
//
// Correcciones: si el cierre fue corregido (cash.correctedAt, última
// corrección), el ticket muestra los valores VIGENTES (la fila ya viene
// recalculada) y un renglón "Corregido dd/mm/yyyy hh:mm" en las fechas.
// ============================================================

// Hora de Argentina SIEMPRE, sin importar dónde esté el navegador que
// imprime. Formato "dd/mm/yyyy hh:mm" armado con hourCycle h23 (24 h fijo):
// el ICU de es-AR puede mostrar "a. m." y mete una coma y un espacio
// finísimo (U+202F) que esc() limpia después. Es deliberadamente distinto
// de fechaDe() de ticketHtml.js: esa usa la hora local del navegador y no
// se toca para no cambiar los tickets de pedidos.
const AR_TZ = "America/Argentina/Buenos_Aires";

function fechaAr(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const f = new Intl.DateTimeFormat("es-AR", {
    timeZone: AR_TZ,
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  return f.format(d).replace(",", "");
}

// Rótulos de los medios de pago (mismos nombres que usa el panel).
const METODO = { efectivo: "Efectivo", mercadopago: "Mercado Pago", transferencia: "Transferencia" };

export function buildCashTicketHtml({ cash, sales } = {}) {
  const branch = BRANCHES[cash?.branch] || { name: cash?.branch || "", address: "" };

  // Diferencia contado vs esperado, con la marca faltante/sobrante.
  const dif = Number(cash?.difference) || 0;
  const difLabel =
    dif === 0 ? "Caja exacta" : dif > 0 ? `Sobra ${precio(dif)}` : `Falta ${precio(Math.abs(dif))}`;

  // El desglose puede despegarse del cierre si un pedido se cargó con fecha
  // del turno DESPUÉS de cerrar la caja: el esperado quedó congelado en el
  // registro y el reporte del rango lo incluye. En ese caso el renglón
  // Efectivo usa la cifra DEL CIERRE (una sola cifra de efectivo en el
  // papel, nunca dos en conflicto) y va una nota corta.
  const efectivoCierre = (Number(cash?.expectedAmount) || 0) - (Number(cash?.openingAmount) || 0);
  const efectivoReporte = sales?.byMethod?.find((m) => m.method === "efectivo")?.total;
  const conflicto = !!sales && Number.isFinite(efectivoReporte) && efectivoReporte !== efectivoCierre;

  // Sección de ventas del turno, solo si hay reporte.
  let ventas;
  if (sales) {
    const bruto = Number(sales.total) || 0;
    const devoluciones = Number(sales.devuelto) || 0;
    const neta = Number(sales.net) || 0;
    const metodos = (sales.byMethod || [])
      .map((m) => {
        const valor = m.method === "efectivo" && conflicto ? efectivoCierre : m.total;
        return `<tr><td>${esc(METODO[m.method] || m.method)}</td><td class="right">${precio(valor)}</td></tr>`;
      })
      .join("");
    ventas = `<div class="line"></div>
  <table>${metodos}
    <tr><td class="b">Venta bruta</td><td class="right">${precio(bruto)}</td></tr>
    ${devoluciones > 0
      ? `<tr><td>Devoluciones</td><td class="right">${precio(devoluciones)}</td></tr>
    <tr><td class="b">Venta neta</td><td class="right">${precio(neta)}</td></tr>`
      : `<tr><td class="b">Venta total</td><td class="right">${precio(bruto)}</td></tr>`}
    <tr><td>Pedidos</td><td class="right">${esc(sales.count)}</td></tr>
  </table>
  ${conflicto ? `<div class="section sub">Desglose calculado con datos actuales</div>` : ""}`;
  } else {
    ventas = `<div class="line"></div>
  <div class="sub">Desglose no disponible</div>`;
  }

  // Notas del cierre: ya limpias para la térmica; si no hay, ni línea ni
  // título suelto.
  const notaCierre = sanitizeForPrinter(cash?.notes).trim();

  return `<!doctype html><html><head><meta charset="utf-8"><title>Cierre de caja ${esc(branch.name)}</title>
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
  .sub { font-size:13px; color:#000; padding-left:7px; }
  .b { font-weight:bold; }
  .big { font-size:17px; }
  .mt { margin-top:8px; }
  .section { margin-top:6px; }
</style></head><body>
  <div class="center">
    <h1>FUSION WOK</h1>
    <div>${esc(branch.name)}${branch.address ? ` - ${esc(branch.address)}` : ""}</div>
  </div>
  <div class="line"></div>
  <div class="center big b">CIERRE DE CAJA</div>
  <div class="line"></div>
  <table>
    <tr><td>Apertura</td><td class="right">${esc(fechaAr(cash?.openedAt))}</td></tr>
    <tr><td>Cierre</td><td class="right">${esc(fechaAr(cash?.closedAt))}</td></tr>
    ${cash?.correctedAt ? `<tr><td>Corregido</td><td class="right">${esc(fechaAr(cash.correctedAt))}</td></tr>` : ""}
  </table>
  <div class="line"></div>
  <table>
    <tr><td>Fondo inicial</td><td class="right">${precio(cash?.openingAmount)}</td></tr>
    <tr><td>Efectivo esperado</td><td class="right">${precio(cash?.expectedAmount)}</td></tr>
    <tr><td>Efectivo contado</td><td class="right">${precio(cash?.closingCounted)}</td></tr>
    <tr><td class="b">Diferencia</td><td class="right">${difLabel}</td></tr>
  </table>
  ${ventas}
  ${notaCierre ? `<div class="line"></div>
  <div class="section">Notas: ${esc(notaCierre)}</div>` : ""}
  <div class="line"></div>
  ${PIE}</body></html>`;
}
