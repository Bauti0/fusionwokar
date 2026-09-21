// ============================================================
// FUSIÓN WOK — Cliente de la API (fetch al backend)
// En desarrollo Vite redirige /api al servidor (proxy en vite.config)
// El admin se autentica con cookie httpOnly (sin token en localStorage)
// ============================================================

// Token CSRF de doble cookie: el backend emite fw_admin_csrf en el login del
// panel; este header viaja en cada petición que lo tenga. Un sitio ajeno no
// puede leer la cookie (same-origin policy), así que no puede forjar el header.
function csrfHeader() {
  if (typeof document === "undefined") return {};
  const m = document.cookie.match(/(?:^|;\s*)fw_admin_csrf=([^;]*)/);
  return m ? { "X-CSRF-Token": decodeURIComponent(m[1]) } : {};
}

async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...csrfHeader(), ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status}`);
    err.contactWhatsApp = !!data.contactWhatsApp;
    err.shippingPending = !!data.shippingPending;
    throw err;
  }
  return data;
}

// Cache del último payload por ruta para el polling condicional.
// Cada poll manda If-Modified-Since con el updatedAt conocido: si el pedido
// no cambió, el servidor responde 304 y se reutiliza el payload anterior
// (ahorra ancho de banda y round-trips a la BD en tracking/pago).
const lastPayloadPerPath = new Map();

async function pollRequest(path) {
  const prev = lastPayloadPerPath.get(path);
  const headers = prev && prev.updatedAt ? { "If-Modified-Since": prev.updatedAt } : {};
  const res = await fetch(path, { headers });
  if (res.status === 304) return prev;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  lastPayloadPerPath.set(path, data);
  return data;
}

// Crea un pedido (MP devuelve preferenceId/publicKey; WhatsApp queda "received")
export function createOrder(payload) {
  return request("/api/orders", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getOrder(id) {
  return pollRequest(`/api/orders/${id}`);
}

export function getOrderByNumber(orderNumber) {
  return pollRequest(`/api/orders/number/${encodeURIComponent(orderNumber)}`);
}

// Pedidos del cliente por teléfono ("Mis pedidos")
export function getOrdersByPhone(phone) {
  return request(`/api/orders/by-phone/${encodeURIComponent(phone)}`);
}

// Menú de una sucursal (fuente: BD, editable desde el panel)
export function getMenu(branchId) {
  return request(`/api/menu/${encodeURIComponent(branchId)}`);
}

// Registra un evento de analytics
export function trackEvent(type, branch = "") {
  return request("/api/events", {
    method: "POST",
    body: JSON.stringify({ type, branch }),
  });
}

// Demo: simula la aprobación/rechazo del pago. Requiere el demoToken que el
// backend entregó al crear ese pedido (solo el navegador que lo creó lo tiene).
export function simulatePayment(orderId, action, demoToken = "") {
  return request(`/api/payments/demo/${orderId}/${action}`, {
    method: "POST",
    body: JSON.stringify({ demoToken }),
  });
}

// ---- cupones (cliente) ----
export function validateCoupon(code, total) {
  return request("/api/coupons/validate", {
    method: "POST",
    body: JSON.stringify({ code, total }),
  });
}

// ---- envío (cliente) ----
// Calcula el costo de envío para una dirección. Solo Tandil responde con
// costo; Necochea devuelve { supported:false }.
export function shippingQuote(branch, address) {
  return request("/api/shipping/quote", {
    method: "POST",
    body: JSON.stringify({ branch, address }),
  });
}

// ---- admin (cookie httpOnly, sin token) ----
export function adminLogin(username, password) {
  return request("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function adminLogout() {
  return request("/api/admin/logout", { method: "POST" });
}

// Revoca todas las sesiones del panel (incluida la actual)
export function adminLogoutAll() {
  return request("/api/admin/logout-all", { method: "POST" });
}

export function adminMe() {
  return request("/api/admin/me");
}

export function adminOrders(params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v && v !== "all")
  ).toString();
  return request(`/api/admin/orders${qs ? `?${qs}` : ""}`);
}

export function adminOrder(id) {
  return request(`/api/admin/orders/${id}`);
}

export function adminSetStatus(id, status) {
  return request(`/api/admin/orders/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

// Fija el costo de envío de un pedido que quedó "a confirmar" por WhatsApp
export function adminSetShipping(id, cost, blocks) {
  return request(`/api/admin/orders/${id}/shipping`, {
    method: "POST",
    body: JSON.stringify({ cost, blocks }),
  });
}

export function adminStats(params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v)
  ).toString();
  return request(`/api/admin/stats${qs ? `?${qs}` : ""}`);
}

// ---- productos / menú (admin) ----
export function adminProducts() {
  return request("/api/admin/products");
}

export function adminCreateProduct(payload) {
  return request("/api/admin/products", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function adminUpdateProduct(id, payload) {
  return request(`/api/admin/products/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function adminToggleProduct(id, available) {
  return request(`/api/admin/products/${id}/available`, {
    method: "PATCH",
    body: JSON.stringify({ available }),
  });
}

export function adminDeleteProduct(id) {
  return request(`/api/admin/products/${id}`, { method: "DELETE" });
}

export function adminMoveProduct(id, dir) {
  return request(`/api/admin/products/${id}/move`, {
    method: "POST",
    body: JSON.stringify({ dir }),
  });
}

// ---- categorías / grupos (admin) ----
export function adminCreateCategory(payload) {
  return request("/api/admin/categories", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function adminRenameCategory(id, name) {
  return request(`/api/admin/categories/${id}`, {
    method: "PUT",
    body: JSON.stringify({ name }),
  });
}

export function adminDeleteCategory(id) {
  return request(`/api/admin/categories/${id}`, { method: "DELETE" });
}

export function adminMoveCategory(id, dir) {
  return request(`/api/admin/categories/${id}/move`, {
    method: "POST",
    body: JSON.stringify({ dir }),
  });
}

export function adminRenameGroup(payload) {
  return request("/api/admin/groups", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function adminDeleteGroup(payload) {
  return request("/api/admin/groups", {
    method: "DELETE",
    body: JSON.stringify(payload),
  });
}

// ---- cupones (admin) ----
export function adminCoupons() {
  return request("/api/admin/coupons");
}

export function adminCreateCoupon(payload) {
  return request("/api/admin/coupons", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function adminToggleCoupon(id, active) {
  return request(`/api/admin/coupons/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ active }),
  });
}

export function adminUpdateCoupon(id, payload) {
  return request(`/api/admin/coupons/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function adminDeleteCoupon(id) {
  return request(`/api/admin/coupons/${id}`, { method: "DELETE" });
}

// ---- imágenes (admin) ----
export function adminUploadImage(dataUrl) {
  return request("/api/admin/upload", {
    method: "POST",
    body: JSON.stringify({ dataUrl }),
  });
}

// ---- clientes (admin) ----
export function adminCustomers(params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v)
  ).toString();
  return request(`/api/admin/customers${qs ? `?${qs}` : ""}`);
}

// ---- ventas (admin) ----
export function adminSales(params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v)
  ).toString();
  return request(`/api/admin/sales${qs ? `?${qs}` : ""}`);
}

// ---- arqueo de caja (admin) ----
export function adminCashRegister(branch) {
  return request(`/api/admin/cash-register?branch=${encodeURIComponent(branch)}`);
}

export function adminOpenCashRegister(branch, openingAmount) {
  return request("/api/admin/cash-register/open", {
    method: "POST",
    body: JSON.stringify({ branch, openingAmount }),
  });
}

export function adminCloseCashRegister(id, closingCounted, notes) {
  return request(`/api/admin/cash-register/${id}/close`, {
    method: "POST",
    body: JSON.stringify({ closingCounted, notes }),
  });
}

// ---- carga manual de pedidos (admin) ----
export function adminCreateManualOrder(payload) {
  return request("/api/admin/orders/manual", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}