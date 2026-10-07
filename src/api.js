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

// Error de API con TODO el contexto que manda el backend. Antes se perdía casi
// todo: el frontend solo leía `error` y dos flags, así que un fallo al generar
// el link de pago (503) se mostraba con el mensaje de "no pudimos calcular el
// envío" y el cliente nunca veía el número de pedido que ya se había guardado.
class ApiError extends Error {
  constructor(message, { status = 0, code = "", orderId = null, orderNumber = "", contactWhatsApp = false, retryable = false, pause = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.orderId = orderId;
    this.orderNumber = orderNumber;
    this.contactWhatsApp = contactWhatsApp;
    this.retryable = retryable;
    // Estado de pausa de la sucursal cuando el server rechaza con 423
    // (orders_paused): el checkout lo usa para actualizar el aviso al
    // instante, sin una segunda request.
    this.pause = pause;
  }
}

// Si la respuesta no es JSON (página de error de un proxy, 502 de Render, un
// corte de conexión con HTML) `data` queda vacío y el mensaje era el inútil
// "Error 502". Esto le dice al cliente qué hacer sin inventar nada del server.
function networkMessage(status) {
  if (status === 429) return "Demasiados intentos. Esperá un momento e intentá de nuevo.";
  if (status >= 500) return "El servidor está teniendo problemas. Probá de nuevo en un momento.";
  return "No pudimos conectarnos con el servidor. Revisá tu conexión a internet.";
}

function toApiError(data, status) {
  return new ApiError(data?.error || networkMessage(status), {
    status,
    code: data?.code || "",
    orderId: data?.orderId ?? null,
    orderNumber: data?.orderNumber || "",
    contactWhatsApp: !!data?.contactWhatsApp,
    retryable: !!data?.retryable,
    pause: data?.pause || null,
  });
}

async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...csrfHeader(), ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw toApiError(data, res.status);
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
  // Mismo error tipado que el resto: el tracking y el polling del pago pueden
  // mostrar el mensaje real del server en vez de "Error 500".
  if (!res.ok) throw toApiError(data, res.status);
  lastPayloadPerPath.set(path, data);
  return data;
}

// Crea un pedido (MP devuelve el checkoutUrl para redirigir al pago; WhatsApp
// queda "received")
export function createOrder(payload) {
  return request("/api/orders", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getOrder(id) {
  return pollRequest(`/api/orders/${id}`);
}

// Reintenta generar el link de pago de un pedido que quedó guardado pero sin
// order de MP. Evita que el cliente tenga que reenviar el checkout y duplicar
// el pedido. Devuelve el mismo contrato de error que la creación (code,
// orderNumber, retryable) para que el checkout muestre lo mismo.
export function retryPaymentLink(orderId) {
  return request(`/api/orders/${orderId}/payment-link`, { method: "POST" });
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

// Estado de pausa de pedidos de todas las sucursales (público). Lo pide
// solo la landing, para avisar "Pausado" antes de entrar a un menú:
// { branches: { <id>: { paused, until, message } } }
export function getPause() {
  return request("/api/pause");
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
// `branch` es la sucursal del pedido: un cupón local de la otra sucursal
// no valida. La validación definitiva se hace server-side al crear el pedido.
export function validateCoupon(code, total, branch) {
  return request("/api/coupons/validate", {
    method: "POST",
    body: JSON.stringify({ code, total, branch }),
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

// Historial de cambios (auditoría) de un pedido. SOLO superadmin: el
// server responde 403 al branch_admin, por eso el panel nunca lo llama
// sin ese rol.
export function adminOrderAudit(id) {
  return request(`/api/admin/orders/${id}/audit`);
}

export function adminSetStatus(id, status) {
  return request(`/api/admin/orders/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

// Edita tipo de entrega / medio de pago / dirección / envío de un pedido.
// `changes` es un subconjunto de { orderMode, paymentMethod, address,
// shippingCost }. El backend valida las reglas y responde 400 con el mensaje
// en español (ApiError.message), que el panel muestra tal cual.
export function adminEditOrder(id, changes) {
  return request(`/api/admin/orders/${id}`, {
    method: "PATCH",
    body: JSON.stringify(changes),
  });
}

// Fija el costo de envío de un pedido que quedó "a confirmar" por WhatsApp
export function adminSetShipping(id, cost, blocks) {
  return request(`/api/admin/orders/${id}/shipping`, {
    method: "POST",
    body: JSON.stringify({ cost, blocks }),
  });
}

// Devuelve dinero de un pedido pagado con Mercado Pago. Sin `amount` devuelve
// todo lo que queda del pedido; con `amount`, esa parte.
export function adminRefund(id, amount) {
  return request(`/api/admin/orders/${id}/refund`, {
    method: "POST",
    body: JSON.stringify({ amount }),
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

// ---- pausa de pedidos por sucursal (admin) ----
// Estado de pausa de las sucursales visibles para la sesión: un
// branch_admin recibe solo la suya, el superadmin las dos. Mismo shape
// que el público: { branches: { <id>: { paused, until, message } } }.
export function adminBranchPause() {
  return request("/api/admin/branch-pause");
}

// Pausa o reanuda. Pausar: { branch, action: "pause", minutes } o
// { branch, action: "pause", indefinite: true }, con `message` opcional.
// Reanudar: { branch, action: "resume" }. El branch_admin manda su
// sucursal igual: el server la ignora y usa la de la sesión.
export function adminSetBranchPause(payload) {
  return request("/api/admin/branch-pause", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

// ---- cuentas de admin por sucursal (solo superadmin) ----
export function adminUsers() {
  return request("/api/admin/users");
}

export function adminCreateUser(payload) {
  return request("/api/admin/users", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function adminSetUserPassword(id, password) {
  return request(`/api/admin/users/${id}/password`, {
    method: "PUT",
    body: JSON.stringify({ password }),
  });
}

export function adminSetUserActive(id, active) {
  return request(`/api/admin/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ active }),
  });
}

// Borrar una cuenta de sucursal (definitivo, solo superadmin).
export function adminDeleteUser(id) {
  return request(`/api/admin/users/${id}`, { method: "DELETE" });
}