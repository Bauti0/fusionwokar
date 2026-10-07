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
