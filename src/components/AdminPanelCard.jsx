// ============================================================
// AdminPanelCard — Contenedor unificado para todas las pestañas del admin
// Fondo: un tono entre el fondo de página (--color-bg) y las tarjetas internas
// Borde sutil, radio, padding interno y margen superior respecto al header.
// ============================================================
export default function AdminPanelCard({ children, title, titleIcon, actions }) {
  return (
    <section className="admin-panel-card">
      {(title || actions) && (
        <div className="admin-panel-card__head">
          {title && (
            <h3 className="admin-panel-card__title">
              {titleIcon && <span className="admin-panel-card__icon" aria-hidden="true">{titleIcon}</span>}
              {title}
            </h3>
          )}
          {actions && <div className="admin-panel-card__actions">{actions}</div>}
        </div>
      )}
      <div className="admin-panel-card__body">{children}</div>
    </section>
  );
}