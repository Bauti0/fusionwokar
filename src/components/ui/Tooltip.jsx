import { useId, useState } from "react";

// ============================================================
// Tooltip — reemplazo propio del title="" nativo del navegador.
// Envuelve a un único hijo (normalmente un botón que ya tiene su
// aria-label propio); el tooltip es puramente visual/decorativo
// para mouse/teclado, no reemplaza la accesibilidad del hijo.
//
// Uso:
//   <Tooltip label="Seguir mi pedido">
//     <Link className="icon-btn" to="/track" aria-label="Seguir mi pedido">...</Link>
//   </Tooltip>
// ============================================================
export default function Tooltip({ label, children, side = "bottom" }) {
  const [visible, setVisible] = useState(false);
  const id = useId();

  return (
    <span
      className="tooltip-wrap"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      <span
        role="tooltip"
        id={id}
        className={`tooltip tooltip--${side} ${visible ? "tooltip--visible" : ""}`}
        aria-hidden={!visible}
      >
        {label}
      </span>
    </span>
  );
}
