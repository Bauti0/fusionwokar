import { formatPrice, lineTotal } from "../utils/format.js";
import { track } from "../utils/tracking.js";

// ============================================================
// Vista del carrito
// Lista de items, edición de cantidades, resumen de totales
// y botón para continuar al checkout.
// ============================================================
export default function CartView({ cart, branch, onCheckout, onBack }) {
  const { items, updateQty, removeItem, subtotal, extrasTotal, total, count } = cart;

  return (
    <div className="page">
      <div className="container">
        <h2 className="page__title">Tu pedido</h2>
        <p className="page__sub">
          {branch.name} · Retiro y delivery
        </p>

        {items.length === 0 ? (
          <div className="empty-state">
            <div className="big">🛒</div>
            <p>Tu carrito está vacío.</p>
            <button className="btn btn--primary" onClick={onBack}>
              Ver el menú
            </button>
          </div>
        ) : (
          <>
            {items.map((item) => (
              <div className="cart-item" key={item.key}>
                <div className="cart-item__info">
                  <p className="cart-item__name">{item.name}</p>
                  {item.extras.length > 0 && (
                    <p className="cart-item__extras">
                      {item.extras.map((e) => `${e.label} (+${formatPrice(e.price)})`).join(", ")}
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
                    <button className="cart-item__remove" onClick={() => removeItem(item.key)}>
                      Quitar
                    </button>
                  </div>
                </div>
                <div className="cart-item__price">
                  {formatPrice(lineTotal(item))}
                </div>
              </div>
            ))}

            <div className="summary">
              <div className="summary__row">
                <span>Subtotal ({count} items)</span>
                <span>{formatPrice(subtotal)}</span>
              </div>
              {extrasTotal > 0 && (
                <div className="summary__row">
                  <span>Extras</span>
                  <span>{formatPrice(extrasTotal)}</span>
                </div>
              )}
              <div className="summary__row summary__row--total">
                <span>Total</span>
                <span>{formatPrice(total)}</span>
              </div>
            </div>

            <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
              <button
                className="btn btn--primary btn--block"
                onClick={() => {
                  track("checkout_started");
                  onCheckout();
                }}
              >
                Continuar · {formatPrice(total)}
              </button>
              <button className="btn btn--ghost btn--block" onClick={onBack}>
                Seguir agregando
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}