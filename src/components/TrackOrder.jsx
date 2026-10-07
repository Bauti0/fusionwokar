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
import { buildOrderSummaryRows } from "../utils/orderSummary.js";
import TrackHeader from "./TrackHeader.jsx";
import { IconPhone, IconArrowLeft, IconClockOutline } from "./ui/icons.jsx";

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
  // Tono del estado (mismo lenguaje de color que el admin): ámbar en
  // curso, verde avanzado, rojo solo para cancelado. Se usa para la
  // burbuja del emoji y para el nombre del estado.
  const statusTone = cancelled
    ? "danger"
    : ["ready", "out_for_delivery", "completed"].includes(order.status)
      ? "success"
      : "warn";

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
            <div className={`track-card__status is-${statusTone}`}>
              <span className={`track-card__emoji track-status-bubble track-status-bubble--${statusTone}`}>
                {statusEmoji(order.status)}
              </span>
              <div>
                <strong>{statusLabel(order.status)}</strong>
                <small>
                  {/* Badge de pago con color de estado (aprobado/pending/
                      rejected/refunded → badge--pay-*, igual que en admin). */}
                  <span className={`badge badge--pay-${order.paymentStatus}`}>
                    Pago: {paymentLabel(order.paymentStatus)}
                  </span>
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
                  // El próximo paso pendiente lleva tinte ámbar: dice
                  // "acá estamos" sin leerse como error (nunca rojo).
                  // NO destacamos "preparing" como "next" cuando el estado es
                  // "received" y el pago ya está aprobado: el pedido está
                  // confirmado pero la cocina aún no arrancó; no hay un paso
                  // "activo" hasta que el estado pase a "preparing".
                  const isReceivedWithApprovedPay =
                    order.status === "received" && order.paymentStatus === "approved";
                  const next = !done && i === current + 1 && current >= 1 && !isReceivedWithApprovedPay;
                  return (
                    <div key={s.id} className={`track-check ${done ? "is-done" : ""} ${next ? "is-next" : ""}`}>
                      <span className="track-check__mark">{done ? "✓" : next ? "◐" : "○"}</span>
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
              {(() => {
                const { rows } = buildOrderSummaryRows(order);
                return rows.map((row, idx) => {
                  const key = row.type ? `${row.type}-${idx}` : `${row.name}-${row.qty}-${idx}`;
                  if (row.type === "total") {
                    return (
                      <div className="summary__row summary__row--total" key={key}>
                        <span>{row.label}</span>
                        <span>{formatPrice(row.amount)}</span>
                      </div>
                    );
                  }
                  if (row.type === "discount") {
                    return (
                      <div className="summary__row" key={key}>
                        <span>{row.label}</span>
                        <span>−{formatPrice(-row.amount)}</span>
                      </div>
                    );
                  }
                  if (row.type === "shipping") {
                    return (
                      <div className="summary__row" key={key}>
                        <span>{row.label}</span>
                        <span>{row.pending ? "a confirmar" : formatPrice(row.amount)}</span>
                      </div>
                    );
                  }
                  // Item con extras
                  return (
                    <div className="summary__row" key={key}>
                      <span>
                        {row.qty}× {row.name}
                        {row.extras?.length
                          ? <>
                              {row.extras.map((e) => (
                                <span key={e.label} className="summary__extra">
                                  {"\n"}
                                  - {e.label} {formatPrice(e.lineTotal)}
                                </span>
                              ))}
                            </>
                          : ""}
                      </span>
                      <span>{formatPrice(row.lineTotal)}</span>
                    </div>
                  );
                });
              })()}
            </div>
          </div>

          <section className="track-delivery" aria-labelledby="delivery-heading">
            <h3 id="delivery-heading">Entrega</h3>
            <div className="track-delivery__lines">
              <p className="track-delivery__line">
                <span className="track-delivery__label">Modalidad:</span>
                <span className="track-delivery__value">
                  {order.orderMode === "delivery" ? "🛵 Delivery" : "🥡 Retiro en el local"}
                </span>
              </p>
              <p className="track-delivery__line">
                <span className="track-delivery__label">Dirección:</span>
                <span className="track-delivery__value">{branch?.address}</span>
              </p>
            </div>
          </section>

          {branch && (
            <a
              className="btn btn--whatsapp-dark btn--block"
              href={`https://wa.me/${branch.whatsapp}?text=${encodeURIComponent(
                `¡Hola! Tengo una consulta sobre mi pedido ${order.orderNumber}`
              )}`}
              target="_blank"
              rel="noreferrer"
            >
              <IconPhone className="btn__icon" width="20" height="20" />
              Contactar por WhatsApp
            </a>
          )}
          <div className="track-actions">
            <Link className="btn btn--secondary btn--block" to="/">
              <IconArrowLeft className="btn__icon" width="20" height="20" />
              Volver a la tienda
            </Link>
            <Link className="btn btn--secondary btn--block" to="/track">
              <IconClockOutline className="btn__icon" width="20" height="20" />
              Ver mis pedidos
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}