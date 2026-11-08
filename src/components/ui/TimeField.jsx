import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconClock, IconChevronDown } from "../ui/icons.jsx";

// ============================================================
// TimeField — selector de hora reutilizable
// Valor: string "HH:MM" (24h). Máscara de entrada + selector popover/bottom-sheet.
// ============================================================

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));
const QUICK_TIMES = ["00:00", "12:00", "20:00"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseInput(v) {
  // Acepta "1930", "19:30", "193", "7" -> "HH:MM" o null si inválido
  if (!v) return null;
  const digits = v.replace(/\D/g, "");
  if (digits.length === 0) return null;
  if (digits.length > 4) return null;
  let h = 0, m = 0;
  if (digits.length <= 2) {
    h = parseInt(digits, 10);
    return h >= 0 && h <= 23 ? `${pad2(h)}:00` : null;
  } else {
    h = parseInt(digits.slice(0, 2), 10);
    m = parseInt(digits.slice(2), 10);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return `${pad2(h)}:${pad2(m)}`;
  }
}

function formatDisplay(v) {
  if (!v) return "";
  const parts = v.split(":");
  if (parts.length !== 2) return v;
  return `${parts[0]}:${parts[1]}`;
}

export default function TimeField({
  value = "",
  onChange,
  disabled = false,
  ariaLabel = "Hora",
  error = false,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [selHour, setSelHour] = useState(() => (value ? value.split(":")[0] : "12"));
  const [selMinute, setSelMinute] = useState(() => (value ? value.split(":")[1] : "00"));
  const [inputVal, setInputVal] = useState(() => formatDisplay(value));
  const inputRef = useRef(null);
  const popoverRef = useRef(null);

  // Sincronizar selector interno con value externo
  useEffect(() => {
    if (value) {
      const [h, m] = value.split(":");
      setSelHour(h);
      setSelMinute(m);
      setInputVal(formatDisplay(value));
    } else {
      setInputVal("");
    }
  }, [value]);

  // Cerrar con Escape / click fuera
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === "Escape" && isOpen) {
        e.preventDefault();
        setIsOpen(false);
      }
    }
    function onClickOutside(e) {
      if (isOpen && popoverRef.current && !popoverRef.current.contains(e.target)) {
        const input = inputRef.current;
        if (input && !input.contains(e.target)) {
          setIsOpen(false);
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onClickOutside);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onClickOutside);
    };
  }, [isOpen]);

  function openPopover() {
    if (disabled) return;
    // Inicializar selector con valor actual
    if (value) {
      const [h, m] = value.split(":");
      setSelHour(h);
      setSelMinute(m);
    } else {
      setSelHour("12");
      setSelMinute("00");
    }
    setIsOpen(true);
  }

  function closePopover(commit = false) {
    setIsOpen(false);
    if (commit && inputVal) {
      const parsed = parseInput(inputVal);
      if (parsed) onChange(parsed);
    } else if (!commit) {
      // Revertir input visual al value real
      setInputVal(formatDisplay(value));
    }
  }

  function handleInputChange(e) {
    const raw = e.target.value;
    const parsed = parseInput(raw);
    setInputVal(raw);
    if (parsed) {
      onChange(parsed);
      const [h, m] = parsed.split(":");
      setSelHour(h);
      setSelMinute(m);
    }
  }

  function handleInputBlur() {
    const parsed = parseInput(inputVal);
    if (parsed) {
      onChange(parsed);
    } else {
      setInputVal(formatDisplay(value));
    }
  }

  function pickQuick(t) {
    onChange(t);
    setSelHour(t.split(":")[0]);
    setSelMinute(t.split(":")[1]);
    setInputVal(formatDisplay(t));
  }

  function pickHour(h) {
    setSelHour(h);
  }

  function pickMinute(m) {
    setSelMinute(m);
  }

  function commitSelection() {
    const composed = `${selHour}:${selMinute}`;
    onChange(composed);
    setInputVal(formatDisplay(composed));
    setIsOpen(false);
  }

  const isMobile = typeof window !== "undefined" && window.innerWidth < 640;

  const popoverContent = (
    <div
      ref={popoverRef}
      className={`timefield-popover ${isMobile ? "is-mobile" : ""}`}
      role="dialog"
      aria-label={ariaLabel}
      tabIndex={-1}
    >
      <div className="timefield-header">
        <span className="timefield-title">{ariaLabel}</span>
        <div className="timefield-quick">
          {QUICK_TIMES.map((t) => (
            <button
              key={t}
              type="button"
              className="timefield-quick-btn"
              onClick={() => pickQuick(t)}
              tabIndex={-1}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="timefield-grid">
        <div className="timefield-col">
          <div className="timefield-col-label">Hora</div>
          <div className="timefield-list" role="listbox" aria-label="Horas">
            {HOURS.map((h) => (
              <button
                key={h}
                type="button"
                role="option"
                aria-selected={selHour === h}
                className={`timefield-btn ${selHour === h ? "is-selected" : ""}`}
                onClick={() => pickHour(h)}
                tabIndex={-1}
              >
                {h}
              </button>
            ))}
          </div>
        </div>
        <div className="timefield-col">
          <div className="timefield-col-label">Minuto</div>
          <div className="timefield-list" role="listbox" aria-label="Minutos">
            {MINUTES.map((m) => (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={selMinute === m}
                className={`timefield-btn ${selMinute === m ? "is-selected" : ""}`}
                onClick={() => pickMinute(m)}
                tabIndex={-1}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="timefield-footer">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => closePopover(false)}>
          Cancelar
        </button>
        <button type="button" className="btn btn--primary btn--sm" onClick={commitSelection}>
          Aceptar
        </button>
      </div>
    </div>
  );

  return (
    <div className="timefield">
      <div className={`timefield-input-wrap${error ? " has-error" : ""}`}>
        <span className="timefield-icon" aria-hidden="true">
          <IconClock style={{ width: 18, height: 18 }} />
        </span>
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          maxLength={5}
          placeholder="HH:MM"
          value={inputVal}
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          onClick={openPopover}
          onFocus={openPopover}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-expanded={isOpen}
          aria-haspopup="dialog"
          aria-invalid={error}
          autoComplete="off"
        />
        <button
          type="button"
          className="timefield-toggle"
          onClick={isOpen ? () => closePopover(false) : openPopover}
          disabled={disabled}
          aria-label={isOpen ? "Cerrar selector" : "Abrir selector"}
          tabIndex={-1}
        >
          <IconChevronDown style={{ width: 18, height: 18 }} />
        </button>
      </div>
      {isOpen && createPortal(popoverContent, document.body)}
    </div>
  );
}