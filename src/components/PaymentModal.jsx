import { useEffect, useRef, useState } from "react";
import { getOrder, simulatePayment } from "../api.js";
import useDialogA11y from "../hooks/useDialogA11y.js";

// ============================================================
// PaymentModal — pago con Mercado Pago dentro del flujo
// - Modo real: Wallet Brick con redirectMode "modal" (no se
//   sale de la app para pagar).
// - Modo demo (sin credenciales): botones "Simular pago".
// Mientras el pago está pendiente se hace polling al backend
// hasta que el webhook (o la simulación) actualice el estado.
// ============================================================

export default function PaymentModal({ orderId, orderNumber, demo, publicKey, preferenceId, onResult, onCancel }) {
  const [phase, setPhase] = useState(demo ? "demo" : "loading");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [slow, setSlow] = useState(false); // el pago tarda más de lo normal
  const mounted = useRef(true);
  const brickContainer = useRef(null);
  const pollTimer = useRef(null);
  const slowTimer = useRef(null);
  const dialogRef = useDialogA11y({ onClose: onCancel });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearInterval(pollTimer.current);
      clearTimeout(slowTimer.current);
    };
  }, []);

  // Polling del estado del pago
  function startPolling() {
    setSlow(false);
    clearInterval(pollTimer.current);
    clearTimeout(slowTimer.current);
    // Si pasan ~90 s sin que el pago se resuelva, avisamos (el webhook puede
    // llegar tarde). El polling sigue corriendo por si se aprueba/rechaza.
    slowTimer.current = setTimeout(() => {
      if (mounted.current) setSlow(true);
    }, 90000);
    pollTimer.current = setInterval(async () => {
      try {
        const order = await getOrder(orderId);
        if (order.paymentStatus === "approved" || order.paymentStatus === "rejected") {
          clearInterval(pollTimer.current);
          clearTimeout(slowTimer.current);
          if (mounted.current) setResult(order);
        }
      } catch {
        /* reintenta */
      }
    }, 2500);
  }

  useEffect(() => {
    if (!result) return;
    clearTimeout(slowTimer.current);
    const t = setTimeout(() => onResult?.(result), 1200);
    return () => clearTimeout(t);
  }, [result, onResult]);

  // Modo real: cargar el SDK y crear el Wallet Brick en modal
  useEffect(() => {
    if (demo || !publicKey || !preferenceId) return;

    async function loadBrick() {
      if (!window.MercadoPago) {
        const src = "https://sdk.mercadopago.com/js/v2";
        await new Promise((resolve, reject) => {
          if (document.querySelector(`script[src="${src}"]`)) return resolve();
          const s = document.createElement("script");
          s.src = src;
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
      }
      if (!mounted.current) return;
      const mp = new window.MercadoPago(publicKey, { locale: "es-AR" });
      try {
        await mp.bricks().create("wallet", brickContainer.current, {
          initialization: { preferenceId, redirectMode: "modal" },
          callbacks: {
            onReady: () => mounted.current && setPhase("ready"),
            onError: (err) => {
              if (mounted.current) {
                setPhase("error");
                setError(err?.message || "No se pudo iniciar el pago.");
              }
            },
          },
        });
        startPolling();
      } catch (err) {
        if (mounted.current) {
          setPhase("error");
          setError(err?.message || "No se pudo iniciar el pago.");
        }
      }
    }

    setPhase("loading");
    loadBrick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, publicKey, preferenceId, orderId]);

  // Demo: simular aprobación o rechazo
  async function handleSimulate(action) {
    setPhase("simulating");
    setError("");
    try {
      await simulatePayment(orderId, action);
      startPolling();
      setPhase("polling");
    } catch (err) {
      setError(err.message);
      setPhase("demo");
    }
  }

  if (result) {
    return null; // el padre muestra la pantalla de resultado
  }

  return (
    <div className="payment-overlay">
      <div
        className="payment-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="payment-card__brand">
          <img src="/assets/logo-wok.jpeg" alt="Fusión Wok" />
        </div>
        <h3 id="payment-title">Pagá tu pedido {orderNumber}</h3>
        <p className="payment-card__sub">
          Mercado Pago · sin salir de la app
        </p>

        <div className="payment-body">
          {demo && (
            <div className="demo-mode">
              <div className="demo-mode__badge">MODO DEMO</div>
              <p>
                No hay credenciales de Mercado Pago configuradas. Simulá el pago
                para probar el flujo completo.
              </p>
              <div className="demo-mode__actions">
                <button className="btn btn--primary" disabled={phase === "simulating" || phase === "polling"} onClick={() => handleSimulate("approve")}>
                  {phase === "polling" ? "Procesando…" : "✅ Simular pago aprobado"}
                </button>
                <button className="btn btn--ghost" disabled={phase === "simulating" || phase === "polling"} onClick={() => handleSimulate("reject")}>
                  Simular rechazo
                </button>
              </div>
            </div>
          )}

          {!demo && (
            <>
              <div
                ref={brickContainer}
                className={`wallet-brick ${phase === "ready" ? "is-ready" : ""}`}
              />
              {phase === "loading" && <p className="hint">Preparando el pago…</p>}
              {phase === "error" && <p className="form-error">{error}</p>}
            </>
          )}
        </div>

        {error && <p className="form-error">{error}</p>}

        {slow && (
          <div className="payment-slow" role="status">
            <p>
              Esto está tardando más de lo normal. Si ya completaste el pago, esperá
              un poco más; si no, podés cerrar e intentarlo de nuevo.
            </p>
            <button className="btn btn--ghost btn--sm" onClick={onCancel}>
              Cerrar e intentar de nuevo
            </button>
          </div>
        )}

        <button className="btn btn--ghost btn--block" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}