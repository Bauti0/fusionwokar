import { useEffect, useRef, useState } from "react";
import { formatPrice, lineTotal } from "../utils/format.js";
import { validateCoupon, shippingQuote } from "../api.js";
import { isValidPhone } from "../utils/validation.js";
import { isOpenAtTime, closedLabel } from "../utils/schedule.js";
import DateTimePicker from "./ui/DateTimePicker.jsx";

const PAYMENT_METHODS = [
  { id: "efectivo", label: "Efectivo" },
  { id: "transferencia", label: "Transferencia" },
  { id: "mercadopago", label: "Mercado Pago" },
];

// ============================================================
// Checkout
// 1) Delivery / Retiro (cambia horarios mostrados y pide
//    dirección solo si es delivery)
// 2) Datos del cliente
// 3) Cuándo querés el pedido (lo antes posible / programar)
// 4) Cupón de descuento (se valida server-side)
// 5) Método de pago
// Confirma el pedido armando el mensaje de WhatsApp al número
// de la sucursal correspondiente.
// ============================================================
export default function Checkout({ branch, cart, customer, orderMode, setOrderMode, onConfirm }) {
  const [name, setName] = useState(customer?.name || "");
  const [phone, setPhone] = useState(customer?.phone || "");
  // Autocompleta con la última dirección usada (guardada en el dispositivo)
  const [address, setAddress] = useState(customer?.address || "");
  const [deliveryNotes, setDeliveryNotes] = useState(customer?.notes || "");
  const [paymentMethod, setPaymentMethod] = useState("efectivo");
  const [scheduleMode, setScheduleMode] = useState("asap"); // "asap" | "scheduled"
  const [scheduledAt, setScheduledAt] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [coupon, setCoupon] = useState(null); // { code, discount, totalAfter }
  const [couponError, setCouponError] = useState("");
  const [couponBusy, setCouponBusy] = useState(false);
  const [shipping, setShipping] = useState(null); // { km, cost }
  const [shippingError, setShippingError] = useState("");
  const [shippingBusy, setShippingBusy] = useState(false);
  const shippingBusyRef = useRef(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const { items, total, count } = cart;
  const isMp = paymentMethod === "mercadopago";
  const wantsDelivery = orderMode === "delivery";
  const isTandil = branch.id === "tandil";
  const shippingCost = wantsDelivery ? shipping?.cost || 0 : 0;
  const finalTotal = (coupon ? coupon.totalAfter : total) + shippingCost;
  const discount = coupon ? coupon.discount : 0;

  // Cotización de envío con debounce (no satura la API). Espera una dirección
  // con un mínimo de texto y nunca encola una segunda consulta mientras una va
  // en curso. Si el servicio falla, conserva la última cotización válida.
  useEffect(() => {
    if (!wantsDelivery || !isTandil) {
      setShipping(null);
      setShippingError("");
      setShippingBusy(false);
      return;
    }
    const addr = address.trim();
    if (addr.length < 8) {
      setShipping(null);
      setShippingError("");
      setShippingBusy(false);
      return;
    }
    if (shippingBusyRef.current) return; // una consulta por vez
    setShippingBusy(true);
    setShippingError("");
    const t = setTimeout(async () => {
      shippingBusyRef.current = true;
      try {
        const res = await shippingQuote(branch.id, addr);
        setShipping({ blocks: res.blocks, cost: res.cost });
        setShippingError("");
      } catch (err) {
        setShippingError(err.message);
      } finally {
        shippingBusyRef.current = false;
        setShippingBusy(false);
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [wantsDelivery, isTandil, address, branch.id]);

  function minScheduled() {
    const d = new Date(Date.now() + 10 * 60000);
    d.setSeconds(0, 0);
    return d.toISOString().slice(0, 16);
  }

  async function applyCoupon() {
    const code = couponCode.trim();
    if (!code) return;
    setCouponBusy(true);
    setCouponError("");
    try {
      const res = await validateCoupon(code, total);
      setCoupon({ code: res.code, discount: res.discount, totalAfter: res.totalAfter });
      setCouponCode("");
    } catch (err) {
      setCoupon(null);
      setCouponError(err.message);
    } finally {
      setCouponBusy(false);
    }
  }

  async function handleConfirm() {
    if (!name.trim() || !phone.trim()) {
      setError("Completá tu nombre y celular para confirmar.");
      return;
    }
    if (!isValidPhone(phone)) {
      setError("El celular no parece válido. Ej: 2262 555555.");
      return;
    }
    if (orderMode === "delivery" && !address.trim()) {
      setError("Ingresá tu dirección de entrega.");
      return;
    }
    if (orderMode === "delivery" && isTandil) {
      if (shippingError) {
        setError(shippingError);
        return;
      }
      if (!shipping) {
        setError("Estamos calculando el costo de envío…");
        return;
      }
    }
    if (scheduleMode === "scheduled" && !scheduledAt) {
      setError("Elegí la fecha y hora para tu pedido.");
      return;
    }
    if (scheduleMode === "scheduled" && scheduledAt) {
      const when = new Date(scheduledAt);
      if (!isOpenAtTime(branch.id, when)) {
        setError("Elegí una hora dentro de nuestra apertura para programar el pedido.");
        return;
      }
    }
    setBusy(true);
    setError("");
    try {
      await onConfirm({
        customer: { name: name.trim(), phone: phone.trim() },
        orderMode,
        paymentMethod,
        address: orderMode === "delivery" ? address.trim() : "",
        deliveryNotes: orderMode === "delivery" ? deliveryNotes.trim() : "",
        shipping: wantsDelivery
          ? { cost: shipping?.cost || 0, blocks: shipping?.blocks || 0 }
          : { cost: 0, blocks: 0 },
        scheduledFor: scheduleMode === "scheduled" && scheduledAt
          ? new Date(scheduledAt).toISOString()
          : "",
        couponCode: coupon?.code || "",
      });
    } catch (err) {
      setError(err.message || "No se pudo confirmar el pedido.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="container">
        <h2 className="page__title">Confirmá tu pedido</h2>
        <p className="page__sub">{branch.name} · {branch.address}</p>

        <div className="checkout-section">
          <h3>
            <span className="num">1</span> Modalidad
          </h3>
          <div className="segment">
            <button
              type="button"
              className={orderMode === "delivery" ? "is-active" : ""}
              onClick={() => setOrderMode("delivery")}
            >
              🛵 Delivery
            </button>
            <button
              type="button"
              className={orderMode === "pickup" ? "is-active" : ""}
              onClick={() => setOrderMode("pickup")}
            >
              🥡 Para retirar
            </button>
          </div>
          <p className="hours-note">
            🕒 Horarios {orderMode === "delivery" ? "de entrega" : "de retiro"}:{" "}
            <strong>{branch.hours[orderMode]}</strong>
          </p>
          {closedLabel(branch.id) && (
            <p className="hours-note hours-note--warn">{closedLabel(branch.id)}.</p>
          )}
          {orderMode === "delivery" && branch.deliveryInfo && (
            <p className="hours-note">
              🛵 {branch.deliveryInfo}
            </p>
          )}
        </div>

        <div className="checkout-section">
          <h3>
            <span className="num">2</span> Tus datos
          </h3>
          <div className="field">
            <label htmlFor="checkout-name">Nombre</label>
            <input
              id="checkout-name"
              type="text"
              placeholder="Tu nombre"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="checkout-phone">Celular</label>
            <input
              id="checkout-phone"
              type="tel"
              inputMode="tel"
              placeholder="Ej: 2262 555555"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          {orderMode === "delivery" && (
            <div className="field">
              <label htmlFor="checkout-address">Dirección de entrega</label>
              <input
                id="checkout-address"
                type="text"
                placeholder="Calle, número, referencia…"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
              {isTandil && !shippingError && (
                <p className="hint">
                  {shippingBusy
                    ? "Calculando costo de envío…"
                    : shipping
                      ? `Envío: ${formatPrice(shipping.cost)}${shipping.blocks ? ` (aprox. ${shipping.blocks} cuadras)` : ""}`
                      : "Ingresá la dirección para calcular el envío."}
                </p>
              )}
              {isTandil && shippingError && <p className="form-error">{shippingError}</p>}
            </div>
          )}
          {orderMode === "delivery" && (
            <div className="field">
              <label htmlFor="checkout-notes">Observaciones para la entrega (opcional)</label>
              <textarea
                id="checkout-notes"
                rows={2}
                placeholder="Timbre roto, dejar en portería, entre calles, etc."
                value={deliveryNotes}
                onChange={(e) => setDeliveryNotes(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className="checkout-section">
          <h3>
            <span className="num">3</span> ¿Cuándo querés tu pedido?
          </h3>
          <div className="segment">
            <button
              type="button"
              className={scheduleMode === "asap" ? "is-active" : ""}
              onClick={() => setScheduleMode("asap")}
            >
              ⚡ Lo antes posible
            </button>
            <button
              type="button"
              className={scheduleMode === "scheduled" ? "is-active" : ""}
              onClick={() => setScheduleMode("scheduled")}
            >
              🕒 Programarlo
            </button>
          </div>
          {scheduleMode === "scheduled" && (
            <div className="field">
              <label>Fecha y hora</label>
              <DateTimePicker
                value={scheduledAt}
                onChange={setScheduledAt}
                min={minScheduled()}
                placeholder="Elegí fecha y hora"
                ariaLabel="Fecha y hora del pedido"
              />
              <p className="hint">Tu pedido se tomará para esa fecha y hora (mínimo 10 minutos).</p>
            </div>
          )}
        </div>

        <div className="checkout-section">
          <h3>
            <span className="num">4</span> Cupón de descuento
          </h3>
          {coupon ? (
            <div className="coupon-applied">
              <span>
                🏷️ Cupón <strong>{coupon.code}</strong> aplicado: −{formatPrice(coupon.discount)}
              </span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCoupon(null)}>
                Quitar
              </button>
            </div>
          ) : (
            <div className="coupon-input">
              <input
                type="text"
                placeholder="Tenés un cupón? Escribí el código"
                value={couponCode}
                onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
              />
              <button
                type="button"
                className="btn btn--ghost"
                onClick={applyCoupon}
                disabled={couponBusy || !couponCode.trim()}
              >
                {couponBusy ? "Validando…" : "Aplicar"}
              </button>
            </div>
          )}
          {couponError && <p className="form-error">{couponError}</p>}
        </div>

        <div className="checkout-section">
          <h3>
            <span className="num">5</span> Método de pago
          </h3>
          {PAYMENT_METHODS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`pay-option ${paymentMethod === m.id ? "is-active" : ""}`}
              onClick={() => setPaymentMethod(m.id)}
            >
              <span className="radio" />
              {m.label}
            </button>
          ))}
        </div>

        <div className="summary">
          {items.map((item) => (
            <div className="summary__row" key={item.key}>
              <span>
                {item.qty}× {item.name}
              </span>
              <span>{formatPrice(lineTotal(item))}</span>
            </div>
          ))}
          {discount > 0 && (
            <div className="summary__row">
              <span>Descuento ({coupon?.code})</span>
              <span>−{formatPrice(discount)}</span>
            </div>
          )}
          {wantsDelivery && isTandil && shippingCost > 0 && (
            <div className="summary__row">
              <span>Envío {shipping?.blocks ? `(~${shipping.blocks} cuadras)` : ""}</span>
              <span>{formatPrice(shippingCost)}</span>
            </div>
          )}
          <div className="summary__row summary__row--total">
            <span>Total ({count} items)</span>
            <span>{formatPrice(finalTotal)}</span>
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="trust-strip" aria-label="Garantías de tu pedido">
          <span>🔒 Pago seguro</span>
          <span>✅ Confirmación al instante</span>
          <span>🛵 Seguimiento en vivo</span>
        </div>

        <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
          <button
            className="btn btn--primary btn--block"
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy
              ? "Procesando…"
              : isMp
                ? "Pagar con Mercado Pago"
                : "Confirmar pedido por WhatsApp"}
          </button>
          {isMp && (
            <p className="hint">
              Pagás con Mercado Pago sin salir de la app. El pedido se confirma cuando se
              aprueba el pago.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}