import { lazy, Suspense, useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import StoreApp from "./components/StoreApp.jsx";
import { adminMe } from "./api.js";
import { track } from "./utils/tracking.js";

// ============================================================
// FUSIÓN WOK — Router
//  /                     → tienda (menú, carrito, checkout, pago)
//  /track                → redirige a tienda con vista my-orders (state)
//  /track/:orderNumber   → seguimiento del pedido
//  /admin                → panel de gestión (login + pedidos)
//
// Admin y tracking se cargan bajo demanda (React.lazy): el bundle inicial
// queda solo con la tienda, que es lo que ve la mayoría de los visitantes.
// ============================================================

const AdminLogin = lazy(() => import("./components/AdminLogin.jsx"));
const AdminPanel = lazy(() => import("./components/AdminPanel.jsx"));
const TrackOrder = lazy(() => import("./components/TrackOrder.jsx"));

function PageFallback() {
  return (
    <div className="page">
      <div className="container">
        <p className="hint">Cargando…</p>
      </div>
    </div>
  );
}

export default function App() {
  // null = verificando sesión (cookie httpOnly) · false = anónimo ·
  // objeto = sesión válida. El objeto es lo que devuelve /api/admin/me
  // (user, role, branch): el panel lo usa para saber qué secciones
  // mostrar, aunque la separación real la aplica el backend.
  const [adminSession, setAdminSession] = useState(null);
  const location = useLocation();

  // Visita a la página (cada ruta)
  useEffect(() => {
    track("page_view");
  }, [location.pathname]);

  // Título dinámico por ruta (SEO + pestaña del navegador)
  useEffect(() => {
    const p = location.pathname;
    let title = "Fusión Wok · Pedidos online";
    if (p.startsWith("/admin")) title = "Panel de gestión · Fusión Wok";
    else if (p.startsWith("/track/")) {
      const num = p.split("/")[2];
      title = num ? `Pedido #${num} · Fusión Wok` : "Seguí tu pedido · Fusión Wok";
    } else if (p.startsWith("/track")) title = "Seguí tu pedido · Fusión Wok";
    document.title = title;
  }, [location.pathname]);

  // La sesión vive en la cookie httpOnly; se valida contra /me SOLO al
  // entrar a /admin (así la visita pública no genera un 401 en consola)
  useEffect(() => {
    if (!location.pathname.startsWith("/admin")) return;
    let alive = true;
    adminMe()
      .then((me) => alive && setAdminSession(me))
      .catch(() => alive && setAdminSession(false));
    return () => {
      alive = false;
    };
  }, [location.pathname]);

  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/" element={<StoreApp />} />
        <Route
          path="/track"
          element={<Navigate to="/" state={{ view: "my-orders" }} replace />} />
        <Route path="/track/:orderNumber" element={<TrackOrder />} />
        <Route
          path="/admin"
          element={
            adminSession === null ? (
              <PageFallback />
            ) : adminSession ? (
              <AdminPanel me={adminSession} onLogout={() => setAdminSession(false)} />
            ) : (
              // Tras el login se vuelve a consultar /me: el panel necesita
              // el rol y la sucursal de la sesión recién creada.
              <AdminLogin
                onLogin={() =>
                  adminMe()
                    .then((me) => setAdminSession(me))
                    .catch(() => setAdminSession(false))
                }
              />
            )
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}