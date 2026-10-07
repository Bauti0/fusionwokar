// ============================================================
// FUSIÓN WOK — Vista previa de la edición de un pedido (admin)
// Lógica pura: qué se le manda al servidor y cómo queda el total
// ANTES de confirmar. Espejo de server/order-edit.js (que es el
// que manda: si difieren, el total real es el del servidor).
//
// El total que se muestra DESPUÉS de guardar sale siempre de la
// respuesta del PATCH (res.order), nunca de acá: esto es solo la
// vista previa del resumen de confirmación.
// ============================================================

import { formatPrice } from "./format.js";

const PAGO_LABEL = {
  mercadopago: "MercadoPago",
  efectivo: "Efectivo",
  transferencia: "Transferencia",
};

const PAGOS_EDITABLES = ["efectivo", "transferencia"];

function pagoLabel(id) {
  return PAGO_LABEL[id] || id;
}

// "" / null / undefined → null: un campo vacío no es un costo de envío de 0.
function numero(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {Object} order - pedido en formato público (toPublicOrder)
 * @param {Object} draft - { orderMode, paymentMethod, address, shippingCost, shippingTouched }
 * @returns {{ error: string, cambios: Object, lineas: string[], totalNuevo: number|null,
 *             mpPendienteAviso: boolean, hayCambios: boolean }}
 */
export function previewOrderEdit(order, draft = {}) {
  const out = {
    error: "",
    cambios: {},
    lineas: [],
    totalNuevo: null,
    mpPendienteAviso: false,
    hayCambios: false,
  };

  const total = Number(order?.total) || 0;
  const envioActual = Number(order?.shipping?.cost) || 0;
  const modoActual = order?.orderMode === "delivery" ? "delivery" : "pickup";
  const pagoActual = order?.paymentMethod || "";
  const esTandil = order?.branch === "tandil";

  // Mismas dos barreras que el backend, para que la vista previa no
  // prometa un cambio que después va a rechazar.
  if (order?.status === "cancelled") {
    out.error = "No se puede editar un pedido cancelado";
    return out;
  }
  if (pagoActual === "mercadopago" && order?.paymentStatus === "approved") {
    out.error = "Este pedido se pagó online con MercadoPago, ajustalo desde MercadoPago";
    return out;
  }

  const modoNuevo = draft.orderMode === "delivery" ? "delivery" : "pickup";
  const pagoNuevo = PAGOS_EDITABLES.includes(draft.paymentMethod) ? draft.paymentMethod : pagoActual;

  let totalNuevo = total;
  let totalOk = true;

  if (modoNuevo !== modoActual) {
    if (modoNuevo === "pickup") {
      // delivery → pickup: se descuenta el envío guardado y se limpia todo.
      out.cambios.orderMode = "pickup";
      totalNuevo = Math.max(0, total - envioActual);
      out.lineas.push("Delivery → Mostrador");
      out.lineas.push(
        envioActual > 0 ? `Envío: se descuenta ${formatPrice(envioActual)}` : "Envío: sin cargo"
      );
    } else {
      // pickup → delivery: dirección obligatoria + envío.
      const dir = String(draft.address || "").trim();
      if (!dir) {
        out.error = "Falta la dirección de entrega";
        return out;
      }

      // shippingCost se manda solo si el admin lo tocó a mano (Tandil) o si
      // es obligatorio manual (Necochea). Sin tocar en Tandil, lo calcula el
      // servidor con la misma fórmula.
      const envio = draft.shippingTouched || !esTandil ? numero(draft.shippingCost) : null;

      if (!esTandil && envio === null) {
        out.error = "Ingresá el costo de envío";
        return out;
      }

      out.cambios.orderMode = "delivery";
      out.cambios.address = dir;
      out.lineas.push("Mostrador → Delivery");
      out.lineas.push(`Dirección: ${dir}`);

      if (envio !== null) {
        const redondeado = Math.round(envio);
        out.cambios.shippingCost = redondeado;
        totalNuevo = total + redondeado;
        out.lineas.push(`Envío: ${formatPrice(redondeado)}`);
      } else {
        totalOk = false;
        out.lineas.push("Envío: lo calcula el servidor");
      }
    }

    out.lineas.push(
      totalOk
        ? `Total: ${formatPrice(total)} → ${formatPrice(totalNuevo)}`
        : `Total: ${formatPrice(total)} → se calcula al guardar`
    );
    out.totalNuevo = totalOk ? totalNuevo : null;
  }

  if (pagoNuevo !== pagoActual) {
    out.cambios.paymentMethod = pagoNuevo;
    out.lineas.push(`Pago: ${pagoLabel(pagoActual)} → ${pagoLabel(pagoNuevo)}`);
    // MP pendiente que se pasa a efectivo/transferencia: el aviso de que,
    // si el cliente paga igual, hay que devolverlo desde MercadoPago.
    out.mpPendienteAviso = pagoActual === "mercadopago" && order?.paymentStatus === "pending";
  }

  out.hayCambios = Object.keys(out.cambios).length > 0;
  return out;
}

// ============================================================
// Historial de cambios (auditoría) — vista del panel, solo superadmin.
// El server devuelve UNA FILA por campo modificado (snake_case, la
// forma real de order_audit_log, del más reciente al más viejo): una
// edición que toca modo + dirección + envío son 3 filas del mismo
// momento. Se agrupan por (admin_username, created_at) para mostrar
// autor/fecha/total una sola vez y una línea por campo.
// ============================================================

const AUDIT_FIELD_LABEL = {
  orderMode: "Tipo de entrega",
  paymentMethod: "Medio de pago",
  address: "Dirección",
  shipping: "Envío",
};

// Un valor vacío (dirección/envío borrados al pasar a mostrador) queda
// como "—" en vez de un hueco.
function auditValue(field, value) {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "orderMode") return value === "delivery" ? "Delivery" : "Mostrador";
  if (field === "paymentMethod") return PAGO_LABEL[value] || value;
  if (field === "shipping") return formatPrice(Number(value));
  return String(value);
}

/**
 * @param {Array} rows - filas de order_audit_log (getAuditLogs)
 * @returns {Array} ediciones: { id, autor, sucursal, fecha, cambioTotal,
 *   totalDe, totalA, lineas: [{ campo, de, a }] }
 */
export function formatAuditEdits(rows) {
  const edits = [];
  let lastKey = "";
  for (const r of rows || []) {
    const key = `${r.admin_username}|${r.created_at}`;
    if (edits.length === 0 || key !== lastKey) {
      lastKey = key;
      edits.push({
        id: r.id,
        autor: r.admin_username || "",
        // "" para el superadmin del .env: el panel no le dibuja sucursal.
        sucursal: r.admin_branch || "",
        fecha: r.created_at
          ? new Date(r.created_at).toLocaleString("es-AR", {
              timeZone: "America/Argentina/Buenos_Aires",
            })
          : "",
        cambioTotal: Number(r.old_total) !== Number(r.new_total),
        totalDe: r.old_total,
        totalA: r.new_total,
        lineas: [],
      });
    }
    const cur = edits[edits.length - 1];
    cur.lineas.push({
      campo: AUDIT_FIELD_LABEL[r.field] || r.field,
      de: auditValue(r.field, r.old_value),
      a: auditValue(r.field, r.new_value),
    });
  }
  return edits;
}
