import { formatPrice } from "../utils/format.js";

// ============================================================
// Barra fija de carrito (footer)
// Muestra cantidad de ítems y total acumulado con botón
// "Ver pedido". Se oculta si el carrito está vacío.
// ============================================================
export default function CartBar({ count, total, onView }) {
  if (count === 0) return null;

  return (
    <div className="cart-bar">
      <button className="cart-bar__inner" onClick={onView}>
        <span className="cart-bar__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 6h15l-1.6 8.2a2 2 0 0 1-2 1.6H9.4a2 2 0 0 1-2-1.6L5.3 3.6A2 2 0 0 0 3.3 2H2" />
            <circle cx="10" cy="20" r="1.6" />
            <circle cx="18" cy="20" r="1.6" />
          </svg>
          <span className="cart-bar__badge">{count}</span>
        </span>
        <span className="cart-bar__info">
          <span className="cart-bar__count">{count} {count === 1 ? "item" : "items"}</span>
          <span className="cart-bar__total">{formatPrice(total)}</span>
        </span>
        <span className="cart-bar__cta">
          Ver pedido
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
      </button>
    </div>
  );
}
