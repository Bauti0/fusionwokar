import { useEffect, useRef, useState } from "react";
import { getOrder, simulatePayment } from "../api.js";
import useDialogA11y from "../hooks/useDialogA11y.js";
import { BRAND } from "../data/branches.js";
import { waLinkForUnpaidOrder } from "../utils/whatsapp.js";
import { formatPrice } from "../utils/format.js";

// ============================================================
// PaymentModal — pago con Mercado Pago dentro del flujo
// - Modo real: la Orders API de MP no se puede embeber (no hay
//   Brick que acepte un order id), así que el pago ocurre en el
//   checkout alojado por Mercado Pago: redirigimos al
//   checkout_url y el cliente vuelve con ?pago=<resultado>&pedido=<nro>.
// - Modo demo (sin credenciales): botones "Simular pago".
// Mientras el pago está pendiente se hace polling al backend
// hasta que el webhook (o la simulación) actualice el estado.
// ============================================================

export default function PaymentModal({ orderId, orderNumber, demo, checkoutUrl, demoToken, total, branch, onResult, onCancel }) {
  const [phase, setPhase] = useState(demo ? "demo" : "ready");
  const [result, setResult] = useState(null);
  const [slow, setSlow] = useState(false); // el pago tarda más de lo normal
  const [pollError, setPollError] = useState(""); // el polling se cortó
  const [redirecting, setRedirecting] = useState(false);
  const mounted = useRef(true);
  const pollTimer = useRef(null);
  const slowTimer = useRef(null);
  const failCount = useRef(0);
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
    setPollError("");
    failCount.current = 0;
    clearInterval(pollTimer.current);
    clearTimeout(slowTimer.current);
    // Si pasan ~90 s sin que el pago se resuelva, avisamos (el webhook puede
    // llegar tarde, y el server también reconcilia contra la API de MP).
    slowTimer.current = setTimeout(() => {
      if (mounted.current) setSlow(true);
    }, 90000);
    pollTimer.current = setInterval(async () => {
      try {
        const order = await getOrder(orderId);
        failCount.current = 0;
        if (mounted.current) setPollError("");
        if (
          order.paymentStatus === "approved" ||
          order.paymentStatus === "rejected" ||
          order.paymentStatus === "refunded"
        ) {
          clearInterval(pollTimer.current);
          clearTimeout(slowTimer.current);
          if (mounted.current) setResult(order);
        }
      } catch (err) {
        // Antes el catch era un comentario y el intervalo seguía para siempre
        // sin decir nada: el cliente veía un modal girando indefinidamente,
        // sin saber si había que esperar o si el pago se había perdido.
        // Ahora se corta y se ofrece una salida.
        failCount.current += 1;
        if (failCount.current >= 6 && mounted.current) {
          clearInterval(pollTimer.current);
          clearTimeout(slowTimer.current);
          setPollError(err.message || "No pudimos consultar el estado del pago.");
        }
      }
    }, 2500);
  }

  useEffect(() => {
    if (!result) return;
    clearTimeout(slowTimer.current);
    const t = setTimeout(() => onResult?.(result), 1200);
    return () => clearTimeout(t);
  }, [result, onResult]);

  // Demo: simular aprobación o rechazo
  async function handleSimulate(action) {
    setPhase("simulating");
    try {
      await simulatePayment(orderId, action, demoToken);
      startPolling();
      setPhase("polling");
    } catch (err) {
      setPhase("demo");
    }
  }

  // Redirección al checkout de Mercado Pago. Se dispara sola a los 2 s: el
  // flujo estándar de Checkout Pro es que el cliente pague en el entorno de
  // MP y vuelva. El botón queda por si el navegador bloquea la navegación.
  useEffect(() => {
    if (demo || !checkoutUrl) return;
    const t = setTimeout(() => {
      if (mounted.current) goToCheckout();
    }, 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, checkoutUrl]);

  function goToCheckout() {
    if (redirecting) return;
    setRedirecting(true);
    window.location.href = checkoutUrl;
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
          <img src={BRAND.logo} alt={BRAND.name} />
        </div>
        <h3 id="payment-title">Pagá tu pedido {orderNumber}</h3>
        <p className="payment-card__sub">
          {demo ? "MODO DEMO · sin Mercado Pago" : "Mercado Pago · pago seguro"}
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
            <div className="payment-redirect">
              {total ? (
                <p className="payment-redirect__total">
                  Total a pagar: <strong>{formatPrice(total)}</strong>
                </p>
              ) : null}
              {checkoutUrl ? (
                <>
                  <p>
                    Te llevamos al checkout de <strong>Mercado Pago</strong> para
                    completar el pago. Volvés acá automáticamente cuando termines.
                  </p>
                  <button
                    className="btn btn--primary btn--block"
                    onClick={goToCheckout}
                    disabled={redirecting}
                  >
                    {redirecting ? "Abriendo Mercado Pago…" : "💳 Pagar con Mercado Pago"}
                  </button>
                </>
              ) : (
                <p className="form-error">
                  No se pudo generar el link de pago. Volvé al checkout e intentá
                  de nuevo.
                </p>
              )}
            </div>
          )}
        </div>

        {pollError && (
          <div className="payment-slow" role="alert">
            <p>
              {pollError} Si ya completaste el pago, no te preocupes: se confirma
              solo. Podés cerrar esta ventana y ver el estado desde el seguimiento
              del pedido.
            </p>
            <a
              className="btn btn--ghost btn--sm"
              href={waLinkForUnpaidOrder(branch, { orderNumber })}
              target="_blank"
              rel="noreferrer"
            >
              💬 Escribinos por WhatsApp
            </a>
          </div>
        )}

        {slow && !pollError && (
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

        {demo && (
          <button className="btn btn--ghost btn--block" onClick={onCancel}>
            Cancelar
          </button>
        )}
        {!demo && (
          <button className="btn btn--ghost btn--block" onClick={onCancel} disabled={redirecting}>
            Volver al checkout
          </button>
        )}
      </div>
    </div>
  );
}
