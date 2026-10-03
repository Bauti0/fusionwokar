// ============================================================
// Validación del formulario de checkout — función PURA (sin DOM)
// ============================================================
// Extraída de Checkout.jsx (UX-01): el componente necesita saber cuál es
// el PRIMER campo inválido para hacer scroll suave hasta él y darle
// foco (el mensaje de error se renderiza al final de la página y en
// mobile quedaba lejos de donde el usuario tocó).
//
// Devuelve { field, message } con el primer problema según el orden del
// formulario, o null si todo está OK. `field` es la clave lógica del
// campo ("firstName" | "lastName" | "phone" | "email" | "address" |
// "schedule") que el checkout mapea al elemento del DOM a enfocar.
// ============================================================
import { isValidPhone, isValidEmail } from "./validation.js";
import { isOpenAtTime } from "./schedule.js";

export function validateCheckoutForm(
  {
    firstName = "",
    lastName = "",
    phone = "",
    email = "",
    address = "",
    paymentMethod = "efectivo",
    orderMode = "delivery",
    branchId = "",
    shipping = null,
    shippingError = "",
    scheduleMode = "asap",
    scheduledAt = "",
  },
  now = Date.now()
) {
  const isMp = paymentMethod === "mercadopago";
  const wantsDelivery = orderMode === "delivery";
  // La cotización automática del envío existe solo en Tandil.
  const quotesShipping = branchId === "tandil";

  // El orden ES el orden del formulario: con varios problemas a la vez,
  // se reporta el primero para que el checkout scrollee hasta ahí.
  if (!firstName.trim() || !lastName.trim()) {
    return { field: firstName.trim() ? "lastName" : "firstName", message: "Completá tu nombre y apellido para confirmar." };
  }
  if (!phone.trim()) {
    return { field: "phone", message: "Completá tu celular para confirmar." };
  }
  if (!isValidPhone(phone)) {
    return { field: "phone", message: "El celular no parece válido. Ej: 2262 555555." };
  }
  // El email solo lo pide Mercado Pago (lo usa como payer.email); con
  // efectivo o transferencia el campo ni se muestra ni se exige.
  if (isMp) {
    if (!email.trim()) {
      return { field: "email", message: "Ingresá tu email para confirmar el pedido." };
    }
    if (!isValidEmail(email)) {
      return { field: "email", message: "El email no parece válido. Ej: nombre@correo.com." };
    }
  }
  if (wantsDelivery && !address.trim()) {
    return { field: "address", message: "Ingresá tu dirección de entrega." };
  }
  if (wantsDelivery && quotesShipping) {
    if (address.trim().length < 8) {
      return { field: "address", message: "La dirección es muy corta. Ingresá la calle y el número." };
    }
    if (shippingError) {
      // Mercado Pago: sin costo final no se puede cobrar → se bloquea.
      if (isMp) {
        return { field: "address", message: shippingError };
      }
      // Efectivo/transferencia: se pasa con envío a confirmar por WhatsApp.
    } else if (!shipping) {
      return { field: "address", message: "Estamos calculando el costo de envío…" };
    }
  }
  if (scheduleMode === "scheduled") {
    if (!scheduledAt) {
      return { field: "schedule", message: "Elegí la fecha y hora para tu pedido." };
    }
    const when = new Date(scheduledAt);
    if (isNaN(when.getTime())) {
      return { field: "schedule", message: "Elegí una fecha y hora válidas." };
    }
    if (when.getTime() < now + 10 * 60000) {
      return { field: "schedule", message: "Elegí una hora con al menos 10 minutos de anticipación." };
    }
    if (!isOpenAtTime(branchId, when)) {
      return { field: "schedule", message: "Elegí una hora dentro de nuestra apertura para programar el pedido." };
    }
  }
  return null;
}
