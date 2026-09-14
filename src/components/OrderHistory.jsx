import { formatPrice } from "../utils/format.js";

// ============================================================
// Historial de pedidos del cliente
// Muestra pedidos anteriores de la sucursal y permite
// repetir un pedido fácilmente (lo vuelve a cargar al carrito).
// ============================================================
export default function OrderHistory({ history, branch, onRepeat, onBack, onMenu }) {
  return (
    <div className="page">
      <div className="container">
        <h2 className="page__title">Mis pedidos</h2>
        <p className="page__sub">{branch.name}</p>

        {history.length === 0 ? (
          <div className="empty-state">
            <div className="big">🕘</div>
            <p>Todavía no hiciste pedidos en esta sucursal.</p>
            <button className="btn btn--primary" onClick={onMenu}>
              Ver el menú
            </button>
          </div>
        ) : (
          history.map((order) => (
            <div className="order-card" key={order.id}>
              <div className="order-card__head">
                <span className="order-card__date">
                  {new Date(order.date).toLocaleDateString("es-AR", {
                    day: "2-digit",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span className="order-card__total">{formatPrice(order.total)}</span>
              </div>
              <p className="order-card__lines">
                {order.items.map((it) => `${it.qty}× ${it.name}`).join(" · ")}
              </p>
              <div className="order-card__meta">
                <span>{order.orderMode === "delivery" ? "Delivery" : "Retiro"}</span>
                <span>{order.paymentMethod}</span>
              </div>
              <div className="cart-item__line">
                <button className="btn btn--dark" onClick={() => onRepeat(order)}>
                  🔁 Repetir pedido
                </button>
                <button className="btn btn--ghost" onClick={onBack}>
                  Volver
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}