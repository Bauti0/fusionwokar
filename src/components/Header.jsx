import { Link } from "react-router-dom";
import { BRAND } from "../data/branches.js";
import Tooltip from "./ui/Tooltip.jsx";
import { IconClock, IconCart, IconChevronDown } from "./ui/icons.jsx";

// ============================================================
// Header de la app (una vez elegida la sucursal)
// Logo + nombre, chip de sucursal clicable (cambia de sucursal),
// acceso a "Mis pedidos" (ícono de reloj) y carrito.
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
              <IconChevronDown className="branch-chip__caret" size={16} />
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
        <Tooltip label="Mis pedidos">
          <button className="icon-btn" onClick={onHistory} aria-label="Mis pedidos">
            <IconClock style={{ width: 20, height: 20 }} />
          </button>
        </Tooltip>
        <Tooltip label="Ver carrito">
          <button className="icon-btn" onClick={onCart} aria-label="Ver carrito">
            <IconCart />
            {cartCount > 0 && <span className="badge-count">{cartCount}</span>}
          </button>
        </Tooltip>
      </div>
    </header>
  );
}
