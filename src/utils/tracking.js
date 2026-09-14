// ============================================================
// FUSIÓN WOK — Tracking de eventos (analytics)
// Registra eventos básicos en el backend (sin datos personales):
//   page_view, product_view, checkout_started, order_created
// ============================================================

// Envía un evento al backend (fire-and-forget, nunca rompe la UI)
export function track(type, branch) {
  try {
    const b =
      branch ||
      (typeof window !== "undefined" ? localStorage.getItem("fw.lastBranch") || "" : "");
    fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, branch: b }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* sin backend o sin conexión: ignorar */
  }
}