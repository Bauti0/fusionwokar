// ============================================================
// FUSIÓN WOK — Núcleo compartido de horarios (puro, sin side-effects)
// Importable desde server/ y desde src/.
// Todas las funciones reciben las ventanas como parámetro.
// Zona horaria: America/Argentina/Buenos_Aires (fija).
// El tramo posterior a la medianoche pertenece al día de la apertura.
// ============================================================

const ARG_TZ = "America/Argentina/Buenos_Aires";

export const DAY_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
export const DAY_LONG = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

// Convierte "HH:MM" a minutos desde medianoche. null si inválido.
export function minutesOf(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

// Convierte un Date a wall clock en zona Argentina.
export function toWallclock(date, timeZone = ARG_TZ) {
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

// ¿La fecha está dentro de alguna ventana de apertura?
// windows: [{ days: number[], from: "HH:MM", to: "HH:MM" }]
// El tramo posterior a la medianoche (from > to) pertenece al día de la apertura.
export function isOpenAt(date, windows) {
  const day = date.getDay();
  const mins = date.getHours() * 60 + date.getMinutes();
  for (const w of windows) {
    const from = minutesOf(w.from);
    const to = minutesOf(w.to);
    if (from === null || to === null) continue;
    if (from > to) {
      // Cruza medianoche: [from, 24:00) del día de apertura + [00:00, to) del día siguiente
      if (w.days.includes(day) && mins >= from) return true;
      const prevDay = (day + 6) % 7;
      if (w.days.includes(prevDay) && mins < to) return true;
    } else {
      if (w.days.includes(day) && mins >= from && mins < to) return true;
    }
  }
  return false;
}

// Etiqueta legible de días: "lunes", "lunes y martes", "lunes–miércoles", "todos los días"
export function daysLabel(days) {
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

// Resumen de horarios: "Lun–Dom 11:00 a 15:00 y 19:30 a 23:30"
export function hoursSummary(windows) {
  if (!windows?.length) return "";
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

// Mensaje para fuera de horario
export function outsideHoursMessage(windows) {
  const base = "Elegí una fecha y hora dentro de nuestros horarios.";
  const resumen = hoursSummary(windows);
  if (!resumen) return base;
  return `${base} Podemos recibir tu pedido ${resumen}.`;
}

// Próxima apertura (Date en wall clock Argentina) o null
export function nextOpening(windows, from = new Date()) {
  if (!windows?.length) return null;
  const arFrom = toWallclock(from);
  const start = new Date(arFrom);
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
export function closedLabel(windows, now = new Date()) {
  if (!windows?.length) return null;
  const arNow = toWallclock(now);
  if (isOpenAt(arNow, windows)) return null;
  const next = nextOpening(windows, arNow);
  if (!next) return null;
  const sameDay = next.toDateString() === arNow.toDateString();
  const time = next.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameDay) return `Cerrado ahora · Abrimos hoy a las ${time}`;
  const day = next.toLocaleDateString("es-AR", { weekday: "long" });
  return `Cerrado ahora · Abrimos ${day} a las ${time}`;
}

// Próxima apertura para un día específico (o null si no hay)
export function getNextOpeningForDay(windows, dayIndex, from = new Date()) {
  if (!windows?.length) return null;
  const arFrom = toWallclock(from);
  const start = new Date(arFrom);
  start.setSeconds(0, 0);
  const startMs = start.getTime();
  // Buscar en los próximos 14 días
  for (let d = 0; d < 14; d++) {
    const day = (start.getDay() + d) % 7;
    if (day !== dayIndex) continue;
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

// Convierte filas de branch_hours (DB) al formato de ventanas
// rows: [{ day_of_week, slot, open_time, close_time, closed }]
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
  // Devolver [] (array vacío) si había filas pero ninguna ventana abierta
  // Esto permite distinguir "sucursal cerrada todo el tiempo" de "sin datos".
  return windows;
}

// Estructura de horarios para presentación en UI
// Retorna: {
//   today: { day: number, label: string, slots: [{from, to}], isClosed: boolean, isToday: boolean },
//   week: Array<{ day: number, label: string, short: string, slots: [{from, to}], isClosed: boolean, isToday: boolean, isFuture: boolean }>,
//   grouped: Array<{ days: number[], label: string, slots: [{from, to}] }>  // para resumen compacto
// }
// week ordenado lunes a domingo, con today resaltado
export function getStructuredHours(windows, now = new Date()) {
  if (!windows?.length) {
    // Sin datos: semana vacía, todos abiertos (compatibilidad)
    const today = toWallclock(now).getDay();
    const week = [];
    for (let d = 0; d < 7; d++) {
      const dayIndex = (d + 1) % 7; // lunes=0 ... domingo=6
      week.push({
        day: dayIndex,
        label: DAY_LONG[dayIndex],
        short: DAY_SHORT[dayIndex],
        slots: [],
        isClosed: false,
        isToday: dayIndex === today,
        isFuture: dayIndex !== today,
      });
    }
    return { today: week[today], week, grouped: [] };
  }

  // Construir mapa día -> slots
  const daySlots = new Map();
  for (const w of windows) {
    for (const d of w.days) {
      if (!daySlots.has(d)) daySlots.set(d, []);
      daySlots.get(d).push({ from: w.from, to: w.to });
    }
  }
  // Ordenar slots por hora de apertura
  for (const slots of daySlots.values()) {
    slots.sort((a, b) => minutesOf(a.from) - minutesOf(b.from));
  }

  const arNow = toWallclock(now);
  const today = arNow.getDay();

  // Semana lunes a domingo
  const week = [];
  for (let d = 0; d < 7; d++) {
    const dayIndex = (d + 1) % 7; // lunes=0 ... domingo=6
    const slots = daySlots.get(dayIndex) || [];
    const isClosed = slots.length === 0;
    const isNowOpen = !isClosed && isOpenAt(arNow, [{ days: [dayIndex], from: slots[0]?.from || "00:00", to: slots[slots.length - 1]?.to || "23:59" }]);
    week.push({
      day: dayIndex,
      label: DAY_LONG[dayIndex],
      short: DAY_SHORT[dayIndex],
      slots,
      isClosed, // día sin franjas (cerrado todo el día)
      isNowOpen, // está abierto AHORA
      isToday: dayIndex === today,
      isFuture: dayIndex !== today,
    });
  }

  // Hoy
  const todayInfo = week.find(w => w.isToday) || week[0];

  // Próxima apertura para hoy (si está cerrado ahora pero tiene franjas)
  const nextOpeningForToday = !todayInfo.isClosed && !todayInfo.isNowOpen
    ? getNextOpeningForDay(windows, todayInfo.day, now)
    : null;

  // Agrupación para resumen compacto (días consecutivos con mismos slots)
  const grouped = [];
  let currentGroup = null;
  for (const w of week) {
    const slotsKey = w.slots.map(s => `${s.from}-${s.to}`).join(",");
    if (currentGroup && currentGroup.slotsKey === slotsKey) {
      currentGroup.days.push(w.day);
    } else {
      if (currentGroup) grouped.push({ days: currentGroup.days, label: currentGroup.label, slots: currentGroup.slots });
      currentGroup = { days: [w.day], label: w.label, slots: w.slots, slotsKey };
    }
  }
  if (currentGroup) grouped.push({ days: currentGroup.days, label: currentGroup.label, slots: currentGroup.slots });

  return { today: { ...todayInfo, nextOpening: nextOpeningForToday }, week, grouped };
}

// Fallback a branches.js
export function branchWindowsFallback(branchId, BRANCHES) {
  const b = BRANCHES[branchId];
  return b && Array.isArray(b.openWindows) && b.openWindows.length ? b.openWindows : null;
}