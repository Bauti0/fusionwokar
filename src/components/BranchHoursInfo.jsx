import { useState } from "react";
import { pauseNotice } from "../utils/schedule.js";
import { IconClock, IconLocation, IconDelivery, IconChevronDown, IconPause } from "./ui/icons.jsx";

// ============================================================
// BranchHoursInfo — Presentación unificada de horarios
// Recibe datos ya calculados (structuredHours), sucursal, pausa y modo.
// No hace cálculos: solo formatea y renderiza.
// ============================================================

const DAY_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const DAY_LONG = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function formatDayRange(days) {
  if (!days?.length) return "";
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 1) return DAY_LONG[sorted[0]];
  if (sorted.length === 7) return "todos los días";
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (last - first + 1 === sorted.length) {
    return `${DAY_SHORT[first]}–${DAY_SHORT[last]}`;
  }
  return sorted.map(d => DAY_SHORT[d]).join(", ");
}

function getStatusLabel(branch, pause, structuredHours) {
  if (pause?.paused) {
    return { label: "Pausado", variant: "pause" };
  }
  if (!structuredHours?.today) {
    return { label: "Abierto ahora", variant: "open" };
  }
  if (structuredHours.today.isClosed) {
    return { label: "Cerrado", variant: "closed" };
  }
  return { label: "Abierto ahora", variant: "open" };
}

export default function BranchHoursInfo({
  branch,
  pause = null,
  structuredHours,
  mode = "full", // "full" | "compact"
}) {
  const [isOpen, setIsOpen] = useState(false);

  const status = getStatusLabel(branch, pause, structuredHours);
  const today = structuredHours?.today;
  const grouped = structuredHours?.grouped || [];

  const togglePanel = () => setIsOpen(!isOpen);

  // Panel cerrado por defecto, se cierra al cambiar de sucursal
  // (el key en el padre hará que se remonte si cambia branch)

  const hasPanelContent = grouped.length > 0 || (today?.isClosed ?? false);

  if (!today && !mode && !pause) {
    return null;
  }

  return (
    <div className="hours-info">
      {/* Fila principal: horarios de hoy + estado + control */}
      <div className="hours-info__row hours-info__row--main">
        <IconClock className="hours-info__icon" width="20" height="20" />
        <div className="hours-info__content">
          {today ? (
            <>
              <span className="hours-info__today-label">Hoy</span>
              <span className="hours-info__slots">
                {today.isClosed ? (
                  <span className="hours-info__closed">Cerrado hoy</span>
                ) : (
                  today.slots.map((s, i) => (
                    <span key={i} className="hours-info__slot">
                      {s.from} – {s.to}
                      {i < today.slots.length - 1 && <span className="hours-info__slot-sep">·</span>}
                    </span>
                  ))
                )}
              </span>
            </>
          ) : (
            <span className="hours-info__slots">Sin datos</span>
          )}
          <span className={`hours-info__status hours-info__status--${status.variant}`}>
            <span className="hours-info__status-dot" aria-hidden="true" />
            {status.label}
          </span>
          {hasPanelContent && (
            <button
              type="button"
              className="hours-info__toggle"
              onClick={togglePanel}
              aria-expanded={isOpen}
              aria-controls="hours-info-panel"
              title={isOpen ? "Ocultar horarios" : "Ver horarios"}
            >
              <span className="hours-info__toggle-text">
                {isOpen ? "Ocultar horarios" : "Ver horarios"}
              </span>
              <IconChevronDown
                className={`hours-info__chevron ${isOpen ? "rotated" : ""}`}
                width="16"
                height="16"
              />
            </button>
          )}
        </div>

        {/* Panel desplegable con la semana completa */}
        {isOpen && hasPanelContent && (
          <div
            id="hours-info-panel"
            className="hours-info__panel"
            role="region"
            aria-labelledby="hours-info-toggle"
          >
            <dl className="hours-info__week">
              {grouped.map((group, idx) => (
                <div key={idx} className="hours-info__group">
                  <dt className="hours-info__day-label">{formatDayRange(group.days)}</dt>
                  <dd className="hours-info__day-slots">
                    {group.slots.map((s, si) => (
                      <span key={si} className="hours-info__slot">
                        {s.from} – {s.to}
                        {si < group.slots.length - 1 && <span className="hours-info__slot-sep">·</span>}
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
              {today?.isClosed && (
                <div className="hours-info__group hours-info__group--today">
                  <dt className="hours-info__day-label">
                    <span className="hours-info__today-badge">Hoy</span>
                    {DAY_LONG[today.day]}
                  </dt>
                  <dd className="hours-info__day-slots">
                    <span className="hours-info__slot hours-info__slot--closed">Cerrado</span>
                  </dd>
                </div>
              )}
            </dl>
          </div>
        )}

        {/* Dirección y envío en modo completo */}
        {mode === "full" && branch && (
          <>
            <div className="hours-info__row">
              <IconLocation className="hours-info__icon" width="20" height="20" />
              <span className="hours-info__address">{branch.address}</span>
            </div>
            {branch.deliveryInfo && (
              <div className="hours-info__row">
                <IconDelivery className="hours-info__icon" width="20" height="20" />
                <span className="hours-info__delivery">{branch.deliveryInfo}</span>
              </div>
            )}
          </>
        )}

        {/* Aviso de pausa */}
        {pause?.paused && (
          <div className="hours-info__row hours-info__row--pause">
            <IconPause className="hours-info__icon" width="20" height="20" />
            <span className="hours-info__pause">{pauseNotice(pause)}</span>
          </div>
        )}
      </div>
    </div>
  );
}