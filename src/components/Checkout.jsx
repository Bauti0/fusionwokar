import { useEffect, useRef, useState } from "react";
import { formatPrice, lineTotal } from "../utils/format.js";
import { validateCoupon, shippingQuote } from "../api.js";
import { waLinkForUnpaidOrder } from "../utils/whatsapp.js";
import { validateCheckoutForm } from "../utils/checkoutValidation.js";
import { closedLabel, pauseNotice } from "../utils/schedule.js";
import { phonePlaceholderFor } from "../data/branches.js";
import { shouldCacheQuoteError } from "../utils/shippingCache.js";
import { getTotalLabel, isSubmitDisabled, decideSubmitAction } from "../utils/checkoutHelpers.js";
import { normalizeAddressKey } from "../utils/normalizeAddressKey.js";
import DateTimePicker from "./ui/DateTimePicker.jsx";
import { IconMoney, IconBank, IconCard } from "./ui/icons.jsx";

const PAYMENT_METHODS = [
  { id: "efectivo", label: "Efectivo", Icon: IconMoney, hint: "Contado al retirar o al recibir" },
  { id: "transferencia", label: "Transferencia", Icon: IconBank, hint: "CBU de la sucursal al confirmar" },
  { id: "mercadopago", label: "Mercado Pago", Icon: IconCard, hint: "Tarjeta, saldo o dinero en cuenta" },
];

// Caché cliente de cotizaciones: la misma dirección no se vuelve a consultar
// (el servicio de mapas tiene cuota diaria).
const QUOTE_CACHE_TTL = 10 * 60 * 1000;
const quoteCache = new Map(); // clave normalizada → { res | err, at }

// UX-01: mapeo del campo inválido (la clave lógica que devuelve
// validateCheckoutForm) al elemento del DOM al que hay que hacer scroll y
// dar foco. "schedule" apunta al DateTimePicker: su botón es lo focusable.
const FIELD_EL_IDS = {
  firstName: "checkout-first-name",
  lastName: "checkout-last-name",
  phone: "checkout-phone",
  email: "checkout-email",
  address: "checkout-address",
};

function fieldElFor(field) {
  if (field === "schedule") {
    const wrap = document.getElementById("checkout-schedule-field");
    return wrap?.querySelector("button") || wrap || null;
  }
  const id = FIELD_EL_IDS[field];
  return id ? document.getElementById(id) : null;
}

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
//
// `serverError` es el fallo del último intento de pedido, resuelto en
// StoreApp con el `code` que manda el backend. Se muestra acá, en el formulario
// (no como toast que se borra a los 3 s): si el pedido llegó a guardarse, se
// muestra también su número para que el cliente pueda escribir por WhatsApp
// con el número correcto, y se ofrece reintentar el link de pago si corresponde.
// ============================================================
export default function Checkout({
  branch,
  cart,
  customer,
  orderMode,
  setOrderMode,
  onConfirm,
  serverError = null,
  onClearServerError,
  onRetryPaymentLink,
  retryingLink = false,
  pause = null,
}) {
  // Nombre y apellido separados: Mercado Pago los quiere así (payer.first_name
  // / last_name) y el server compone el "Nombre Apellido" de siempre para no
  // romper el panel, el ticket ni el mensaje de WhatsApp. Nunca se "parte" un
  // nombre guardado: si el cliente ya compró con nombre único, los campos
  // arrancan vacíos y los completa.
  const [firstName, setFirstName] = useState(customer?.firstName || "");
  const [lastName, setLastName] = useState(customer?.lastName || "");
  const [phone, setPhone] = useState(customer?.phone || "");
  // Email del comprador: solo lo pide (y solo lo muestra) el pago con
  // Mercado Pago, que lo usa como payer.email; se guarda con el pedido para
  // que el local pueda contactar al cliente y se recuerda junto con el resto
  // de los datos para el próximo pedido.
  const [email, setEmail] = useState(customer?.email || "");
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
  const [shipping, setShipping] = useState(null); // { blocks, cost }
  const [shippingError, setShippingError] = useState("");
  const [shippingBusy, setShippingBusy] = useState(false);
  const [shippingCalculating, setShippingCalculating] = useState(false);
  const shippingBusyRef = useRef(false);
  const addressRef = useRef("");
  addressRef.current = address;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Candado síncrono para evitar doble submit (Enter + click, doble toque).
  // El estado `busy` de React no cambia hasta el siguiente render; este ref
  // se chequea y activa ANTES de cualquier await.
  const submittingRef = useRef(false);
  // UX-01: el mensaje de error (form-error) se renderiza al final de la
  // página, lejos del botón que el cliente toca. Con estos refs la vista
  // hace scroll suave hasta el campo inválido (o hasta el mensaje cuando no
  // hay un campo concreto) y le da foco al campo para que el teclado del
  // celular ya esté listo.
  const errorBoxRef = useRef(null); // <div class="form-error">
  const serverErrorBoxRef = useRef(null); // <div class="checkout-note--error">
  const pendingFieldRef = useRef(""); // campo inválido del error que se viene

  const { items, total, count } = cart;
  const isMp = paymentMethod === "mercadopago";
  const wantsDelivery = orderMode === "delivery";
  const isTandil = branch.id === "tandil";
  const shippingCost = wantsDelivery ? shipping?.cost || 0 : 0;
  const finalTotal = (coupon ? coupon.totalAfter : total) + shippingCost;
  const discount = coupon ? coupon.discount : 0;
  // El cálculo automático de envío falló del todo (servicio caído, saturación).
  // Para efectivo/transferencia se deja pasar con envío "a confirmar"; para
  // Mercado Pago se bloquea pero con la puerta de WhatsApp del local.
  const shippingUnavailable = wantsDelivery && isTandil && !!shippingError;
  const contactWaLink = `https://wa.me/${branch.whatsapp}?text=${encodeURIComponent(
    "Hola! Estoy haciendo un pedido pero no puedo calcular el envío automáticamente en la página. ¿Me pueden ayudar?"
  )}`;
  // Link de WhatsApp del pedido que YA quedó registrado en la base pero sin
  // pago. Incluye el número de pedido: sin él el local no encuentra la fila.
  const orderWaLink = serverError
    ? waLinkForUnpaidOrder(branch, { orderNumber: serverError.orderNumber, reason: serverError.message })
    : "";
  // La sucursal está pausada (el local frenó la toma de pedidos un rato).
  // El `until` ya vencido no bloquea: el server reabre solo al vencer y el
  // estado local también expira (StoreApp), pero por si el cliente quedó con
  // la pantalla abierta, el botón no se bloquea con una pausa vencida.
  const paused = !!pause?.paused && (pause.until == null || pause.until > Date.now());

  // Cotización de envío con debounce (no satura la API). Espera una dirección
  // con un mínimo de texto. La caché se consulta ANTES del debounce para
  // respuesta instantánea. AbortController cancela la consulta en vuelo si
  // cambia la dirección/sucursal/modalidad. Un timer de 8 s muestra
  // "Estamos calculando…" sin bloquear el formulario. AbortError se ignora.
  useEffect(() => {
    if (!wantsDelivery || !isTandil) {
      setShipping(null);
      setShippingError("");
      setShippingBusy(false);
      setShippingCalculating(false);
      return;
    }
    const addr = address.trim();
    if (addr.length < 8) {
      setShippingError("");
      setShippingBusy(false);
      setShippingCalculating(false);
      return;
    }

    // 1) Caché instantánea (antes del debounce)
    const key = normalizeAddressKey(addr);
    const hit = quoteCache.get(key);
    if (hit && Date.now() - hit.at < QUOTE_CACHE_TTL) {
      if (hit.err) setShippingError(hit.err);
      else setShipping(hit.res);
      setShippingError(hit.err || "");
      setShippingBusy(false);
      setShippingCalculating(false);
      return;
    }

    // 2) Debounce + fetch con AbortController
    let debounceTimer;
    let calculatingTimer;
    const controller = new AbortController();

    const startFetch = async () => {
      shippingBusyRef.current = true;
      setShippingBusy(true);
      setShippingError("");

      // Timer de 8 s para mensaje "calculando…"
      calculatingTimer = setTimeout(() => {
        if (!controller.signal.aborted) setShippingCalculating(true);
      }, 8000);

      try {
        const res = await shippingQuote(branch.id, addr, { signal: controller.signal });
        const data = { blocks: res.blocks, cost: res.cost };
        quoteCache.set(key, { res: data, at: Date.now() });
        // Solo aplicar si NO fue abortado y la dirección sigue siendo la actual
        if (!controller.signal.aborted && addressRef.current.trim() === addr) {
          setShipping(data);
          setShippingError("");
        }
      } catch (err) {
        // AbortError: consulta cancelada por cambio de dirección → no hacer nada
        if (err.name === "AbortError" || err.name === "CancellationError") return;
        const msg = err.message || "";
        if (shouldCacheQuoteError(err)) {
          quoteCache.set(key, { err: msg, at: Date.now() });
        }
        if (!controller.signal.aborted && addressRef.current.trim() === addr) {
          setShippingError(msg);
        }
      } finally {
        clearTimeout(calculatingTimer);
        if (!controller.signal.aborted) {
          shippingBusyRef.current = false;
          setShippingBusy(false);
          setShippingCalculating(false);
        }
      }
    };

    debounceTimer = setTimeout(startFetch, 1500);

    return () => {
      clearTimeout(debounceTimer);
      clearTimeout(calculatingTimer);
      controller.abort();
    };
  }, [wantsDelivery, isTandil, address, branch.id]);

  // UX-01: el <div class="form-error"> existe recién después del render que
  // muestra el error, así que el scroll se hace acá y no en el momento del
  // setError. Va al campo inválido si lo conocemos (falló la validación); si
  // no (falló la creación), baja hasta el mensaje. El foco usa
  // preventScroll para que el navegador no pise el scroll suave.
  useEffect(() => {
    if (!error) return;
    const field = pendingFieldRef.current;
    pendingFieldRef.current = "";
    const el = fieldElFor(field) || errorBoxRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
  }, [error]);

  // El error del último intento (p. ej. el link de Mercado Pago que no se
  // pudo generar) llega desde StoreApp y se muestra al final del checkout:
  // sin scroll, el cliente se queda mirando el botón sin ver qué falló.
  useEffect(() => {
    if (!serverError) return;
    serverErrorBoxRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [serverError]);

  // Mínimo "ahora + 10 min" en HORA LOCAL (no UTC): toISOString() corre el
  // reloj a UTC y a las 23h en Argentina el picker deshabilitaba el día de hoy.
  function minScheduled() {
    const d = new Date(Date.now() + 10 * 60000);
    d.setSeconds(0, 0);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  async function applyCoupon() {
    const code = couponCode.trim();
    if (!code) return;
    setCouponBusy(true);
    setCouponError("");
    try {
      const res = await validateCoupon(code, total, branch.id);
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
    // Candado síncrono: evita que Enter + click o doble toque pasen los dos.
    if (submittingRef.current) return;
    submittingRef.current = true;

    // Un intento nuevo borra el error del anterior: si sigue visible, el
    // cliente no puede distinguir si el botón funcionó.
    onClearServerError?.();
    // La validación vive en una función pura (ver test/checkout-validation.test.js):
    // devuelve el PRIMER campo inválido con su mensaje, en el mismo orden y
    // con los mismos textos que siempre. El efecto de [error] hace scroll
    // suave hasta el campo y le da foco.
    const invalid = validateCheckoutForm({
      firstName,
      lastName,
      phone,
      email,
      address,
      paymentMethod,
      orderMode,
      branchId: branch.id,
      shipping,
      shippingError,
      scheduleMode,
      scheduledAt,
    });
    if (invalid) {
      submittingRef.current = false;
      pendingFieldRef.current = invalid.field;
      setError(invalid.message);
      return;
    }

    // Bifurcación: si hay un pedido guardado con error reintentable y handler de reintento,
    // reintentamos el link de pago del pedido EXISTENTE (no creamos uno nuevo).
    // Regresión: antes el botón principal decidía en onClick; al pasar a type="submit"
    // con onSubmit único se perdió. decideSubmitAction restaura la decisión.
    const action = decideSubmitAction({ serverError, hasRetryHandler: !!onRetryPaymentLink });
    if (action === "retry") {
      submittingRef.current = false;
      await onRetryPaymentLink();
      return;
    }

    setBusy(true);
    setError("");
    try {
      await onConfirm({
        customer: {
          // "Nombre Apellido": lo que ya esperan el panel, el ticket y el
          // mensaje de WhatsApp. Además van separados para el payer de MP.
          name: `${firstName.trim()} ${lastName.trim()}`.trim(),
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone: phone.trim(),
          // El email solo es obligatorio para MP, pero si el cliente ya lo
          // había cargado se manda igual (lo valida el server si viene).
          email: email.trim(),
        },
        orderMode,
        paymentMethod,
        address: orderMode === "delivery" ? address.trim() : "",
        deliveryNotes: orderMode === "delivery" ? deliveryNotes.trim() : "",
        shipping: wantsDelivery
          ? { cost: shipping?.cost || 0, blocks: shipping?.blocks || 0, pending: shippingUnavailable && !isMp }
          : { cost: 0, blocks: 0, pending: false },
        // Se manda la hora local tal cual la devuelve el DateTimePicker
        // ("YYYY-MM-DDTHH:mm"): el server la interpreta en hora AR (parseArLocal)
        // y guarda el instante correcto sin depender de la zona del navegador.
        scheduledFor: scheduleMode === "scheduled" && scheduledAt ? scheduledAt : "",
        couponCode: coupon?.code || "",
        couponDiscount: coupon?.discount || 0,
      });
    } catch (err) {
      // Falló la creación y no hay un campo culpable: el scroll del efecto
      // va directo al mensaje de error.
      pendingFieldRef.current = "";
      setError(err.message || "No se pudo confirmar el pedido.");
    } finally {
      setBusy(false);
      submittingRef.current = false;
    }
  }

  return (
    <div className="page">
      <div className="container">
        <h2 className="page__title">Confirmá tu pedido</h2>
        <p className="page__sub">{branch.name} · {branch.address}</p>

        <form onSubmit={(e) => { e.preventDefault(); handleConfirm(); }} noValidate>
          <div className="checkout-section">
            <h3>
              <span className="num">1</span> Modalidad
            </h3>
            <div className="segment">
            <button
              type="button"
              className={orderMode === "delivery" ? "is-active" : ""}
              aria-pressed={orderMode === "delivery"}
              onClick={() => setOrderMode("delivery")}
            >
              🛵 Delivery
            </button>
            <button
              type="button"
              className={orderMode === "pickup" ? "is-active" : ""}
              aria-pressed={orderMode === "pickup"}
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
        </div>

        <div className="checkout-section">
          <h3>
            <span className="num">2</span> Tus datos
          </h3>
          <div className="field">
            <label htmlFor="checkout-first-name">Nombre</label>
            <input
              id="checkout-first-name"
              type="text"
              autoComplete="given-name"
              placeholder="Tu nombre"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="checkout-last-name">Apellido</label>
            <input
              id="checkout-last-name"
              type="text"
              autoComplete="family-name"
              placeholder="Tu apellido"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="checkout-phone">Celular</label>
            <input
              id="checkout-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder={phonePlaceholderFor(branch)}
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
                autoComplete="address-line1"
                placeholder="Calle, número, referencia…"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
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
              aria-pressed={scheduleMode === "asap"}
              onClick={() => setScheduleMode("asap")}
            >
              ⚡ Lo antes posible
            </button>
            <button
              type="button"
              className={scheduleMode === "scheduled" ? "is-active" : ""}
              aria-pressed={scheduleMode === "scheduled"}
              onClick={() => setScheduleMode("scheduled")}
            >
              🕒 Programarlo
            </button>
          </div>
          {scheduleMode === "scheduled" && (
            <div className="field" id="checkout-schedule-field">
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
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (e.target.value.trim() && !couponBusy) applyCoupon();
                  }
                }}
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
              <span className="pay-option__icon">
                <m.Icon />
              </span>
              <span className="pay-option__copy">
                <span className="pay-option__label">{m.label}</span>
                <span className="pay-option__hint">{m.hint}</span>
              </span>
              <span className="radio" />
            </button>
          ))}
          {/* Solo Mercado Pago necesita el email (viaja como payer.email a
              la order). Con efectivo o transferencia ni se muestra. Vive
              acá, junto al método que lo dispara, para que aparezca donde
              el cliente está mirando cuando lo marca. */}
          {isMp && (
            <div className="field">
              <label htmlFor="checkout-email">Email</label>
              <input
                id="checkout-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="nombre@correo.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <p className="hint">
                Lo usamos para el pago con Mercado Pago y para contactarte por tu pedido.
              </p>
            </div>
          )}
        </div>

        <div className="summary">
          {shippingCalculating && (
            <div className="checkout-note" role="status">
              Estamos calculando el envío, puede tardar unos segundos…
            </div>
          )}
          {shippingUnavailable && isMp && (
            <div className="checkout-note checkout-note--error">
              <span>No pudimos calcular el costo de envío: {shippingError}</span>
              <a className="btn btn--ghost btn--sm" href={contactWaLink} target="_blank" rel="noreferrer">
                💬 Escribinos por WhatsApp
              </a>
            </div>
          )}
          {shippingUnavailable && !isMp && (
            <div className="checkout-note" role="status">
              No pudimos calcular el envío automático — si es un problema temporal, te
              confirmamos el costo por WhatsApp antes de salir. Si tu dirección está
              fuera de la zona de reparto, no vamos a poder tomar el pedido.
            </div>
          )}
          {items.map((item) => (
            <div className="summary__row" key={item.key}>
              <span className="summary__item">
                {item.image && <img className="summary__thumb" src={item.image} alt="" />}
                <span>
                  {item.qty}× {item.name}
                </span>
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
          {shippingUnavailable && !isMp && (
            <div className="summary__row">
              <span>Envío</span>
              <span>a confirmar</span>
            </div>
          )}
          {shippingCost > 0 && (
            <div className="summary__row">
              <span>Envío</span>
              <span>{formatPrice(shippingCost)}</span>
            </div>
          )}
          <div className="summary__row summary__row--total">
            <span>
              {(() => {
                const { main, sub } = getTotalLabel({ count, shippingUnavailable, isMp });
                return sub ? (
                  <>
                    {main}
                    <br />
                    <small>{sub}</small>
                  </>
                ) : (
                  main
                );
              })()}
            </span>
            <span>{formatPrice(finalTotal)}</span>
          </div>
        </div>

        {error && (
          <div className="form-error" ref={errorBoxRef} role="alert">
            {error}
          </div>
        )}

        {serverError && (
          <div className="checkout-note checkout-note--error" role="alert" ref={serverErrorBoxRef}>
            <span>
              {serverError.message}
              {serverError.orderNumber && (
                <>
                  {" "}
                  Tu pedido quedó registrado con el número{" "}
                  <strong>{serverError.orderNumber}</strong>.
                </>
              )}
              {serverError.note && <> {serverError.note}</>}
            </span>
            <div className="checkout-note__actions">
              {serverError.orderNumber && serverError.canRetry && onRetryPaymentLink && (
                <button
                  className="btn btn--primary btn--sm"
                  onClick={onRetryPaymentLink}
                  disabled={retryingLink}
                >
                  {retryingLink ? "Generando link…" : "Reintentar el pago"}
                </button>
              )}
              {serverError.orderNumber && (
                <a
                  className="btn btn--ghost btn--sm"
                  href={orderWaLink}
                  target="_blank"
                  rel="noreferrer"
                >
                  💬 Resolver por WhatsApp
                </a>
              )}
            </div>
          </div>
        )}

        {paused && (
          <div className="checkout-note checkout-note--error" role="alert">
            <span>{pauseNotice(pause)}</span>
          </div>
        )}

        <div className="trust-strip" aria-label="Garantías de tu pedido">
          <span>🔒 Pago seguro</span>
          <span>✅ Confirmación al instante</span>
          <span>🛵 Seguimiento en vivo</span>
        </div>

        <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
          {/* Si el pedido YA se guardó, reenviar el formulario crearía un
              pedido DUPLICADO. En ese caso el botón principal reintenta el link
              del pedido existente, o queda deshabilitado si el fallo no es
              reintentable (credenciales inválidas de MP) y la salida es
              WhatsApp. */}
            <button
            type="submit"
            data-testid="checkout-submit"
            className="btn btn--primary btn--block"
            disabled={isSubmitDisabled({ busy, retryingLink, paused, serverError })}
          >
            {busy || retryingLink
              ? "Procesando…"
              : paused
                ? "Pedidos pausados"
                : serverError?.orderId && !serverError.canRetry
                  ? "Mercado Pago no disponible"
                  : serverError?.orderId
                    ? "Reintentar el pago"
                    : isMp
                      ? "Pagar con Mercado Pago"
                      : "Confirmar pedido por WhatsApp"}
          </button>
          {serverError?.orderId && !serverError.canRetry && (
            // Reenviar el checkout crearía otro pedido (el anterior ya está
            // guardado sin pago). La salida real es cambiar de medio de pago.
            <button
              type="button"
              className="btn btn--ghost btn--block"
              onClick={() => {
                onClearServerError?.();
                setPaymentMethod("efectivo");
              }}
            >
              Pedir en efectivo o por transferencia
            </button>
          )}
          {isMp && (
            <p className="hint">
              Pagás con Mercado Pago sin salir de la app. El pedido se confirma cuando se
              aprueba el pago.
            </p>
          )}
        </div>
      </form>
    </div>
  </div>
);
}
