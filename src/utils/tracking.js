// ============================================================
// FUSIÓN WOK — Tracking de eventos (analytics)
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