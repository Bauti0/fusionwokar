import { useEffect, useId, useRef, useState } from "react";

// ============================================================
// Dropdown — reemplazo propio del <select> nativo (sin deps)
// API similar a un select normal:
//   <Dropdown
//     value={branch}
//     onChange={(v) => { setBranch(v); load(); }}
//     options={[{ value: "", label: "Todas" }, ...]}
//     placeholder="Elegí…"
//     disabled={false}
//   />
//
// Accesibilidad:
// - Trigger <button> real con aria-haspopup / aria-expanded.
// - Panel role="listbox", opciones role="option" + aria-selected,
//   navegación con flechas vía aria-activedescendant.
// - Enter selecciona, Escape cierra sin cambiar, click afuera cierra.
// ============================================================
export default function Dropdown({
  value,
  onChange,
  options = [],
  placeholder = "",
  disabled = false,
  className = "",
  ariaLabel = "",
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value);

  // Click afuera → cerrar
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  // Mantiene la opción activa a la vista al navegar con teclado
  useEffect(() => {
    if (open && active >= 0) {
      document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [open, active, listId]);

  function toggle() {
    if (!open) setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen((v) => !v);
  }

  function pick(option) {
    onChange?.(option.value);
    setOpen(false);
  }

  function onKeyDown(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setActive(Math.max(0, options.findIndex((o) => o.value === value)));
        setOpen(true);
        return;
      }
      const n = options.length;
      if (!n) return;
      setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a - 1 + n) % n));
    } else if (e.key === "Enter") {
      if (open) {
        e.preventDefault(); // evita que el click sintético del trigger cierre sin elegir
        if (active >= 0 && options[active]) pick(options[active]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation(); // no deja escapar hacia un modal contenedor
        setOpen(false); // cierra sin cambiar el valor
      }
    } else if (e.key === "Tab") {
      setOpen(false);
    } else if (e.key === "Home" && open) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && open) {
      e.preventDefault();
      setActive(options.length - 1);
    }
  }

  return (
    <div className={`dropdown${disabled ? " is-disabled" : ""}${className ? ` ${className}` : ""}`} ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={`dropdown__trigger${!selected && placeholder ? " is-placeholder" : ""}`}
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${listId}-opt-${active}` : undefined}
        aria-label={ariaLabel}
      >
        <span className="dropdown__label">{selected ? selected.label : placeholder || "\u00A0"}</span>
        <svg
          className={`dropdown__chevron${open ? " is-open" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="dropdown__panel" role="listbox" id={listId}>
          {options.map((o, i) => (
            <div
              key={o.value ?? i}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={o.value === value}
              className={`dropdown__option${i === active ? " is-active" : ""}${o.value === value ? " is-selected" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()} // mantiene el foco en el trigger
              onClick={() => pick(o)}
            >
              <span className="dropdown__check">{o.value === value ? "✓" : ""}</span>
              <span>{o.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
