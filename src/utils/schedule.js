// ============================================================
// Horarios de apertura por sucursal
// Funciones puras, sin DOM: se usan en el cliente (menú/checkout)
// y en el server (validación de pedidos programados).
// Exporta versiones SÍNCRONAS (usan branches.js) y ASÍNCRONAS (usan API/BD).
// ============================================================
import { BRANCHES } from "../data/branches.js";

// Convierte "HH:MM" a minutos desde medianoche. null si inválido.
export function minutesOf(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

// Obtiene las ventanas de apertura de una sucursal desde branches.js
function branchWindows(branchId) {
  const b = BRANCHES[branchId];
  return b && Array.isArray(b.openWindows) && b.openWindows.length ? b.openWindows : null;
}

// ============================================================
// VERSIÓN SÍNCRONA (usa branches.js) — para tests y server sin BD
// ============================================================

// ¿La fecha está dentro de alguna ventana de apertura?
// date: Date (se evalúa en la zona horaria del runtime).
// Función interna que acepta ventanas personalizadas (exportada para tests como isOpenAtRaw).
function isOpenAt(date, windows) {
  const day = date.getDay();
  const mins = date.getHours() * 60 + date.getMinutes();
  for (const w of windows) {
    const from = minutesOf(w.from);
    const to = minutesOf(w.to);
    if (from === null || to === null) continue;
    if (from > to) {
      if (w.days.includes(day) && mins >= from) return true;
      const prevDay = (day + 6) % 7;
      if (w.days.includes(prevDay) && mins < to) return true;
    } else {
      if (w.days.includes(day) && mins >= from && mins < to) return true;
    }
  }
  return false;
}

// Exportado para tests: verifica si una fecha cae dentro de alguna ventana
// (versión raw que acepta ventanas personalizadas, usada solo en tests)
export function isOpenAtRaw(date, windows) {
  return isOpenAt(date, windows);
}

// ¿La fecha está dentro de alguna ventana de apertura? (versión síncrona con branches.js)
export function isOpenAtTimeSync(branchId, date) {
  const windows = branchWindows(branchId);
  return !windows || isOpenAt(date, windows);
}

export function isNowOpenSync(branchId) {
  return isOpenAtTimeSync(branchId, new Date());
}

// Próxima apertura (Date) o null si no hay ventanas definidas.
export function nextOpeningSync(branchId, from = new Date()) {
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
export function closedLabelSync(branchId, now = new Date()) {
  if (isNowOpenSync(branchId)) return null;
  const next = nextOpeningSync(branchId, now);
  if (!next) return null;
  const sameDay = next.toDateString() === now.toDateString();
  const time = next.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameDay) return `Cerrado ahora · Abrimos hoy a las ${time}`;
  const day = next.toLocaleDateString("es-AR", { weekday: "long" });
  return `Cerrado ahora · Abrimos ${day} a las ${time}`;
}

// ============================================================
// Mensajes y resúmenes SÍNCRONOS (usan branches.js)
// ============================================================

const DAY_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const DAY_LONG = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function daysLabel(days) {
  const set = new Set(days);
  if (set.size === 7) return "todos los días";
  const tramos = [];
  let actual = null;
  for (let d = 0; d < 7; d++) {
    if (set.has(d)) {
      if (actual) actual[1] = d;
      else actual = [d, d];
    } else if (actual) {
      tramos.push(actual);
      actual = null;
    }
  }
  if (actual) tramos.push(actual);
  if (tramos.length === 1 && tramos[0][0] === tramos[0][1]) return DAY_LONG[tramos[0][0]];
  return tramos
    .map(([a, b]) => {
      if (a === b) return DAY_SHORT[a];
      return b - a === 1 ? `${DAY_SHORT[a]} y ${DAY_SHORT[b]}` : `${DAY_SHORT[a]}–${DAY_SHORT[b]}`;
    })
    .join(" y ");
}

function getWindowsForSummarySync(branchId) {
  return branchWindows(branchId);
}

export function hoursSummarySync(branchId) {
  const windows = getWindowsForSummarySync(branchId);
  if (!windows) return "";
  const grupos = [];
  for (const w of windows) {
    const dias = [...new Set(w.days)].sort((a, b) => a - b).join(",");
    const rango = `${w.from} a ${w.to}`;
    const grupo = grupos.find((g) => g.dias === dias);
    if (grupo) grupo.rangos.push(rango);
    else grupos.push({ dias, etiqueta: daysLabel(w.days), rangos: [rango] });
  }
  return grupos.map((g) => `${g.etiqueta} ${g.rangos.join(" y ")}`).join(" · ");
}

export function outsideHoursMessageSync(branchId) {
  const base = "Elegí una fecha y hora dentro de nuestros horarios.";
  const resumen = hoursSummarySync(branchId);
  if (!resumen) return base;
  return `${base} Podemos recibir tu pedido ${resumen}.`;
}



// ============================================================
// VERSIÓN ASÍNCRONA (usa API/BD) — para cliente en producción
// ============================================================

// Convierte filas de branch_hours al formato de ventanas.
export function rowsToWindows(rows) {
  if (!rows?.length) return null;
  const byDay = new Map();
  for (const r of rows) {
    const day = Number(r.day_of_week);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    const from = minutesOf(r.open_time);
    const to = minutesOf(r.close_time);
    if (from === null || to === null) continue;
    byDay.get(day).push({
      from: r.open_time,
      to: r.close_time,
      closed: r.closed === 1,
      slot: r.slot,
    });
  }
  for (const arr of byDay.values()) {
    arr.sort((a, b) => a.slot - b.slot);
  }
  const windows = [];
  for (const [day, slots] of byDay) {
    for (const s of slots) {
      if (s.closed) continue;
      windows.push({ days: [day], from: s.from, to: s.to });
    }
  }
  return windows.length ? windows : null;
}

// Convierte un Date a wall clock en zona fija (Argentina).
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

// Cliente: fetch a /api/branch-hours/:branchId
export async function getBranchWindowsClient(branchId) {
  try {
    const res = await fetch(`/api/branch-hours/${encodeURIComponent(branchId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return rowsToWindows(data.rows || []);
  } catch {
    return null;
  }
}

// ¿La fecha está dentro de alguna ventana? (usa BD con respaldo automático)
export async function isOpenAtTimeAsync(branchId, date) {
  const arDate = toWallclock(date);
  const windows = await getBranchWindowsClient(branchId);
  const finalWindows = windows ?? branchWindows(branchId);
  if (!finalWindows) return true;
  return isOpenAt(arDate, finalWindows);
}

export async function isNowOpenAsync(branchId) {
  return isOpenAtTimeAsync(branchId, new Date());
}

// Próxima apertura (async)
export async function nextOpeningAsync(branchId, from = new Date()) {
  const arFrom = toWallclock(from);
  const windows = await getBranchWindowsClient(branchId);
  const finalWindows = windows ?? branchWindows(branchId);
  if (!finalWindows) return null;
  const start = new Date(arFrom);
  start.setSeconds(0, 0);
  const startMs = start.getTime();
  for (let d = 0; d < 14; d++) {
    const day = (start.getDay() + d) % 7;
    const base = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d, 0, 0, 0, 0);
    for (const w of finalWindows) {
      const fromMin = minutesOf(w.from);
      if (fromMin === null || !w.days.includes(day)) continue;
      const next = new Date(base);
      next.setHours(Math.floor(fromMin / 60), fromMin % 60, 0, 0);
      if (next.getTime() > startMs) return next;
    }
  }
  return null;
}

// Etiqueta "Cerrado ahora · Abrimos …" (async)
export async function closedLabelAsync(branchId, now = new Date()) {
  if (await isOpenAtTimeAsync(branchId, now)) return null;
  const next = await nextOpeningAsync(branchId, now);
  if (!next) return null;
  const sameDay = next.toDateString() === now.toDateString();
  const time = next.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameDay) return `Cerrado ahora · Abrimos hoy a las ${time}`;
  const day = next.toLocaleDateString("es-AR", { weekday: "long" });
  return `Cerrado ahora · Abrimos ${day} a las ${time}`;
}

// Mensajes y resúmenes ASYNC
export async function hoursSummaryAsync(branchId) {
  const windows = await getBranchWindowsClient(branchId);
  const finalWindows = windows ?? branchWindows(branchId);
  if (!finalWindows) return "";
  const grupos = [];
  for (const w of finalWindows) {
    const dias = [...new Set(w.days)].sort((a, b) => a - b).join(",");
    const rango = `${w.from} a ${w.to}`;
    const grupo = grupos.find((g) => g.dias === dias);
    if (grupo) grupo.rangos.push(rango);
    else grupos.push({ dias, etiqueta: daysLabel(w.days), rangos: [rango] });
  }
  return grupos.map((g) => `${g.etiqueta} ${g.rangos.join(" y ")}`).join(" · ");
}

export async function outsideHoursMessageAsync(branchId) {
  const base = "Elegí una fecha y hora dentro de nuestros horarios.";
  const resumen = await hoursSummaryAsync(branchId);
  if (!resumen) return base;
  return `${base} Podemos recibir tu pedido ${resumen}.`;
}

// ============================================================
// Pausa de pedidos (estado operativo del local, server/branch-pause.js)
// ============================================================

export function arClockLabel(ms) {
  const d = toWallclock(new Date(ms), "America/Argentina/Buenos_Aires");
  return d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function pauseNotice(pause) {
  if (!pause?.paused) return "";
  const parts = ["No estamos tomando pedidos por ahora."];
  if (pause.message) {
    parts.push(/[.!?…]$/.test(pause.message.trim()) ? pause.message : `${pause.message}.`);
  }
  if (pause.until) parts.push(`Volvemos a las ${arClockLabel(pause.until)}.`);
  return parts.join(" ");
}

// Alias de compatibilidad (los tests y código viejo usan estos nombres sin Sync)
export const isOpenAtTime = isOpenAtTimeSync;
export const isNowOpen = isNowOpenSync;
export const nextOpening = nextOpeningSync;
export const closedLabel = closedLabelSync;
export const hoursSummary = hoursSummarySync;
export const outsideHoursMessage = outsideHoursMessageSync;