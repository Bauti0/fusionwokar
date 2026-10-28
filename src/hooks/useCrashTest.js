// ============================================================
// useCrashTest — Modo de prueba SOLO DEV para verificar Error Boundaries
// Lee ?crash=<nombre> del URL y lanza un error en el componente que lo use.
// En producción (import.meta.env.DEV === false) no hace nada (tree-shaking).
// ============================================================
import { useEffect } from "react";

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

// Hook para usar dentro de componentes funcionales
export function useCrashTest(target) {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const crash = getCrashParam();
    if (crash && CRASH_TARGETS[crash] === target) {
      setTimeout(() => {
        throw new Error(`[CrashTest] Forzado: ${target}`);
      }, 0);
    }
  }, [target]);
}

// ============================================================
// Check functions — Llamar JUSTO ANTES de renderizar el ErrorBoundary
// para que el error se tire DENTRO del boundary y lo atrape.
// ============================================================

function check(target) {
  if (!import.meta.env.DEV) return;
  const crash = getCrashParam();
  if (crash && CRASH_TARGETS[crash] === target) {
    setTimeout(() => {
      throw new Error(`[CrashTest] Forzado: ${target}`);
    }, 0);
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