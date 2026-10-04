import { useRef, useState } from "react";
import useDialogA11y from "../../hooks/useDialogA11y.js";

// ============================================================
// PauseModal — pausar los pedidos de una sucursal, en UN solo paso.
//
// - Duración: 30 min / 1 hora / 2 horas / Hasta reanudar (los mismos
//   botones segmentados que usa el cambio de estado de un pedido).
// - Mensaje opcional para los clientes (se muestra en el menú, el
//   checkout y la landing). El tope y el "sin HTML" los valida el
//   server; acá el input ya corta en 140.
// - Validación y errores del server mostrados dentro del modal.
// - Cierra con Escape, click afuera, ✕ o "Cancelar" (sin cambiar nada).
// - Foco atrapado mientras está abierto (useDialogA11y).
//
// Reanudar NO pasa por acá: es un botón directo en la cabecera de
// Pedidos (no necesita confirmación ni duración).
//
// Uso:
//   <PauseModal
//     branchName="Tandil"
//     onSubmit={async ({ minutes, indefinite, message }) => {...}}
//     onClose={() => setPauseTarget(null)}
//   />
// ============================================================

// (valor, etiqueta): "indefinite" es el flag que manda el server.
const DURATIONS = [
  ["30", "30 min"],
  ["60", "1 hora"],
  ["120", "2 horas"],
  ["indefinite", "Hasta reanudar"],
];

export default function PauseModal({ branchName = "", onSubmit, onClose }) {
  const [duration, setDuration] = useState("30");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const dialogRef = useDialogA11y({ onClose, initialFocusRef: inputRef });

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    const indefinite = duration === "indefinite";
    setBusy(true);
    try {
      await onSubmit?.({
        indefinite,
        minutes: indefinite ? null : Number(duration),
        message: message.trim(),
      });
      onClose();
    } catch (err) {
      setError(err.message || "No se pudo pausar los pedidos");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pause-modal-title"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h3 id="pause-modal-title">Pausar pedidos{branchName ? ` — ${branchName}` : ""}</h3>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        <form className="modal__body" onSubmit={handleSubmit}>
          <p className="pause-modal__lead">
            Mientras la sucursal esté pausada, la página no deja crear pedidos nuevos.
            Los pedidos ya cargados y la carga manual del panel siguen igual.
          </p>

          <div className="field">
            <label>¿Por cuánto tiempo?</label>
            <div className="status-actions">
              {DURATIONS.map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={`status-btn ${duration === value ? "is-active" : ""}`}
                  onClick={() => setDuration(value)}
                  aria-pressed={duration === value}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="pause-message">Mensaje para los clientes (opcional)</label>
            <input
              id="pause-message"
              ref={inputRef}
              type="text"
              maxLength={140}
              placeholder="Ej: Nos quedamos sin cajitas, volvemos pronto"
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                if (error) setError("");
              }}
            />
            <span className="hint">{message.trim().length}/140 · Se muestra en el menú y el checkout</span>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal__footer">
            <button type="submit" className="btn btn--danger btn--block" disabled={busy}>
              {busy ? "Pausando…" : "Pausar pedidos"}
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
