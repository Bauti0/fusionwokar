// ============================================================
// FUSIÓN WOK — Tracking de eventos (analytics) + utilidades puras
// Registra eventos básicos en el backend (sin datos personales):
//   page_view, product_view, checkout_started, order_created
// ============================================================

// ID anónimo persistente por dispositivo: permite contar personas únicas
// (visitantes), no solo vistas netas. Se guarda en localStorage.
function getVisitorId() {
  try {
    let id = localStorage.getItem("fw.visitorId");
    if (!id) {
      id =
        (crypto && crypto.randomUUID
          ? crypto.randomUUID()
          : "v-" + Date.now().toString(36) + Math.random().toString(36).slice(2));
      localStorage.setItem("fw.visitorId", id);
    }
    return id;
  } catch {
    /* sin storage: evento sin visitante */
    return "";
  }
}

// Envía un evento al backend (fire-and-forget, nunca rompe la UI)
export function track(type, branch) {
  try {
    const b =
      branch ||
      (typeof window !== "undefined" ? localStorage.getItem("fw.lastBranch") || "" : "");
    fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, branch: b, visitor_id: getVisitorId() }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* sin backend o sin conexión: ignorar */
  }
}

// ============================================================
// getDeliveryInfo — decide qué mostrar en la sección "Entrega"
// Con verificación de teléfono para delivery:
//   - Si verificado: { showAddress: true, address: "...", modalityLabel }
//   - Si delivery sin verificar: { showAddress: false, showVerifyLink: true, modalityLabel }
//   - Si pickup: { showAddress: false, modalityLabel }
//   - Si desconocido: { showAddress: false, modalityLabel: "—" }
// NO expone dirección del cliente sin verificación. El branch NO viene
// en la API pública (E-01): no se usa como fallback.
// ============================================================
export function getDeliveryInfo(order, branch) {
  const mode = order?.orderMode;
  if (mode === "delivery") {
    if (order.verifiedAddress !== undefined) {
      // Ya se intentó verificar (éxito o fallo): mostrar dirección si hay
      return {
        showAddress: !!order.verifiedAddress,
        address: order.verifiedAddress || "",
        modalityLabel: "🛵 Delivery",
      };
    }
    // Sin verificar: mostrar link para pedir teléfono
    return {
      showAddress: false,
      showVerifyLink: true,
      modalityLabel: "🛵 Delivery",
    };
  }
  if (mode === "pickup") {
    // Branch NO viene en la respuesta pública (E-01): no mostrar dirección
    // para evitar datos equivocados. Solo indicamos la modalidad.
    return { showAddress: false, modalityLabel: "🥡 Retiro en el local" };
  }
  // Modalidad desconocida/faltante: no asumimos nada
  return { showAddress: false, modalityLabel: "—" };
}

// Obtiene el teléfono guardado localmente (fw.customer o fw.lookupPhone)
// para intento automático de verificación. Devuelve null si no hay.
export function getStoredPhoneForVerify() {
  try {
    const customer = JSON.parse(localStorage.getItem("fw.customer") || "null");
    if (customer?.phone) return customer.phone;
  } catch {
    /* ignore */
  }
  try {
    const lookup = localStorage.getItem("fw.lookupPhone");
    if (lookup) return lookup;
  } catch {
    /* ignore */
  }
  return null;
}