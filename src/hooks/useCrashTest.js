// ============================================================
// useCrashTest — Modo de prueba SOLO DEV para verificar Error Boundaries
// Lee ?crash=<nombre> del URL y lanza un error SINCRÓNICO durante el render
// para que el ErrorBoundary lo atrape.
// En producción (import.meta.env.DEV === false) no hace nada (tree-shaking).
// ============================================================

const CRASH_TARGETS = {
  // StoreApp sections
  cart: "cart",
  checkout: "checkout",
  menu: "menu",
  myorders: "myorders",
  success: "success",
  payment: "payment",
  paymentresult: "paymentresult",
  root: "root",
  // Admin sections
  admin: "admin",
  orders: "orders",
  stats: "stats",
  products: "products",
  extras: "extras",
  coupons: "coupons",
  customers: "customers",
  sales: "sales",
  users: "users",
  neworder: "neworder",
  track: "track",
  // Route level
  store: "store",
};

function getCrashParam() {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get("crash")?.toLowerCase();
}

// ============================================================
// Check functions — Llamar DENTRO del render, ANTES del ErrorBoundary
// Lanza error SINCRÓNICO para que el ErrorBoundary lo atrape.
// ============================================================

function check(target) {
  if (!import.meta.env.DEV) return;
  const crash = getCrashParam();
  if (crash && CRASH_TARGETS[crash] === target) {
    // Lanzar SINCRÓNICAMENTE durante el render para que el ErrorBoundary lo atrape
    throw new Error(`[CrashTest] Forzado: ${target}`);
  }
}

// Root level (main.jsx)
export function checkCrashRoot() { check("root"); }

// Route level (App.jsx)
export function checkCrashStore() { check("store"); }
export function checkCrashTrack() { check("track"); }
export function checkCrashAdmin() { check("admin"); }

// StoreApp section level (StoreApp.jsx)
export function checkCrashMenu() { check("menu"); }
export function checkCrashCart() { check("cart"); }
export function checkCrashCheckout() { check("checkout"); }
export function checkCrashMyOrders() { check("myorders"); }
export function checkCrashSuccess() { check("success"); }
export function checkCrashPayment() { check("payment"); }
export function checkCrashPaymentResult() { check("paymentresult"); }

// AdminPanel section level (AdminPanel.jsx)
export function checkCrashOrders() { check("orders"); }
export function checkCrashStats() { check("stats"); }
export function checkCrashProducts() { check("products"); }
export function checkCrashExtras() { check("extras"); }
export function checkCrashCoupons() { check("coupons"); }
export function checkCrashCustomers() { check("customers"); }
export function checkCrashSales() { check("sales"); }
export function checkCrashUsers() { check("users"); }
export function checkCrashNewOrder() { check("neworder"); }

// Hook para usar dentro de componentes funcionales (si se necesita)
export function useCrashTest(target) {
  if (!import.meta.env.DEV) return;
  const crash = getCrashParam();
  if (crash && CRASH_TARGETS[crash] === target) {
    throw new Error(`[CrashTest] Forzado: ${target}`);
  }
}