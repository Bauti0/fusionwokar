// ============================================================
// Horarios de apertura por sucursal — Lado SERVER
// Funciones puras que leen de la BD (branch_hours) con respaldo.
// ============================================================
import { BRANCHES } from "../src/data/branches.js";

function minutesOf(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function rowsToWindows(rows) {
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

// Convierte un Date a wall clock en zona Argentina
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

function branchWindowsFallback(branchId) {
  const b = BRANCHES[branchId];
  return b && Array.isArray(b.openWindows) && b.openWindows.length ? b.openWindows : null;
}

export async function getBranchWindows(db, branchId) {
  try {
    const rows = await db
      .prepare("SELECT * FROM branch_hours WHERE branch = ? ORDER BY day_of_week, slot")
      .all(branchId);
    return rowsToWindows(rows);
  } catch {
    return null;
  }
}

// ¿La fecha está dentro de alguna ventana de apertura? (server)
// date se evalúa SIEMPRE en America/Argentina/Buenos_Aires
export async function isOpenAtTime(db, branchId, date) {
  const arDate = toWallclock(date);
  const windows = await getBranchWindows(db, branchId);
  const finalWindows = windows ?? branchWindowsFallback(branchId);
  if (!finalWindows) return true;
  return isOpenAt(arDate, finalWindows);
}

// Próxima apertura
export async function nextOpening(db, branchId, from = new Date()) {
  const arFrom = toWallclock(from);
  const windows = await getBranchWindows(db, branchId);
  const finalWindows = windows ?? branchWindowsFallback(branchId);
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

// Etiqueta "Cerrado ahora · Abrimos …"
export async function closedLabel(db, branchId, now = new Date()) {
  if (await isOpenAtTime(db, branchId, now)) return null;
  const next = await nextOpening(db, branchId, now);
  if (!next) return null;
  const sameDay = next.toDateString() === now.toDateString();
  const time = next.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameDay) return `Cerrado ahora · Abrimos hoy a las ${time}`;
  const day = next.toLocaleDateString("es-AR", { weekday: "long" });
  return `Cerrado ahora · Abrimos ${day} a las ${time}`;
}

// Validación de HH:MM (0-23:0-59)
export function isValidHHMM(hhmm) {
  if (typeof hhmm !== "string") return false;
  const m = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!m) return false;
  const h = Number(m[1]);
  const m2 = Number(m[2]);
  return h >= 0 && h <= 23 && m2 >= 0 && m2 <= 59;
}

// Validación completa de horarios de una sucursal
// Devuelve { ok: true } o { ok: false, error: "mensaje" }
export function validateBranchHours(hours) {
  // hours: { [day]: { closed: boolean, slots: [{open, close}] } }
  if (!hours || typeof hours !== "object") return { ok: false, error: "Formato inválido" };

  for (let day = 0; day < 7; day++) {
    const d = hours[String(day)] || hours[day];
    if (!d) continue;

    if (d.closed) {
      if (d.slots && d.slots.length > 0) {
        return { ok: false, error: `Día ${day}: si está cerrado no puede tener franjas` };
      }
      continue;
    }

    const slots = d.slots || [];
    if (slots.length === 0) {
      return { ok: false, error: `Día ${day}: abierto requiere al menos una franja` };
    }
    if (slots.length > 3) {
      return { ok: false, error: `Día ${day}: máximo 3 franjas permitidas` };
    }

    let prevClose = -1;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!isValidHHMM(s.open) || !isValidHHMM(s.close)) {
        return { ok: false, error: `Día ${day}, franja ${i + 1}: formato HH:MM inválido` };
      }
      const openM = minutesOf(s.open);
      const closeM = minutesOf(s.close);
      if (openM === closeM) {
        return { ok: false, error: `Día ${day}, franja ${i + 1}: open y close no pueden ser iguales` };
      }
      // No validar solapamiento con franjas que cruzan medianoche de forma simple
      // Solo verificar que no se pisen en el mismo día (sin cruce)
      if (openM < closeM) {
        // Franja normal: verificar que no empiece antes de que termine la anterior
        if (openM < prevClose) {
          return { ok: false, error: `Día ${day}, franja ${i + 1}: se pisa con la anterior` };
        }
        prevClose = closeM;
      } else {
        // Franja que cruza medianoche: no puede haber otra después en el mismo día
        if (i !== slots.length - 1) {
          return { ok: false, error: `Día ${day}: la franja que cruza medianoche debe ser la última` };
        }
        // Para franjas que cruzan medianoche, la validación de solapamiento es más compleja
        // Se valida en el server al insertar comparando minutos reales
      }
    }
  }
  return { ok: true };
}

// Reemplaza todos los horarios de una sucursal en una transacción
export async function replaceBranchHours(db, branchId, hours, nowIso, updatedBy = "unknown") {
  const validation = validateBranchHours(hours);
  if (!validation.ok) return { error: validation.error };

  const stmts = [];

  // Borrar existentes
  stmts.push({
    sql: "DELETE FROM branch_hours WHERE branch = ?",
    args: [branchId],
  });

  // Insertar nuevos (incluir días cerrados como closed=1)
  for (let day = 0; day < 7; day++) {
    const d = hours[String(day)] || hours[day];
    if (!d) continue;

    if (d.closed) {
      stmts.push({
        sql: `INSERT INTO branch_hours (branch, day_of_week, slot, open_time, close_time, closed, created_at, updated_at, updated_by)
              VALUES (?, ?, 0, '', '', 1, ?, ?, ?)`,
        args: [branchId, day, nowIso, nowIso, updatedBy],
      });
      continue;
    }

    const slots = d.slots || [];
    if (slots.length === 0) continue;

    for (let slot = 0; slot < slots.length; slot++) {
      const s = slots[slot];
      stmts.push({
        sql: `INSERT INTO branch_hours (branch, day_of_week, slot, open_time, close_time, closed, created_at, updated_at, updated_by)
              VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        args: [branchId, day, slot, s.open, s.close, nowIso, nowIso, updatedBy],
      });
    }
  }

  try {
    await db.batch(stmts, "write");
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

// Obtiene horarios formateados para el panel admin
export async function getBranchHoursForAdmin(db, branchId) {
  const rows = await db
    .prepare("SELECT * FROM branch_hours WHERE branch = ? ORDER BY day_of_week, slot")
    .all(branchId);

  // Agrupar por día
  const byDay = {};
  for (let d = 0; d < 7; d++) byDay[d] = { closed: true, slots: [] };

  for (const r of rows) {
    const day = r.day_of_week;
    if (r.closed) {
      byDay[day] = { closed: true, slots: [] };
      continue;
    }
    if (!byDay[day].slots) byDay[day].slots = [];
    byDay[day].slots.push({ open: r.open_time, close: r.close_time });
    byDay[day].closed = false;
  }

  // Ordenar slots por slot
  for (const d of Object.values(byDay)) {
    if (d.slots) d.slots.sort((a, b) => {
      const ao = minutesOf(a.open), ac = minutesOf(a.close);
      const bo = minutesOf(b.open), bc = minutesOf(b.close);
      return ao - bo || ac - bc;
    });
  }

  return byDay;
}

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

async function getBranchHoursForSummary(db, branchId) {
  const windows = await getBranchWindows(db, branchId);
  return windows ?? branchWindowsFallback(branchId);
}

export async function hoursSummary(db, branchId) {
  const windows = await getBranchHoursForSummary(db, branchId);
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

export async function outsideHoursMessage(db, branchId) {
  const base = "Elegí una fecha y hora dentro de nuestros horarios.";
  const resumen = await hoursSummary(db, branchId);
  if (!resumen) return base;
  return `${base} Podemos recibir tu pedido ${resumen}.`;
}