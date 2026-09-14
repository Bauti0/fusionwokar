import { lazy, Suspense, useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import StoreApp from "./components/StoreApp.jsx";
import { adminMe } from "./api.js";
import { track } from "./utils/tracking.js";

// ============================================================
// FUSIÓN WOK — Router
//  /                     → tienda (menú, carrito, checkout, pago)
//  /track                → buscar pedido por número / mis pedidos
//  /track/:orderNumber   → seguimiento del pedido
//  /admin                → panel de gestión (login + pedidos)
//
// Admin y tracking se cargan bajo demanda (React.lazy): el bundle inicial
// queda solo con la tienda, que es lo que ve la mayoría de los visitantes.
// ============================================================

const AdminLogin = lazy(() => import("./components/AdminLogin.jsx"));
const AdminPanel = lazy(() => import("./components/AdminPanel.jsx"));
const TrackOrder = lazy(() => import("./components/TrackOrder.jsx"));
const TrackHome = lazy(() => import("./components/TrackHome.jsx"));

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
  // null = verificando sesión (cookie httpOnly) · true/false = autenticado
  const [adminAuthed, setAdminAuthed] = useState(null);
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
      .then(() => alive && setAdminAuthed(true))
      .catch(() => alive && setAdminAuthed(false));
    return () => {
      alive = false;
    };
  }, [location.pathname]);

  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/" element={<StoreApp />} />
        <Route path="/track" element={<TrackHome />} />
        <Route path="/track/:orderNumber" element={<TrackOrder />} />
        <Route
          path="/admin"
          element={
            adminAuthed === null ? (
              <PageFallback />
            ) : adminAuthed ? (
              <AdminPanel onLogout={() => setAdminAuthed(false)} />
            ) : (
              <AdminLogin onLogin={() => setAdminAuthed(true)} />
            )
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}