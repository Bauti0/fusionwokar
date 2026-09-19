import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getOrderByNumber } from "../api.js";
import { BRANCHES } from "../data/branches.js";
import {
  ORDER_STATUSES,
  STATUS_CANCELLED,
  STATUS_PENDING_PAYMENT,
  statusLabel,
  statusEmoji,
  statusIndex,
  paymentLabel,
} from "../constants.js";
import { formatPrice } from "../utils/format.js";
import TrackHeader from "./TrackHeader.jsx";

// ============================================================
// TrackOrder — seguimiento del pedido por número (FW-00001)
// Auto-actualiza cada 6 segundos. Muestra la línea de tiempo
// del estado y el estado del pago.
// ============================================================

// Estados terminales: no tiene sentido seguir consultando después.
function isTerminal(o) {
  return o.status === STATUS_CANCELLED.id || o.status === "completed" || o.paymentStatus === "rejected";
}

export default function TrackOrder() {
  const { orderNumber } = useParams();
  const [order, setOrder] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const o = await getOrderByNumber(orderNumber);
      setOrder(o);
      setNotFound(false);
      if (isTerminal(o)) clearTimer();
    } catch (err) {
      // Solo un 404 real (pedido inexistente) muestra el estado "no encontrado".
      // Errores transitorios (servidor caído, límite de rate, red) NO deben
      // borrar el pedido que ya teníamos cargado: se reintenta en el próximo poll.
      if (err.message === "Pedido no encontrado") {
        setNotFound(true);
        clearTimer();
      }
    }
  }, [orderNumber]);

  function clearTimer() {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }

  useEffect(() => {
    load();
    timer.current = setInterval(load, 6000);
    return clearTimer;
  }, [load]);

  if (notFound) {
    return (
      <div className="app">
        <TrackHeader />
        <div className="page">
          <div className="container">
            <div className="success">
              <div className="success__icon">?</div>
              <h1>Pedido no encontrado</h1>
              <p>
                No encontramos ningún pedido con el número <strong>{orderNumber}</strong>.
              </p>
              <Link className="btn btn--primary btn--block" to="/">
                Volver a la tienda
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="app">
        <TrackHeader />
        <div className="page">
          <div className="container">
            <div className="success">
              <div className="success__icon">…</div>
              <h1>Cargando pedido…</h1>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const branch = BRANCHES[order.branch];
  const cancelled = order.status === STATUS_CANCELLED.id;
  const pendingPay = order.status === STATUS_PENDING_PAYMENT.id;
  const current = statusIndex(order.status);

  return (
    <div className="app">
      <TrackHeader />
      <div className="page">
        <div className="container">
          <div className="track-head">
            <h2 className="page__title">
              {statusEmoji(order.status)} Seguimiento
            </h2>
            <p className="page__sub">
              Pedido <strong>{order.orderNumber}</strong> · {branch?.name}
            </p>
        </div>

        <div className="track-card">
          <div className="track-card__status">
            <span className="track-card__emoji">{statusEmoji(order.status)}</span>
            <div>
              <strong>{statusLabel(order.status)}</strong>
              <small>
                Pago: {paymentLabel(order.paymentStatus)}
                {order.paymentMethod === "mercadopago" ? " (Mercado Pago)" : " (en el local)"}
              </small>
            </div>
          </div>

          {cancelled && (
            <div className="track-cancelled">Este pedido fue cancelado.</div>
          )}
          {pendingPay && (
            <div className="track-cancelled">
              El pedido se confirma cuando se acredite el pago.
            </div>
          )}

          {!cancelled && !pendingPay && (
            <div className="track-checklist">
              {ORDER_STATUSES.map((s, i) => {
                const done = i <= current;
                return (
                  <div key={s.id} className={`track-check ${done ? "is-done" : ""}`}>
                    <span className="track-check__mark">{done ? "✓" : "○"}</span>
                    <span className="track-check__label">{s.label}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="track-card">
          <h3>Detalle</h3>
          <div className="summary">
            {order.items.map((item) => (
              <div className="summary__row" key={item.key || `${item.productId}-${item.name}`}>
                <span>
                  {item.qty}× {item.name}
                </span>
                <span>{formatPrice(item.unitPrice * item.qty)}</span>
              </div>
            ))}
            <div className="summary__row summary__row--total">
              <span>Total</span>
              <span>{formatPrice(order.total)}</span>
            </div>
          </div>
        </div>

        <div className="track-card">
          <h3>Entrega</h3>
          <p className="track-line">
            Modalidad: {order.orderMode === "delivery" ? "🛵 Delivery" : "🥡 Retiro en el local"}
          </p>
          <p className="track-line">Dirección local: {branch?.address}</p>
        </div>

        {branch && (
          <a
            className="btn btn--whatsapp btn--block"
            href={`https://wa.me/${branch.whatsapp}?text=${encodeURIComponent(
              `¡Hola! Tengo una consulta sobre mi pedido ${order.orderNumber}`
            )}`}
            target="_blank"
            rel="noreferrer"
          >
            💬 Contactar por WhatsApp
          </a>
        )}
        <div style={{ marginTop: 10 }}>
          <Link className="btn btn--primary btn--block" to="/">
            Volver a la tienda
          </Link>
        </div>
        <div style={{ marginTop: 10 }}>
          <Link className="btn btn--ghost btn--block" to="/track">
            📋 Ver mis pedidos
          </Link>
        </div>
      </div>
    </div>
  </div>
  );
}