import { useEffect, useRef } from "react";
import { formatPriceCompact, lineTotal } from "../utils/format.js";
import { track } from "../utils/tracking.js";
import Tooltip from "./ui/Tooltip.jsx";
import { IconCart, IconTrash } from "./ui/icons.jsx";
import FadeImage from "./FadeImage.jsx";

// ============================================================
// Carrito como bottom-sheet: se abre sobre el menú sin sacarte del
// contexto de compra (antes era una página entera). Lista de items,
// edición de cantidades, resumen de totales y botón al checkout.
// ============================================================
export default function CartView({ cart, branch, onCheckout, onBack }) {
  const { items = [], updateQty, removeItem, subtotal = 0, extrasTotal = 0, total = 0, count = 0 } = cart || {};
  const sheetRef = useRef(null);

  // Bloquea el scroll de fondo mientras el drawer está abierto
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const handleBack = () => {
    const sheet = sheetRef.current;
    if (!sheet) { onBack(); return; }
    // Guarda para evitar doble llamada (transitionend + timeout)
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      onBack();
    };
    sheet.classList.add("drawer--closing");
    const onEnd = (e) => {
      if (e.target !== sheet) return;
      sheet.removeEventListener("transitionend", onEnd);
      finish();
    };
    sheet.addEventListener("transitionend", onEnd);
    // Fallback si transitionend no dispara
    setTimeout(finish, 300);
  };

  return (
    <div data-testid="cart-drawer" className="drawer" role="dialog" aria-modal="true" aria-label="Tu pedido">
      <div className="drawer__backdrop" onClick={handleBack} />
      <div className="drawer__sheet" ref={sheetRef}>
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">Tu pedido</h2>
            <p className="drawer__branch">{branch?.name || "Sucursal"}</p>
          </div>
          <button className="drawer__close" onClick={onBack} aria-label="Cerrar carrito">
            ✕
          </button>
        </div>

        <div className="drawer__body">
          {items.length === 0 ? (
            <div className="empty-state">
              <IconCart className="empty-state__icon" />
              <p>Tu carrito está vacío.</p>
              <button className="btn btn--primary" onClick={onBack}>
                Ver el menú
              </button>
            </div>
          ) : (
            <>
              {items.map((item) => {
                const extras = Array.isArray(item.extras) ? item.extras : [];
                const options = Array.isArray(item.options) ? item.options : [];
                return (
                <div className="cart-item" key={item.key}>
                  {item.image && (
                    <FadeImage src={item.image} alt="" width="44" height="44" aspectRatio={1} className="cart-item__thumb" />
                  )}
                  <div className="cart-item__info">
                    <p className="cart-item__name">{item.name}</p>
{/* Extras y opciones: los extras usan e.price, las opciones usan o.extraPrice */}
                    {(item.extras || []).length > 0 && (
                      <p className="cart-item__extras">
                        {(item.extras || []).map((e) => `${e.label} (+${formatPriceCompact(e.price)})`).join(", ")}
                      </p>
                    )}
                    {(item.options || []).length > 0 && (
                      <p className="cart-item__extras">
                        {(item.options || []).map((o) => `${o.label}${o.extraPrice > 0 ? ` (+${formatPriceCompact(o.extraPrice)})` : ""}`).join(", ")}
                      </p>
                    )}
                    {item.notes && <p className="cart-item__extras">Nota: {item.notes}</p>}
                    <div className="cart-item__line">
                      <div className="qty">
                        <button
                          onClick={() => updateQty(item.key, item.qty - 1)}
                          aria-label="Restar"
                        >
                          −
                        </button>
                        <span>{item.qty}</span>
                        <button
                          onClick={() => updateQty(item.key, item.qty + 1)}
                          aria-label="Sumar"
                        >
                          +
                        </button>
                      </div>
                      {/* Acción secundaria como ícono con tooltip (misma
                          convención que el panel admin), no botón de texto. */}
                      <Tooltip label="Quitar del pedido">
                        <button
                          className="cart-item__remove"
                          onClick={() => removeItem(item.key)}
                          aria-label={`Quitar ${item.name}`}
                        >
                          <IconTrash />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                  <div className="cart-item__price">
                    {formatPriceCompact(lineTotal(item))}
                  </div>
                </div>
                );
              })}

              <div className="summary">
                <div className="summary__row">
                  <span>Subtotal ({count} items)</span>
                  <span>{formatPriceCompact(subtotal)}</span>
                </div>
                {extrasTotal > 0 && (
                  <div className="summary__row">
                    <span>Extras</span>
                    <span>{formatPriceCompact(extrasTotal)}</span>
                  </div>
                )}
                <div className="summary__row summary__row--total">
                  <span>Total</span>
                  <span>{formatPriceCompact(total)}</span>
                </div>
              </div>
            </>
          )}
        </div>

        {items.length > 0 && (
          <div className="drawer__footer">
            <button
              data-testid="checkout-btn"
              className="btn btn--primary btn--block"
              onClick={() => {
                track("checkout_started");
                onCheckout();
              }}
            >
              Continuar · {formatPriceCompact(total)}
            </button>
            <button className="btn btn--ghost btn--block" onClick={onBack}>
              Seguir agregando
            </button>
          </div>
        )}
      </div>
    </div>
  );
}