import { Link } from "react-router-dom";
import { formatPrice } from "../utils/format.js";

// ============================================================
// PaymentResult — pantalla de aprobado / pendiente / rechazado
// Muestra el número de pedido y el acceso al seguimiento.
// ============================================================

export default function PaymentResult({ order, branch, onHome }) {
  const approved = order?.paymentStatus === "approved";
  const pending = order?.paymentStatus === "pending";
  const rejected = order?.paymentStatus === "rejected";

  return (
    <div className="page">
      <div className="container">
        <div className={`success payment-result payment-result--${approved ? "ok" : rejected ? "ko" : "wait"}`}>
          <div className="success__icon">
            {approved ? "✓" : rejected ? "✕" : "…"}
          </div>
          <h1>
            {approved
              ? "Pago aprobado"
              : rejected
                ? "Pago rechazado"
                : "Pago pendiente"}
          </h1>
          <p>
            {approved && (
              <>
                Tu pedido <strong>{order?.orderNumber}</strong> para <strong>{branch?.name}</strong> está confirmado.
                Ya lo estamos preparando. Vas a poder seguirlo desde el link de seguimiento.
              </>
            )}
            {rejected && (
              <>
                No pudimos procesar el pago de tu pedido <strong>{order?.orderNumber}</strong>.
                Volvé al carrito y reintentá, o elegí otro método de pago.
              </>
            )}
            {pending && (
              <>
                Estamos esperando la confirmación de tu pago del pedido <strong>{order?.orderNumber}</strong>.
                En cuanto se acredite, lo confirmamos automáticamente.
              </>
            )}
          </p>

          {order && (approved || pending) && (
            <div className="payment-result__meta">
              <div>
                <span>Pedido</span>
                <strong>{order.orderNumber}</strong>
              </div>
              <div>
                <span>Total</span>
                <strong>{formatPrice(order.total)}</strong>
              </div>
            </div>
          )}

          <div style={{ display: "grid", gap: 10 }}>
            {(approved || pending) && (
              <Link className="btn btn--primary btn--block" to={`/track/${order?.orderNumber}`}>
                📍 Seguir mi pedido
              </Link>
            )}
            {rejected && (
              <button className="btn btn--primary btn--block" onClick={onHome}>
                Volver al menú
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}