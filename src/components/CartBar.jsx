import { formatPrice } from "../utils/format.js";
import { IconCart, IconArrowRight } from "./ui/icons.jsx";

// ============================================================
// Barra fija de carrito (footer)
// Muestra cantidad de ítems y total acumulado con botón
// "Ver pedido". Se oculta si el carrito está vacío.
// ============================================================
export default function CartBar({ count, total, onView }) {
  if (count === 0) return null;

  return (
    <div className="cart-bar">
      <button
        data-testid="cart-bar-btn"
        className="cart-bar__inner"
        onClick={onView}
        aria-label={`Ver carrito (${count} ${count === 1 ? "item" : "items"})`}
      >
        <span className="cart-bar__icon" aria-hidden="true">
          <IconCart />
          {/* key por cantidad: fuerza el re-montaje y reproduce la
              animación pop del badge en cada alta de ítem. */}
          <span className="cart-bar__badge" key={count}>{count}</span>
        </span>
        <span className="cart-bar__info">
          <span className="cart-bar__count">{count} {count === 1 ? "item" : "items"}</span>
          <span className="cart-bar__total">{formatPrice(total)}</span>
        </span>
        <span className="cart-bar__cta">
          Ver pedido
          <IconArrowRight />
        </span>
      </button>
    </div>
  );
}
