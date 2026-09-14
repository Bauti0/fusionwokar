import { useEffect, useId, useRef, useState } from "react";

// ============================================================
// DateRangePicker — reemplazo propio de los <input type="date">
// (sin dependencias). Un solo campo que abre un calendario:
//
// - Título del mes en español + navegación ◀ ▶.
// - Semanas de lunes a domingo (LU MA MI JU VI SA DO).
// - 1er click = "desde", 2do click = "hasta" (si el segundo es
//   anterior, se invierte solo). Mientras se elige el "hasta",
//   el rango se previsualiza siguiendo el hover del mouse.
// - Accesos rápidos: Hoy / Últimos 7 días / Últimos 30 / Borrar.
// - Cierra con click afuera o Escape. Hoy con borde rojo, extremos
//   del rango en rojo sólido. Los días de meses vecinos se muestran
//   apagados y son clickeables (navegan al mes).
//
// Uso (mismo contrato YYYY-MM-DD que usaba AdminStats):
//   <DateRangePicker
//     from={from} to={to}
//     onChange={({ from, to }) => { setFrom(from); setTo(to); }}
//   />
// ============================================================

const DOW = ["LU", "MA", "MI", "JU", "VI", "SA", "DO"];
const MONTHS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

function ymd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function sameYmd(a, b) {
  return a && b && a === b;
}

// Celdas del mes (lunes primero), incluyendo los días de los meses
// vecinos que completan la primera/última semana (se muestran
// apagados y permiten navegar/seleccionar entre meses).
function monthCells(viewYear, viewMonth) {
  const first = new Date(viewYear, viewMonth, 1);
  const offset = (first.getDay() + 6) % 7; // lunes = 0
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const total = Math.ceil((offset + daysInMonth) / 7) * 7;
  const cells = [];
  for (let i = 0; i < total; i++) {
    cells.push(new Date(viewYear, viewMonth, 1 - offset + i));
  }
  return cells;
}

export default function DateRangePicker({ from = "", to = "", onChange, placeholder = "Elegí un rango" }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const listId = useId();

  // Mes mostrado (guardamos año/mes para navegar libremente)
  const initial = from ? parseYmd(from) : new Date();
  const [view, setView] = useState(() => ({ y: initial.getFullYear(), m: initial.getMonth() }));

  // Borrador mientras se arma el rango dentro del calendario
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [hover, setHover] = useState(""); // YYYY-MM-DD bajo el mouse

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  function openCalendar() {
    const base = from ? parseYmd(from) : new Date();
    setView({ y: base.getFullYear(), m: base.getMonth() });
    setDraftFrom(from);
    setDraftTo(to);
    setHover("");
    setOpen(true);
  }

  function apply(f, t) {
    onChange?.({ from: f, to: t });
    setOpen(false);
  }

  function clickDay(ymdStr) {
    const d = parseYmd(ymdStr);
    if (d.getMonth() !== view.m || d.getFullYear() !== view.y) {
      // Click en un día de mes vecino: navega la vista a ese mes
      setView({ y: d.getFullYear(), m: d.getMonth() });
    }
    if (!draftFrom || (draftFrom && draftTo)) {
      // Arranca un rango nuevo
      setDraftFrom(ymdStr);
      setDraftTo("");
      return;
    }
    // Segundo click: completa (o invierte) el rango y aplica
    if (ymdStr < draftFrom) apply(ymdStr, draftFrom);
    else apply(draftFrom, ymdStr);
  }

  function previewEnd() {
    if (draftFrom && !draftTo) return hover && hover >= draftFrom ? hover : "";
    return draftTo;
  }

  function quick(kind) {
    const today = new Date();
    if (kind === "clear") {
      setDraftFrom("");
      setDraftTo("");
      onChange?.({ from: "", to: "" });
      return; // deja el calendario abierto para elegir a mano
    }
    if (kind === "today") return apply(ymd(today), ymd(today));
    const days = kind === "7d" ? 6 : 29;
    return apply(ymd(new Date(today.getTime() - days * 86400000)), ymd(today));
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

  const todayYmd = ymd(new Date());
  const end = previewEnd();
  const label =
    from && to ? `${parseYmd(from).toLocaleDateString("es-AR")} → ${parseYmd(to).toLocaleDateString("es-AR")}`
      : from ? `${parseYmd(from).toLocaleDateString("es-AR")} → …`
      : placeholder;

  return (
    <div className="daterange" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={`dropdown__trigger${!from ? " is-placeholder" : ""}`}
        onClick={() => (open ? setOpen(false) : openCalendar())}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="dropdown__label">{label}</span>
        <svg className={`dropdown__chevron${open ? " is-open" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2.5" />
          <path d="M8 3v4M16 3v4M3 10h18" />
        </svg>
      </button>

      {open && (
        <div className="daterange__panel" role="dialog" aria-label="Elegir rango de fechas">
          <div className="daterange__head">
            <button type="button" className="daterange__nav" onClick={() => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { ...v, m: v.m - 1 }))} aria-label="Mes anterior">◀</button>
            <span className="daterange__title">{MONTHS[view.m]} {view.y}</span>
            <button type="button" className="daterange__nav" onClick={() => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { ...v, m: v.m + 1 }))} aria-label="Mes siguiente">▶</button>
          </div>

          <div className="daterange__grid" id={listId} onMouseLeave={() => setHover("")}>
            {DOW.map((d) => (
              <span key={d} className="daterange__dow">{d}</span>
            ))}
            {monthCells(view.y, view.m).map((date) => {
              const ymdStr = ymd(date);
              const isOutside = date.getMonth() !== view.m;
              const isStart = sameYmd(ymdStr, draftFrom);
              const isEnd = sameYmd(ymdStr, end);
              // Mientras se elige el "hasta", el rango es solo previsualización
              const isPicking = Boolean(draftFrom && !draftTo);
              const isWeekend = date.getDay() === 0 || date.getDay() === 6;
              const classes = [
                "daterange__day",
                isOutside && "is-outside-month",
                isWeekend && !isOutside && !isStart && !isEnd && "is-weekend",
                sameYmd(ymdStr, todayYmd) && "is-today",
                isStart && "is-range-start",
                isEnd && "is-range-end",
                (isStart || isEnd) && "is-edge",
                !isStart && !isEnd && draftFrom && end && ymdStr > draftFrom && ymdStr < end && (isPicking ? "is-preview" : "is-in-range"),
              ].filter(Boolean).join(" ");
              return (
                <button
                  key={ymdStr}
                  type="button"
                  className={classes}
                  aria-pressed={isStart || isEnd}
                  onMouseEnter={() => setHover(ymdStr)}
                  onClick={() => clickDay(ymdStr)}
                >
                  <span>{date.getDate()}</span>
                </button>
              );
            })}
          </div>

          <div className="daterange__quick">
            <button type="button" className="daterange__quick-btn" onClick={() => quick("today")}>Hoy</button>
            <button type="button" className="daterange__quick-btn" onClick={() => quick("7d")}>Últimos 7 días</button>
            <button type="button" className="daterange__quick-btn" onClick={() => quick("30d")}>Últimos 30 días</button>
            <button type="button" className="daterange__quick-btn" onClick={() => quick("clear")}>Borrar</button>
          </div>
        </div>
      )}
    </div>
  );
}
