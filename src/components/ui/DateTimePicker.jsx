import { useEffect, useRef, useState } from "react";
import Dropdown from "./Dropdown.jsx";

// ============================================================
// DateTimePicker — reemplazo propio de <input type="datetime-local">
// (sin dependencias). Un solo campo que abre calendario + hora:
//
// - Misma mecánica visual que DateRangePicker: título del mes en
//   español, navegación ◀ ▶, días de meses vecinos apagados y
//   clickeables, día seleccionado en rojo sólido.
// - Selección de UN solo día (sin rango) + hora y minutos con dos
//   Dropdown chicos (minutos en pasos de 5).
// - Botón "Sin vencimiento" para limpiar (campo opcional).
// - Prop `min` opcional ("YYYY-MM-DDTHH:mm"): los días anteriores
//   se muestran deshabilitados (mismo contrato que el input nativo).
// - Devuelve el MISMO formato que datetime-local:
//     "YYYY-MM-DDTHH:mm"  o  "" (vacío)
//   así el backend sigue parseándolo igual (hora local → ISO).
// - Cierra con click afuera / Escape / Tab.
//
// Uso:
//   <DateTimePicker
//     value={form.expiresAt}
//     onChange={(v) => setForm({ ...form, expiresAt: v })}
//     min={minValue}
//     placeholder="Sin vencimiento"
//   />
// ============================================================

const DOW = ["LU", "MA", "MI", "JU", "VI", "SA", "DO"];
const MONTHS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

function pad(n) {
  return String(n).padStart(2, "0");
}

function ymdOf(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Celdas del mes (lunes primero), incluyendo días vecinos de meses
// contiguos para completar las semanas (idéntico a DateRangePicker).
function monthCells(viewYear, viewMonth) {
  const first = new Date(viewYear, viewMonth, 1);
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const total = Math.ceil((offset + daysInMonth) / 7) * 7;
  const cells = [];
  for (let i = 0; i < total; i++) {
    cells.push(new Date(viewYear, viewMonth, 1 - offset + i));
  }
  return cells;
}

const HOURS = Array.from({ length: 24 }, (_, i) => pad(i));
const MINUTES = Array.from({ length: 12 }, (_, i) => pad(i * 5));

export default function DateTimePicker({
  value = "",
  onChange,
  placeholder = "Elegí fecha y hora",
  min = "",
  ariaLabel = "Elegir fecha y hora",
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const init = value && !isNaN(new Date(value).getTime()) ? new Date(value) : new Date();
  const [view, setView] = useState(() => ({ y: init.getFullYear(), m: init.getMonth() }));
  const [day, setDay] = useState(value ? value.slice(0, 10) : "");
  const [hh, setHh] = useState(value ? value.slice(11, 13) : "20");
  const [mm, setMm] = useState(value ? value.slice(14, 16) : "00");

  // Click afuera → cerrar
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  function commit(nextDay = day, nextHh = hh, nextMm = mm) {
    onChange?.(nextDay ? `${nextDay}T${nextHh}:${nextMm}` : "");
  }

  function pickDay(dateObj) {
    const s = ymdOf(dateObj);
    const minDay = min ? String(min).slice(0, 10) : "";
    if (minDay && s < minDay) return; // día deshabilitado por `min`
    setView({ y: dateObj.getFullYear(), m: dateObj.getMonth() });
    setDay(s);
    commit(s);
  }

  function clearAll() {
    setDay("");
    setHh("20");
    setMm("00");
    onChange?.("");
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  const todayYmd = ymdOf(new Date());
  const minDay = min ? String(min).slice(0, 10) : "";
  const label = value && !isNaN(new Date(value).getTime())
    ? new Date(value).toLocaleString("es-AR", {
        day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : placeholder;

  return (
    <div className="dtp" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={`dropdown__trigger${!value ? " is-placeholder" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className="dropdown__label">{label}</span>
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
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" />
        </svg>
      </button>

      {open && (
        <div className="dtp__panel" role="dialog" aria-label="Elegir fecha y hora">
          <div className="daterange__head">
            <button type="button" className="daterange__nav" onClick={() => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { ...v, m: v.m - 1 }))} aria-label="Mes anterior">◀</button>
            <span className="daterange__title">{MONTHS[view.m]} {view.y}</span>
            <button type="button" className="daterange__nav" onClick={() => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { ...v, m: v.m + 1 }))} aria-label="Mes siguiente">▶</button>
          </div>

          <div className="daterange__grid">
            {DOW.map((d) => (
              <span key={d} className="daterange__dow">{d}</span>
            ))}
            {monthCells(view.y, view.m).map((date) => {
              const s = ymdOf(date);
              const disabled = Boolean(minDay && s < minDay);
              const classes = [
                "daterange__day",
                date.getMonth() !== view.m && "is-outside-month",
                sameStr(s, todayYmd) && "is-today",
                sameStr(s, day) && "is-selected",
                disabled && "is-disabled",
              ].filter(Boolean).join(" ");
              return (
                <button
                  key={s}
                  type="button"
                  className={classes}
                  aria-pressed={sameStr(s, day)}
                  onClick={() => pickDay(date)}
                >
                  <span>{date.getDate()}</span>
                </button>
              );
            })}
          </div>

          <div className="dtp__time">
            <div className="dtp__time-unit">
              <span>Hora</span>
              <Dropdown
                value={hh}
                onChange={(v) => { setHh(v); commit(day, v); }}
                options={HOURS.map((h) => ({ value: h, label: h }))}
                ariaLabel="Hora"
              />
            </div>
            <div className="dtp__time-unit">
              <span>Minutos</span>
              <Dropdown
                value={mm}
                onChange={(v) => { setMm(v); commit(day, undefined, v); }}
                options={MINUTES.map((m) => ({ value: m, label: m }))}
                ariaLabel="Minutos"
              />
            </div>
            <button type="button" className="btn btn--ghost btn--sm dtp__clear" onClick={clearAll}>
              Sin vencimiento
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function sameStr(a, b) {
  return Boolean(a) && a === b;
}
