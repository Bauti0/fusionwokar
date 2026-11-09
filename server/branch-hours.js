// ============================================================
// Horarios de apertura por sucursal — Lado SERVER
// Funciones puras que leen de la BD (branch_hours) con respaldo.
// Usa el núcleo compartido de src/utils/hoursCore.js
// ============================================================
import { BRANCHES } from "../src/data/branches.js";
import {
  toWallclock,
  isOpenAt,
  nextOpening as coreNextOpening,
  closedLabel as coreClosedLabel,
  hoursSummary as coreHoursSummary,
  outsideHoursMessage as coreOutsideHoursMessage,
  rowsToWindows,
  branchWindowsFallback,
} from "../src/utils/hoursCore.js";

export { toWallclock, isOpenAt, rowsToWindows, branchWindowsFallback };

// Validación de HH:MM (0-23:0-59)
export function isValidHHMM(hhmm) {
  if (typeof hhmm !== "string") return false;
  const m = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!m) return false;
  const h = Number(m[1]);
  const m2 = Number(m[2]);
  return h >= 0 && h <= 23 && m2 >= 0 && m2 <= 59;
}

// ¿La fecha está dentro de alguna ventana de apertura? (server)
// date se evalúa SIEMPRE en America/Argentina/Buenos_Aires
export async function isOpenAtTime(db, branchId, date) {
  const arDate = toWallclock(date);
  const windows = await getBranchWindows(db, branchId);
  const finalWindows = windows ?? branchWindowsFallback(branchId, BRANCHES);
  if (!finalWindows) return true;
  return isOpenAt(arDate, finalWindows);
}

// Obtiene ventanas desde la BD
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

// Próxima apertura
export async function nextOpening(db, branchId, from = new Date()) {
  const windows = await getBranchWindows(db, branchId);
  const finalWindows = windows ?? branchWindowsFallback(branchId, BRANCHES);
  if (!finalWindows) return null;
  return coreNextOpening(finalWindows, from);
}

// Etiqueta "Cerrado ahora · Abrimos …"
export async function closedLabel(db, branchId, now = new Date()) {
  const windows = await getBranchWindows(db, branchId);
  const finalWindows = windows ?? branchWindowsFallback(branchId, BRANCHES);
  if (!finalWindows) return null;
  return coreClosedLabel(finalWindows, now);
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
    if (d.slots)
      d.slots.sort((a, b) => {
        const ao = minutesOf(a.open),
          ac = minutesOf(a.close);
        const bo = minutesOf(b.open),
          bc = minutesOf(b.close);
        return ao - bo || ac - bc;
      });
  }

  return byDay;
}

// Convierte una fila de products en el objeto de producto del menú
export async function hoursSummary(db, branchId) {
  const windows = await getBranchWindows(db, branchId);
  const finalWindows = windows ?? branchWindowsFallback(branchId, BRANCHES);
  return coreHoursSummary(finalWindows);
}

export async function outsideHoursMessage(db, branchId) {
  const windows = await getBranchWindows(db, branchId);
  const finalWindows = windows ?? branchWindowsFallback(branchId, BRANCHES);
  return coreOutsideHoursMessage(finalWindows);
}

// Helper local para validación
function minutesOf(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}