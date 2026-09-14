import { Link } from "react-router-dom";
import { BRAND } from "../data/branches.js";
import Tooltip from "./ui/Tooltip.jsx";

// ============================================================
// Header de la app (una vez elegida la sucursal)
// Logo + nombre, chip de sucursal clicable (cambia de sucursal),
// acceso a "Seguir mi pedido", historial y carrito.
// ============================================================
export default function Header({ branch, cartCount, onHistory, onCart, onHome, onChangeBranch }) {
  return (
    <header className="app-header">
      <button
        className="app-header__logo"
        onClick={onHome}
        style={{ border: "none", padding: 0, cursor: "pointer" }}
        aria-label="Ir al menú"
      >
        <img src={BRAND.logo} alt={`Logo ${BRAND.name}`} />
      </button>

      <div className="app-header__brand">
        <strong>Fusión Wok</strong>
        {onChangeBranch ? (
          <Tooltip label="Cambiar de sucursal">
            <button
              type="button"
              className="branch-chip branch-chip--btn"
              onClick={onChangeBranch}
              aria-label={`Cambiar de sucursal (actual: ${branch.name})`}
            >
              <span className="branch-dot" style={{ background: branch.accentColor }} aria-hidden="true" />
              {branch.name}
              <svg className="branch-chip__caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          </Tooltip>
        ) : (
          <span className="branch-chip">
            <span className="branch-dot" style={{ background: branch.accentColor }} aria-hidden="true" />
            {branch.name}
          </span>
        )}
      </div>

      <div className="app-header__actions">
        <Tooltip label="Seguir mi pedido">
          <Link className="icon-btn" to="/track" aria-label="Seguir mi pedido">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 21s-7-5.1-7-11a7 7 0 1 1 14 0c0 5.9-7 11-7 11z" />
              <circle cx="12" cy="10" r="2.5" />
            </svg>
          </Link>
        </Tooltip>
        <Tooltip label="Mis pedidos">
          <button className="icon-btn" onClick={onHistory} aria-label="Mis pedidos">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 3" />
            </svg>
          </button>
        </Tooltip>
        <Tooltip label="Ver carrito">
          <button className="icon-btn" onClick={onCart} aria-label="Ver carrito">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 6h15l-1.6 8.2a2 2 0 0 1-2 1.6H9.4a2 2 0 0 1-2-1.6L5.3 3.6A2 2 0 0 0 3.3 2H2" />
              <circle cx="10" cy="20" r="1.6" />
              <circle cx="18" cy="20" r="1.6" />
            </svg>
            {cartCount > 0 && <span className="badge-count">{cartCount}</span>}
          </button>
        </Tooltip>
      </div>
    </header>
  );
}
