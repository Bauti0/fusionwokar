import { useMemo, useRef, useState } from "react";
import { formatPrice } from "../utils/format.js";
import useDialogA11y from "../hooks/useDialogA11y.js";

// ============================================================
// Modal de personalización
// Se abre al tocar "Agregar" en un producto con extras y/o
// grupos de opciones obligatorias (por ej. los combos/promos:
// "Elegí tu mein", "Elegí tu bao", "Wok 1", "Wok 2"...).
// Deja elegir opciones, cantidad y nota, y calcula el precio
// final antes de agregar al carrito.
// ============================================================
export default function CustomizeModal({ product, onClose, onConfirm, closeOnAdd = false }) {
  const dialogRef = useDialogA11y({ onClose });
  const [selectedExtras, setSelectedExtras] = useState(() =>
    new Set(product.extras?.filter((e) => e.default).map((e) => e.id) || [])
  );
  // groupKey -> optionId (elegir 1 por grupo)
  const [selectedOptions, setSelectedOptions] = useState(new Map());
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState("");
  // Anti doble toque (solo con closeOnAdd, panel de admin): un segundo
  // click en "Agregar" antes del re-render no suma el producto otra vez.
  const confirmRef = useRef(false);

  // Memoizado para que no se reconstruya en cada render (se usa como dep de
  // allOptions y se renderiza en el JSX).
  const optionGroups = useMemo(() => product.optionGroups || [], [product.optionGroups]);

  // Clave estable de un grupo de opciones: su id si lo tiene, si no su nombre.
  function groupKey(group) {
    return group.id || group.name;
  }

  // Mapa plana optionId -> opción, para recuperar el precio y la etiqueta.
  const allOptions = useMemo(() => {
    const map = new Map();
    for (const group of optionGroups) {
      for (const option of group.options) {
        map.set(option.id, option);
      }
    }
    return map;
  }, [optionGroups]);

  // Agrupa los extras por categoría (subgroup) para mostrar subtítulos
  // tipo "SALSAS ADICIONALES" / "PALITOS DESCARTABLES" / "GALLETAS".
  const extraGroups = useMemo(() => {
    const map = new Map();
    for (const extra of product.extras || []) {
      const key = extra.subgroup || "__";
      if (!map.has(key)) {
        map.set(key, { label: extra.subgroupLabel || "", items: [] });
      }
      map.get(key).items.push(extra);
    }
    return [...map.values()];
  }, [product]);

  const extrasPrice = product.extras
    ?.filter((e) => selectedExtras.has(e.id))
    .reduce((acc, e) => acc + e.price, 0) || 0;
  const optionsPrice = [...selectedOptions.values()]
    .reduce((acc, id) => acc + (allOptions.get(id)?.extraPrice || 0), 0);
  const total = (product.price + extrasPrice + optionsPrice) * qty;

  // Un grupo obligatorio está completo si tiene una opción seleccionada.
  const requiredIncomplete = optionGroups.some(
    (g) => g.required && !selectedOptions.has(groupKey(g))
  );
  const canAdd = !requiredIncomplete;

  function toggleExtra(id) {
    setSelectedExtras((prev) => {
      const next = new Set(prev);
      const extra = product.extras?.find((e) => e.id === id);
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

  function selectOption(groupKeyValue, optionId) {
    setSelectedOptions((prev) => {
      const next = new Map(prev);
      if (next.get(groupKeyValue) === optionId) next.delete(groupKeyValue);
      else next.set(groupKeyValue, optionId);
      return next;
    });
  }

  function handleConfirm() {
    if (closeOnAdd) {
      if (confirmRef.current) return;
      confirmRef.current = true;
    }
    if (!canAdd) return;
    const extras = product.extras?.filter((e) => selectedExtras.has(e.id)) || [];
    const options = [...selectedOptions.entries()].map(([gKey, optionId]) => {
      const option = allOptions.get(optionId);
      const group = optionGroups.find((g) => groupKey(g) === gKey);
      return {
        groupId: gKey,
        optionId,
        label: option?.label || "",
        extraPrice: option?.extraPrice || 0,
        groupName: group?.name || "",
      };
    });
    onConfirm(product, { extras, options, notes: notes.trim(), qty });
    // Cierra por el mismo camino que la ✕ (onClose del padre): el modal se
    // desmonta y las selecciones/nota/cantidad vuelven a su estado inicial.
    if (closeOnAdd) onClose();
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

        {/* Grupos de opciones obligatorias (elegir 1 por grupo) */}
        {optionGroups.length > 0 && (
          <div className="option-group">
            {optionGroups.map((group) => {
              const key = groupKey(group);
              const selectedId = selectedOptions.get(key);
              return (
                <div key={key}>
                  <div className="option-group__label">
                    {group.name}
                    <span className="required">{group.required ? "obligatorio" : "opcional"}</span>
                  </div>
                  {group.options.map((option) => (
                    <button
                      type="button"
                      key={option.id}
                      className={`option ${selectedId === option.id ? "is-selected" : ""}`}
                      onClick={() => selectOption(key, option.id)}
                    >
                      <span className="box">{selectedId === option.id ? "✓" : ""}</span>
                      <span className="opt-label">{option.label}</span>
                      {option.extraPrice > 0 && (
                        <span className="opt-price">+{formatPrice(option.extraPrice)}</span>
                      )}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {/* Extras opcionales (checkboxes) */}
        {extraGroups.length > 0 && (
          <div className="option-group">
            <div className="option-group__label">
              Personalizá tu pedido
              <span className="required">opcional</span>
            </div>
            {extraGroups.map((group) => (
              <div key={group.items[0].id}>
                {group.label && <div className="option-group__sub">{group.label}</div>}
                {group.items.map((extra) => (
                  <button
                    type="button"
                    key={extra.id}
                    className={`option ${selectedExtras.has(extra.id) ? "is-selected" : ""}`}
                    onClick={() => toggleExtra(extra.id)}
                  >
                    <span className="box">{selectedExtras.has(extra.id) ? "✓" : ""}</span>
                    <span className="opt-label">{extra.label}</span>
                    {extra.price > 0 && <span className="opt-price">+{formatPrice(extra.price)}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}

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
          <button
            className="btn btn--primary modal__cta"
            onClick={handleConfirm}
            disabled={!canAdd}
          >
            Agregar {qty > 1 ? `${qty} ` : ""}· {formatPrice(total)}
          </button>
        </div>
      </div>
    </div>
  );
}
