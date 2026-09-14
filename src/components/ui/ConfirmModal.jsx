import { useRef, useState } from "react";
import useDialogA11y from "../../hooks/useDialogA11y.js";

// ============================================================
// ConfirmModal — reemplazo propio de window.confirm / window.alert
// con el mismo lenguaje visual que PromptModal (backdrop, head,
// footer, foco atrapado con useDialogA11y).
//
// - variant="danger" tiñe el ícono y el botón de confirmar en rojo
//   (para borrados). variant="default" usa el estilo primario.
// - Si `cancelText` es null/"" se muestra un solo botón (modo aviso,
//   reemplaza window.alert).
// - onConfirm puede ser async; si tira error, se muestra dentro
//   del modal en vez de cerrarse.
//
// Uso (confirmar borrado):
//   <ConfirmModal
//     variant="danger"
//     title="Eliminar producto"
//     message={`¿Eliminar "${product.name}" del menú?`}
//     confirmText="Eliminar"
//     onConfirm={() => adminDeleteProduct(product.id)}
//     onClose={() => setConfirm(null)}
//   />
//
// Uso (aviso, reemplaza alert):
//   <ConfirmModal
//     title="No se pudo imprimir"
//     message="Permití las ventanas emergentes para imprimir el ticket."
//     cancelText={null}
//     confirmText="Entendido"
//     onConfirm={() => {}}
//     onClose={onClose}
//   />
// ============================================================
export default function ConfirmModal({
  title,
  message,
  variant = "default",
  confirmText = "Confirmar",
  cancelText = "Cancelar",
  onConfirm,
  onClose,
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef(null);
  const dialogRef = useDialogA11y({ onClose, initialFocusRef: confirmRef });
  const single = !cancelText;

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm?.();
      onClose();
    } catch (err) {
      setError(err.message || "Ocurrió un error");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={single ? undefined : onClose}>
      <div
        className={`modal confirm-modal confirm-modal--${variant}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-message"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-modal__icon" aria-hidden="true">
          {variant === "danger" ? "⚠" : "ℹ"}
        </div>
        <div className="modal__head confirm-modal__head">
          <h3 id="confirm-modal-title">{title}</h3>
          {!single && (
            <button type="button" className="modal__close" onClick={onClose} aria-label="Cerrar">✕</button>
          )}
        </div>
        <p id="confirm-modal-message" className="confirm-modal__message">{message}</p>

        {error && <div className="form-error">{error}</div>}

        <div className="modal__footer confirm-modal__footer">
          <button
            type="button"
            ref={confirmRef}
            className={`btn ${variant === "danger" ? "btn--danger" : "btn--primary"} btn--block`}
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy ? "Un momento…" : confirmText}
          </button>
          {!single && (
            <button type="button" className="btn btn--ghost btn--block" onClick={onClose} disabled={busy}>
              {cancelText}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
