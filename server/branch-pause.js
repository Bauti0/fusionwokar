// ============================================================
// FUSIÓN WOK — Pausa de pedidos por sucursal
//
// El problema: cuando el local no puede tomar más pedidos (se
// quedaron sin cajitas al mediodía, la cocina se saturó, un corte de
// luz), la única salida era cancelar los pedidos que ya entraron. No
// había forma de frenar que ENTREN pedidos nuevos un rato.
//
// La solución: el panel pausa una sucursal por un tiempo (30 min,
// 1 h, 2 h) o "hasta reanudar", con un mensaje opcional que se le
// muestra al cliente. POST /api/orders rechaza con 423 mientras la
// sucursal esté pausada; el menú, el checkout y la landing muestran
// el aviso con la hora de reapertura.
//
// Decisiones que fijan estos tests (test/branch-pause.test.js):
//
//  1. La reapertura es AUTOMÁTICA y sin cron: `paused_until` se
//     evalúa al leer (pauseState). Una pausa vencida es lo mismo que
//     no estar pausado, sin ningún job que la limpie.
//  2. La pausa es POR SUCURSAL: una fila por branch (PK). Pausar
//     Tandil no toca Necochea.
//  3. "Hasta reanudar" es un flag: paused_indefinitely=1 con
//     paused_until=NULL. Si queda un until viejo de una pausa
//     anterior, el flag manda (no puede reabrir solo).
//  4. Reanudar limpia TODO el estado, mensaje incluido: el aviso no
//     puede quedar colgado con los pedidos ya reabiertos.
//
// Puro + SQL, sin imports del server: recibe `db` por parámetro y el
// reloj (`nowMs`/`nowIso`) por parámetro (patrón de coupons.js /
// order-idempotency.js), para que los tests lo corran contra un
// SQLite en memoria sin importar server/db.js — importarlo
// dispararía las migraciones contra la base real.
//
// El único import es la hora argentina (arClockLabel), que vive en
// src/utils/schedule.js: la comparten el server (Render corre en
// UTC) y el cliente, y es la misma que usa la validación de pedidos
// programados.
// ============================================================

import { arClockLabel } from "../src/utils/schedule.js";

// Rango de la pausa temporizada. Mínimo 5 min (pausar 1 min no le
// sirve a nadie y solo genera mensajes de vencimiento raros) y
// máximo 24 h (más que eso es "hasta reanudar").
export const PAUSE_MIN_MINUTES = 5;
export const PAUSE_MAX_MINUTES = 1440; // 24 h

// El mensaje se muestra en una línea (pill del menú, badge del panel,
// aviso del checkout): tope corto y sin HTML ni saltos.
export const PAUSE_MESSAGE_MAX = 140;

// Caracteres de control (salto de línea, tab, etc.) en un texto de una
// línea. Loop con codePointAt y no regex de control: es el mismo criterio
// que server/order-log.js (flatten) y no dispara no-control-regex.
function hasControlChars(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

// Texto base del rechazo. Es el MISMO literal que viaja en la
// respuesta 423 y en la línea de log (server/order-log.js loguea
// siempre el mismo texto que se respondió, ver warnOrder).
const PAUSE_BASE = "Por el momento no estamos tomando pedidos.";

// ------------------------------------------------------------
// Estado: fila → { paused, until, message }
// ------------------------------------------------------------
// Pura, sin DB y sin reloj propio (`nowMs` llega por parámetro).
//   paused  → true si la sucursal está frenada AHORA
//   until   → epoch ms de la reapertura, o null ("hasta reanudar",
//             o ya venció: no hay hora que prometer)
//   message → texto del local, "" si no escribió ninguno
export function pauseState(row, nowMs) {
  if (!row || typeof row !== "object") return { paused: false, until: null, message: "" };
  const message = typeof row.pause_message === "string" ? row.pause_message : "";
  const indefinitely = Number(row.paused_indefinitely) === 1;
  const until = Number(row.paused_until) || 0;
  // Vencida (o nunca pausada): reabierta. El mensaje se limpia
  // también: un aviso viejo con la sucursal funcionando confunde más
  // de lo que explica.
  if (!indefinitely && !(until > nowMs)) return { paused: false, until: null, message: "" };
  return {
    paused: true,
    // "Hasta reanudar" no tiene hora; el flag manda por encima de un
    // until que haya quedado de una pausa anterior.
    until: indefinitely ? null : until,
    message,
  };
}

// Estado de una sucursal. Sin fila = no pausada (una sucursal que
// nunca se pausó no necesita que se le siembre nada).
export async function getPause(db, branch, nowMs) {
  const row = await db
    .prepare("SELECT paused_until, paused_indefinitely, pause_message FROM branch_settings WHERE branch = ?")
    .get(branch);
  return pauseState(row, nowMs);
}

// Estado de TODAS las sucursales con fila, en la misma forma que la
// respuesta del panel y del endpoint público ({ branches: {...} }),
// para que el frontend no bifurque por endpoint.
export async function getAllPauses(db, nowMs) {
  const rows = await db
    .prepare("SELECT branch, paused_until, paused_indefinitely, pause_message FROM branch_settings")
    .all();
  const branches = {};
  for (const row of rows) branches[row.branch] = pauseState(row, nowMs);
  return { branches };
}

// ------------------------------------------------------------
// Escrituras (upsert: una fila por sucursal, la PK hace el resto)
// ------------------------------------------------------------
// El mismo SQL sirve para pausar y reanudar: reanudar es escribir el
// estado limpio (0 / NULL / ''). Así no hay dos formas de tocar la
// fila y reanudar una sucursal sin fila no puede fallar.
const UPSERT_PAUSE_SQL = `
  INSERT INTO branch_settings (branch, paused_until, paused_indefinitely, pause_message, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(branch) DO UPDATE SET
    paused_until = excluded.paused_until,
    paused_indefinitely = excluded.paused_indefinitely,
    pause_message = excluded.pause_message,
    updated_at = excluded.updated_at
`;

// Pausa una sucursal. `until` es epoch ms o null con indefinite=true.
// No valida nada: la validación es de la request (parsePauseRequest)
// y el endpoint es quien la llama; acá se confía en los datos ya
// limpios para que los tests puedan escribir estados borde directo.
export async function setPause(db, { branch, until = null, indefinite = false, message = "", nowIso }) {
  await db.prepare(UPSERT_PAUSE_SQL).run(branch, indefinite ? null : until, indefinite ? 1 : 0, message, nowIso);
}

// Reanuda: deja la fila en el estado limpio. La fila puede quedar
// (con ceros): para el estado es lo mismo que no existir.
export async function clearPause(db, { branch, nowIso }) {
  await db.prepare(UPSERT_PAUSE_SQL).run(branch, null, 0, "", nowIso);
}

// ------------------------------------------------------------
// Texto que ve el cliente
// ------------------------------------------------------------
// "Por el momento no estamos tomando pedidos. <mensaje del local>.
//  Volvemos a las HH:MM." (hora argentina, sin importar la zona del
// server). Con `scheduled: true` agrega la aclaración de que los
// pedidos programados también quedan pausados: la pausa frena TODO,
// no solo lo inmediato, y el cliente tiene que saberlo antes de
// armarse un carrito para dentro de dos horas.
//
// El mensaje del local se valida sin HTML ni caracteres de control
// (parsePauseRequest), y del lado del cliente lo renderiza React
// como TEXTO (nunca dangerouslySetInnerHTML): no se interpola en
// ningún HTML del server ni del front.
export function pauseMessage(pause, { scheduled = false } = {}) {
  const p = pause && typeof pause === "object" ? pause : {};
  if (!p.paused) return "";
  const parts = [PAUSE_BASE];
  // El mensaje del local es texto libre: si no cierra con puntuación de
  // frase, se le agrega el punto para que no se pegue con lo que sigue
  // ("sin cajitas Volvemos a las 14:30" no se lee).
  if (p.message) {
    parts.push(/[.!?…]$/.test(p.message.trim()) ? p.message : `${p.message}.`);
  }
  if (p.until) parts.push(`Volvemos a las ${arClockLabel(p.until)}.`);
  if (scheduled) parts.push("Esto incluye los pedidos programados.");
  return parts.join(" ");
}

// ------------------------------------------------------------
// Validación de la request del panel (PUT /api/admin/branch-pause)
// ------------------------------------------------------------
// Pura: recibe el body crudo y devuelve
//   { action: "pause", minutes, indefinite, message } → pausar
//   { action: "resume" }                                → reanudar
//   { error: "..." }                                    → el endpoint responde 400
//
// La sucursal NO se valida acá: sale de la sesión (branch_admin) o
// la elige el superadmin, y eso ya lo resuelve effectiveBranch en el
// endpoint (mismo 400 indistinguible que el resto del panel).
export function parsePauseRequest(body) {
  const b = body && typeof body === "object" ? body : {};
  const action = typeof b.action === "string" ? b.action.trim().toLowerCase() : "";
  if (action === "resume") return { action: "resume" };
  if (action !== "pause") return { error: "Acción inválida" };

  // Duración: minutos (temporizada) o indefinite (hasta reanudar).
  // Una u otra: aceptar ambas a la vez dejaría la pausa ambigua.
  const indefinite = b.indefinite === true;
  const hasMinutes = b.minutes !== undefined && b.minutes !== null && b.minutes !== "";
  if (indefinite && hasMinutes) return { error: "Elegí una duración: minutos o hasta reanudar, no ambos." };
  if (!indefinite && !hasMinutes) return { error: "Elegí cuánto tiempo pausar los pedidos." };

  let minutes = null;
  if (!indefinite) {
    minutes = Number(b.minutes);
    if (!Number.isInteger(minutes)) {
      return { error: "La duración de la pausa tiene que ser un número entero de minutos." };
    }
    if (minutes < PAUSE_MIN_MINUTES) return { error: `La pausa mínima es de ${PAUSE_MIN_MINUTES} minutos.` };
    if (minutes > PAUSE_MAX_MINUTES) {
      return { error: `La pausa no puede superar las ${PAUSE_MAX_MINUTES / 60} horas. Usá "Hasta reanudar".` };
    }
  }

  // Mensaje opcional que se muestra a los clientes: texto, corto, en
  // una sola línea y sin HTML (se renderiza como texto, pero que ni
  // llegue es una capa más).
  let message = "";
  if (b.message !== undefined && b.message !== null && b.message !== "") {
    if (typeof b.message !== "string") return { error: "El mensaje tiene que ser texto." };
    message = b.message.trim();
    if (message.length > PAUSE_MESSAGE_MAX) {
      return { error: `El mensaje no puede superar los ${PAUSE_MESSAGE_MAX} caracteres.` };
    }
    if (/[<>]/.test(message)) return { error: "El mensaje no puede contener HTML." };
    // Caracteres de control (salto de línea, tab, etc.): el mensaje se
    // muestra en una línea en el menú, el checkout y el panel. Mismo
    // criterio que server/order-log.js (flatten): código < 32 o DEL.
    if (hasControlChars(message)) {
      return { error: "El mensaje no puede tener saltos de línea ni caracteres de control." };
    }
  }

  return { action: "pause", minutes, indefinite, message };
}
