// ============================================================
// Fallbacks para los Error Boundaries por nivel
// ============================================================
import { useEffect, useState } from "react";

// ============================================================
// Helpers
// ============================================================
function shortErrorCode() {
  // Código corto: fecha/hora + 6 chars aleatorios para que el cliente
  // lo pueda dictar por WhatsApp
  const now = new Date();
  const stamp = now.toISOString().slice(2, 19).replace(/[-T:]/g, "");
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${stamp}-${rand}`;
}

function clearCartAndReload() {
  try {
    // Borra solo la clave del carrito (por sucursal)
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("fw.cart."));
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    // localStorage no disponible
  }
  window.location.reload();
}

// ============================================================
// Root Fallback — Pantalla completa amable (mobile-first)
// ============================================================
export function RootFallback({ error, reset, errorInfo }) {
  const code = shortErrorCode();
  const isDev = import.meta.env.DEV;

  return (
    <div className="error-root" role="alert">
      <div className="error-root__card">
        <div className="error-root__icon" aria-hidden="true">😕</div>
        <h1 className="error-root__title">Algo salió mal</h1>
        <p className="error-root__msg">
          No es culpa tuya. La aplicación se encontró con un error inesperado.
        </p>
        <p className="error-root__code" title={code}>Código: {code}</p>
        {isDev && error && (
          <details className="error-root__dev" open>
            <summary>Detalles técnicos (solo desarrollo)</summary>
            <pre className="error-root__stack">
              {error.message}
              {errorInfo?.componentStack && `\n\n${errorInfo.componentStack}`}
            </pre>
          </details>
        )}
        <div className="error-root__actions">
          <button className="btn btn--primary btn--block" onClick={() => window.location.reload()}>
            Recargar la página
          </button>
          <button className="btn btn--ghost btn--block" onClick={clearCartAndReload}>
            Vaciar carrito y recargar
          </button>
          <button className="btn btn--ghost btn--block" onClick={reset}>
            Reintentar aquí
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Route Fallback — Para cada ruta principal
// ============================================================
export function RouteFallback({ error, reset, errorInfo, routeName }) {
  const isDev = import.meta.env.DEV;

  return (
    <div className="error-route" role="alert">
      <div className="error-route__card">
        <div className="error-route__icon" aria-hidden="true">⚠️</div>
        <h2>No se pudo cargar {routeName || "esta sección"}</h2>
        <p>Probá recargar o volver a la página anterior.</p>
        {isDev && error && (
          <details className="error-route__dev">
            <summary>Detalles técnicos</summary>
            <pre>{error.message}</pre>
          </details>
        )}
        <div className="error-route__actions">
          <button className="btn btn--primary" onClick={reset}>Reintentar</button>
          <button className="btn btn--ghost" onClick={() => window.history.back()}>
            Volver
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Section Fallback — Tarjeta chica en el lugar de la sección
// ============================================================
export function SectionFallback({ error, reset, errorInfo, sectionName }) {
  const isDev = import.meta.env.DEV;

  return (
    <div className="error-section" role="alert">
      <div className="error-section__card">
        <span className="error-section__icon" aria-hidden="true">🔧</span>
        <strong>No se pudo mostrar {sectionName || "esta sección"}</strong>
        {isDev && error && (
          <details className="error-section__dev">
            <summary>Detalles</summary>
            <pre>{error.message}</pre>
          </details>
        )}
        <button className="btn btn--ghost btn--sm" onClick={reset}>
          Reintentar
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Admin Route Fallback — Con reintento automático y límite
// ============================================================
export function AdminRouteFallback({ error, reset, errorInfo }) {
  const isDev = import.meta.env.DEV;
  const [retryCount, setRetryCount] = useState(0);
  const [showFixed, setShowFixed] = useState(false);
  const [autoRetrying, setAutoRetrying] = useState(false);

  // Contador en sessionStorage: máx 3 reintentos por minuto
  const STORAGE_KEY = "fw.admin.retryCount";
  const WINDOW_KEY = "fw.admin.retryWindow";

  useEffect(() => {
    if (showFixed) return;

    const now = Date.now();
    try {
      const windowStart = Number(sessionStorage.getItem(WINDOW_KEY) || "0");
      const count = Number(sessionStorage.getItem(STORAGE_KEY) || "0");

      // Si pasó más de 1 minuto, resetear ventana
      if (now - windowStart > 60000) {
        sessionStorage.setItem(WINDOW_KEY, String(now));
        sessionStorage.setItem(STORAGE_KEY, "0");
        setRetryCount(0);
      } else {
        setRetryCount(count);
      }
    } catch {
      // sessionStorage no disponible
    }
  }, [showFixed]);

  const handleAutoRetry = () => {
    if (showFixed) return;

    const now = Date.now();
    try {
      const windowStart = Number(sessionStorage.getItem(WINDOW_KEY) || "0");
      let count = Number(sessionStorage.getItem(STORAGE_KEY) || "0");

      if (now - windowStart > 60000) {
        count = 0;
        sessionStorage.setItem(WINDOW_KEY, String(now));
      }

      if (count >= 3) {
        setShowFixed(true);
        setAutoRetrying(false);
        return;
      }

      count += 1;
      sessionStorage.setItem(STORAGE_KEY, String(count));
      setRetryCount(count);
      setAutoRetrying(true);

      // Reintento a los 5 segundos remontando el panel
      setTimeout(() => {
        setAutoRetrying(false);
        reset(); // Esto remonta el ErrorBoundary y vuelve a renderizar AdminPanel
      }, 5000);
    } catch {
      // Si falla sessionStorage, no reintentamos automáticamente
      setShowFixed(true);
    }
  };

  // Auto-retry al montar (si no se alcanzó el límite)
  useEffect(() => {
    if (!showFixed && retryCount < 3) {
      handleAutoRetry();
    }
  }, []); // Solo al montar

  return (
    <div className="error-admin" role="alert">
      <div className="error-admin__card">
        <div className="error-admin__icon" aria-hidden="true">🔴</div>
        <h2>El panel de cocina se desconectó</h2>
        <p>
          {showFixed
            ? "Se alcanzó el límite de reintentos automáticos."
            : autoRetrying
            ? `Reintentando en 5 segundos… (intento ${retryCount + 1}/3)`
            : "Intentando reconectar…"}
        </p>
        {isDev && error && (
          <details className="error-admin__dev">
            <summary>Detalles técnicos</summary>
            <pre>{error.message}</pre>
          </details>
        )}
        <div className="error-admin__actions">
          {!showFixed && (
            <button className="btn btn--primary btn--block" onClick={reset} disabled={autoRetrying}>
              {autoRetrying ? "Reintentando…" : "Reintentar ahora"}
            </button>
          )}
          {showFixed && (
            <button className="btn btn--primary btn--block" onClick={() => window.location.reload()}>
              Recargar la página
            </button>
          )}
        </div>
      </div>
    </div>
  );
}