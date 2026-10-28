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
};

function getCrashParam() {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get("crash")?.toLowerCase();
}

export function useCrashTest(target) {
  // Solo en DEV y solo si el target coincide con ?crash=
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const crash = getCrashParam();
    if (crash && CRASH_TARGETS[crash] === target) {
      // Lanzar error en el próximo tick para que lo atrape el ErrorBoundary
      setTimeout(() => {
        throw new Error(`[CrashTest] Forzado: ${target}`);
      }, 0);
    }
  }, [target]);
}

// Helper para componentes de clase (ErrorBoundary root)
export function checkCrashRoot() {
  if (!import.meta.env.DEV) return;
  const crash = getCrashParam();
  if (crash === "root") {
    setTimeout(() => {
      throw new Error("[CrashTest] Forzado: root");
    }, 0);
  }
}

// Helper para AdminRouteFallback
export function checkCrashAdmin() {
  if (!import.meta.env.DEV) return;
  const crash = getCrashParam();
  if (crash === "admin") {
    setTimeout(() => {
      throw new Error("[CrashTest] Forzado: admin");
    }, 0);
  }
}

// Helper para TrackRoute
export function checkCrashTrack() {
  if (!import.meta.env.DEV) return;
  const crash = getCrashParam();
  if (crash === "track") {
    setTimeout(() => {
      throw new Error("[CrashTest] Forzado: track");
    }, 0);
  }
}