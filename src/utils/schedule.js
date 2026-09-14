// ============================================================
// Horarios de apertura por sucursal
// Funciones puras, sin DOM: se usan en el cliente (menú/checkout)
// y en el server (validación de pedidos programados).
// Las ventanas viven en src/data/branches.js (`openWindows`).
// ============================================================
import { BRANCHES } from "../data/branches.js";

function minutesOf(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function isOpenAt(date, windows) {
  const day = date.getDay();
  const mins = date.getHours() * 60 + date.getMinutes();
  for (const w of windows) {
    const from = minutesOf(w.from);
    const to = minutesOf(w.to);
    if (from === null || to === null) continue;
    if (w.days.includes(day) && mins >= from && mins < to) return true;
  }
  return false;
}

function branchWindows(branchId) {
  const b = BRANCHES[branchId];
  return b && Array.isArray(b.openWindows) && b.openWindows.length ? b.openWindows : null;
}

// ¿La fecha está dentro de alguna ventana de apertura?
// date: Date (se evalúa en la zona horaria del runtime).
export function isOpenAtTime(branchId, date) {
  const windows = branchWindows(branchId);
  return !windows || isOpenAt(date, windows); // sin ventanas → no bloqueamos
}

export function isNowOpen(branchId) {
  return isOpenAtTime(branchId, new Date());
}

// Próxima apertura (Date) o null si no hay ventanas definidas.
export function nextOpening(branchId, from = new Date()) {
  const windows = branchWindows(branchId);
  if (!windows) return null;
  const start = new Date(from);
  start.setSeconds(0, 0);
  const startMs = start.getTime();
  for (let d = 0; d < 14; d++) {
    const day = (start.getDay() + d) % 7;
    const base = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d, 0, 0, 0, 0);
    for (const w of windows) {
      const fromMin = minutesOf(w.from);
      if (fromMin === null || !w.days.includes(day)) continue;
      const next = new Date(base);
      next.setHours(Math.floor(fromMin / 60), fromMin % 60, 0, 0);
      if (next.getTime() > startMs) return next;
    }
  }
  return null;
}

// Etiqueta "Cerrado ahora · Abrimos …" (o null si está abierto / sin datos)
export function closedLabel(branchId, now = new Date()) {
  if (isNowOpen(branchId)) return null;
  const next = nextOpening(branchId, now);
  if (!next) return null;
  const sameDay = next.toDateString() === now.toDateString();
  const time = next.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `Cerrado ahora · Abrimos hoy a las ${time}`;
  const day = next.toLocaleDateString("es-AR", { weekday: "long" });
  return `Cerrado ahora · Abrimos ${day} a las ${time}`;
}

// Convierte un instante a un Date local (wall clock) de una zona fija.
// Sirve para validar horarios de apertura en la zona del negocio aunque
// el runtime corra en UTC (cliente OK, server determinista).
export function toWallclock(date, timeZone = "America/Argentina/Buenos_Aires") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  let h = get("hour");
  if (h === 24) h = 0;
  return new Date(get("year"), get("month") - 1, get("day"), h, get("minute"), get("second"));
}