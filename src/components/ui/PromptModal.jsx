import { useRef, useState } from "react";
import useDialogA11y from "../../hooks/useDialogA11y.js";

// ============================================================
// PromptModal — reemplazo propio de window.prompt con el estilo
// de los modales del panel (mismo backdrop, head, fields y footer).
//
// - Campo de texto con label y autofocus.
// - Validación inline (no vacío, maxLength) y errores del server
//   mostrados dentro del modal.
// - Cierra con Escape, click afuera, ✕ o "Cancelar" (sin crear nada).
// - Al confirmar llama a onSubmit(name); si no falla, cierra.
// - Foco atrapado mientras está abierto (useDialogA11y).
//
// Uso:
//   <PromptModal
//     title="Nueva categoría"
//     label="Nombre de la categoría"
//     confirmText="Crear"
//     onSubmit={async (name) => { await adminCreateCategory({ branch, name }); }}
//     onClose={() => setPrompt(null)}
//   />
// ============================================================
export default function PromptModal({
  title,
  label,
  initial = "",
  placeholder = "",
  confirmText = "Guardar cambios",
  maxLength = 120,
  emptyError = "El nombre es obligatorio",
  onSubmit,
  onClose,
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const dialogRef = useDialogA11y({ onClose, initialFocusRef: inputRef });

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    const name = value.trim();
    if (!name) return setError(emptyError);
    if (name.length > maxLength) return setError(`Máximo ${maxLength} caracteres`);
    setBusy(true);
    try {
      await onSubmit?.(name);
      onClose();
    } catch (err) {
      setError(err.message || "Ocurrió un error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-modal-title"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h3 id="prompt-modal-title">{title}</h3>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        <form className="modal__body" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="prompt-input">{label}</label>
            <input
              id="prompt-input"
              ref={inputRef}
              type="text"
              placeholder={placeholder}
              maxLength={maxLength}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError("");
              }}
            />
            <span className="hint">{value.trim().length}/{maxLength}</span>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal__footer">
            <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
              {confirmText}
            </button>
            <button type="button" className="btn btn--ghost btn--block" onClick={onClose} disabled={busy}>
              Cancelar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
