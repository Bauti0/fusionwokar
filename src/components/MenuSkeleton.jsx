// ============================================================
// MenuSkeleton — estado de carga del menú (shimmer)
// Calca la forma real del menú (banner, buscador, chips y
// tarjetas de producto) para que la transición a los datos
// reales sea suave y no un cambio brusco de layout.
// ============================================================
export default function MenuSkeleton() {
  return (
    <div className="menu-skeleton">
      <div className="sk-banner skeleton" />
      <div className="sk-search skeleton" />
      <div className="sk-chips">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="sk-chip skeleton" key={i} />
        ))}
      </div>
      <div className="sk-cat-head">
        <div className="sk-cat-icon skeleton" />
        <div className="sk-cat-title skeleton" />
      </div>
      {Array.from({ length: 4 }).map((_, i) => (
        <div className="sk-card" key={i}>
          <div className="sk-card-media skeleton" />
          <div className="sk-card-body">
            <div className="sk-line skeleton" style={{ width: "70%" }} />
            <div className="sk-line skeleton sk-line--sm" style={{ width: "95%" }} />
            <div className="sk-line skeleton sk-line--sm" style={{ width: "40%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}
