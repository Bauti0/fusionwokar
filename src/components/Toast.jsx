// ============================================================
// Toast — feedback flotante (agregar al carrito, errores, etc.)
// ============================================================
export default function Toast({ toast }) {
  if (!toast) return null;
  const type = toast.type || "success";
  return (
    <div className={`toast toast--${type}`} role="status" aria-live="polite" key={toast.id}>
      <span className="toast__icon">{type === "error" ? "!" : "✓"}</span>
      <span>{toast.message}</span>
    </div>
  );
}
