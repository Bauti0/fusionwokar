import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import ErrorBoundary from "./components/ui/ErrorBoundary.jsx";
import { RootFallback } from "./components/ui/ErrorFallbacks.jsx";
import { checkCrashRoot } from "./hooks/useCrashTest.js";
import "./styles/global.css";
import "./styles/error-boundaries.css";

// ============================================================
// Global error handlers para errores que NO atrapan los Error Boundaries:
// - Event handlers (onClick, onChange, etc.)
// - setTimeout / setInterval callbacks
// - Promesas no atrapadas (unhandledrejection)
// ============================================================
let globalErrorShown = false;
const MAX_GLOBAL_ERRORS = 3;
let globalErrorCount = 0;

// Rate limiting: mapa errorKey -> { count, windowStart }
const errorRateLimit = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minuto
const RATE_LIMIT_MAX = 3; // máximo 3 por minuto por error

function getErrorKey(ev) {
  // Usar filename + lineno + colno + message como clave
  const filename = ev.filename || (ev.error && ev.error.stack) || "";
  const msg = ev.message || (ev.error && ev.error.message) || "";
  const lineno = ev.lineno || 0;
  const colno = ev.colno || 0;
  return `${filename}:${lineno}:${colno}:${msg}`.slice(0, 200);
}

function isOwnOriginError(ev) {
  const filename = ev.filename || (ev.error && ev.error.stack) || "";
  // Ignorar errores de extensiones del navegador
  if (filename.startsWith("chrome-extension://") || filename.startsWith("moz-extension://") || filename.startsWith("safari-extension://")) {
    return false;
  }
  // Ignorar errores sin filename (suelen ser de extensiones o scripts inyectados)
  if (!filename || filename === "") {
    return false;
  }
  // Solo errores de nuestro origen (http/https de nuestro dominio, o archivo local en dev)
  // En desarrollo Vite usa http://localhost:5173 o archivo://
  // En producción nuestros assets están en el mismo origen
  return true;
}

function shouldShowError(ev) {
  const key = getErrorKey(ev);
  const now = Date.now();
  const entry = errorRateLimit.get(key);

  if (!entry) {
    errorRateLimit.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    // Ventana nueva
    errorRateLimit.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count < RATE_LIMIT_MAX) {
    entry.count++;
    return true;
  }

  // Rate limit excedido: no mostrar ni loggear
  return false;
}

function showGlobalErrorMessage() {
  if (globalErrorShown || globalErrorCount >= MAX_GLOBAL_ERRORS) return;
  globalErrorShown = true;
  globalErrorCount++;

  // Toast no bloqueante usando el sistema existente si está disponible,
  // o un fallback simple
  const el = document.createElement("div");
  el.className = "global-error-toast";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.textContent = "Algo no salió bien, probá de nuevo";
  Object.assign(el.style, {
    position: "fixed",
    bottom: "24px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "var(--color-primary-soft, #fdecea)",
    color: "var(--color-danger-text, #e5342e)",
    border: "1px solid rgba(229, 52, 46, 0.25)",
    borderRadius: "12px",
    padding: "12px 20px",
    fontSize: "14px",
    fontWeight: "600",
    zIndex: 9999,
    boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
    animation: "slideUp 0.3s ease-out",
  });

  // Agregar keyframes si no existen
  if (!document.getElementById("global-error-styles")) {
    const style = document.createElement("style");
    style.id = "global-error-styles";
    style.textContent = `
      @keyframes slideUp {
        from { opacity: 0; transform: translateX(-50%) translateY(20px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
      .global-error-toast { animation: slideUp 0.3s ease-out; }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(el);
  setTimeout(() => {
    el.style.animation = "slideUp 0.3s ease-out reverse";
    setTimeout(() => el.remove(), 300);
    globalErrorShown = false;
  }, 4000);
}

if (typeof window !== "undefined") {
  // Errores síncronos en event handlers, timeouts, etc.
  window.addEventListener("error", (ev) => {
    // Ignorar errores que no sean de nuestro origen (extensiones, etc.)
    if (!isOwnOriginError(ev)) {
      return;
    }
    // Rate limiting
    if (!shouldShowError(ev)) {
      return;
    }
    console.error("Global error:", ev.error || ev.message, ev.filename, ev.lineno, ev.colno);
    showGlobalErrorMessage();
  });

  // Promesas rechazadas sin catch
  window.addEventListener("unhandledrejection", (ev) => {
    // Para unhandledrejection, ev.reason puede tener stack
    const fakeEv = {
      filename: (ev.reason && ev.reason.stack) || "",
      message: (ev.reason && ev.reason.message) || String(ev.reason),
      lineno: 0,
      colno: 0,
      error: ev.reason,
    };
    // Ignorar errores que no sean de nuestro origen
    if (!isOwnOriginError(fakeEv)) {
      return;
    }
    // Rate limiting
    if (!shouldShowError(fakeEv)) {
      return;
    }
    console.error("Unhandled rejection:", ev.reason);
    showGlobalErrorMessage();
    // No prevenimos el default para que siga apareciendo en consola
  });
}

// ============================================================
// Detección de errores de chunk loading (lazy/Suspense)
// Si falla la carga de un chunk tras un deploy, recargar UNA vez
// ============================================================
if (typeof window !== "undefined") {
  const CHUNK_RETRY_KEY = "fw.chunkRetry";

  window.addEventListener("error", (ev) => {
    const msg = ev.message || (ev.error && ev.error.message) || "";
    // Detectar "Failed to fetch dynamically imported module" o "Loading chunk failed"
    if (
      msg.includes("Loading chunk") ||
      msg.includes("dynamically imported module") ||
      msg.includes("Failed to fetch") ||
      (ev.error && ev.error.name === "ChunkLoadError")
    ) {
      console.error("Chunk load error detected:", msg);
      try {
        const retried = sessionStorage.getItem(CHUNK_RETRY_KEY);
        if (!retried) {
          sessionStorage.setItem(CHUNK_RETRY_KEY, "1");
          window.location.reload();
        } else {
          sessionStorage.removeItem(CHUNK_RETRY_KEY);
        }
      } catch {
        // sessionStorage no disponible
      }
    }
  }, true); // Capturar en fase de captura para atrapar antes que React
}

// ============================================================
// Crash test root (solo DEV): ?crash=root
// ============================================================
checkCrashRoot();

const root = ReactDOM.createRoot(document.getElementById("root"), {
  onRecoverableError: (error, errorInfo) => {
    // En desarrollo, loggear para depurar hidratación
    if (import.meta.env.DEV) {
      console.warn("React hydration recoverable error:", error, errorInfo);
    }
    // No hacer nada: React intentará recuperarse solo
  },
});

root.render(
  <React.StrictMode>
    <BrowserRouter>
      <ErrorBoundary fallback={RootFallback} resetKeys={[window.location.pathname]}>
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>
);