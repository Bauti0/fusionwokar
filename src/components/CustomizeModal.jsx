import { useMemo, useState } from "react";
import { formatPrice } from "../utils/format.js";
import useDialogA11y from "../hooks/useDialogA11y.js";

// ============================================================
// Modal de personalización
// Se abre al tocar "Agregar" en un producto con extras
// (por ej. salsas). Deja elegir opciones, cantidad y nota,
// y calcula el precio final antes de agregar al carrito.
// ============================================================
export default function CustomizeModal({ product, onClose, onConfirm }) {
  const dialogRef = useDialogA11y({ onClose });
  const [selected, setSelected] = useState(() =>
    new Set(product.extras.filter((e) => e.default).map((e) => e.id))
  );
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState("");

  const total = useMemo(() => {
    const extrasPrice = product.extras
      .filter((e) => selected.has(e.id))
      .reduce((acc, e) => acc + e.price, 0);
    return (product.price + extrasPrice) * qty;
  }, [product, selected, qty]);

  function toggleExtra(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      const extra = product.extras.find((e) => e.id === id);
      // Si el extra pertenece a un grupo (ej: "1 galleta" vs "2 galletas"),
      // es de elección única: al marcar uno se desmarcan los demás del grupo.
      if (extra?.group) {
        product.extras
          .filter((e) => e.group === extra.group && e.id !== id)
          .forEach((e) => next.delete(e.id));
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleConfirm() {
    const extras = product.extras.filter((e) => selected.has(e.id));
    onConfirm(product, { extras, notes: notes.trim(), qty });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="customize-title"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h3 className="modal__name" id="customize-title">{product.name}</h3>
          <span className="modal__price">{formatPrice(total)}</span>
          <button className="modal__close" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>
        {product.description && <p className="modal__desc">{product.description}</p>}

        <div className="option-group">
          <div className="option-group__label">
            Personalizá tu pedido
            <span className="required">opcional</span>
          </div>
          {(() => {
            let lastGroup = null;
            return product.extras.map((extra) => {
              const groupStart = extra.group && extra.group !== lastGroup;
              lastGroup = extra.group || null;
              return (
                <div key={extra.id}>
                  {groupStart && <div className="option-group__sub">{extra.groupLabel || ""}</div>}
                  <button
                    type="button"
                    className={`option ${selected.has(extra.id) ? "is-selected" : ""}`}
                    onClick={() => toggleExtra(extra.id)}
                  >
                    <span className="box">{selected.has(extra.id) ? "✓" : ""}</span>
                    <span className="opt-label">{extra.label}</span>
                    {extra.price > 0 && <span className="opt-price">+{formatPrice(extra.price)}</span>}
                  </button>
                </div>
              );
            });
          })()}
        </div>

        <div className="field">
          <label htmlFor="customize-notes">Nota (opcional)</label>
          <textarea
            id="customize-notes"
            rows="2"
            placeholder="Ej: sin verdeo, salsa aparte…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div className="modal__actions">
          <div className="qty qty--modal">
            <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Restar">
              −
            </button>
            <span>{qty}</span>
            <button type="button" onClick={() => setQty((q) => q + 1)} aria-label="Sumar">
              +
            </button>
          </div>
          <button className="btn btn--primary modal__cta" onClick={handleConfirm}>
            Agregar {qty > 1 ? `${qty} ` : ""}· {formatPrice(total)}
          </button>
        </div>
      </div>
    </div>
  );
}