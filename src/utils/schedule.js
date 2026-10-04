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
  const time = next.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameDay) return `Cerrado ahora · Abrimos hoy a las ${time}`;
  const day = next.toLocaleDateString("es-AR", { weekday: "long" });
  return `Cerrado ahora · Abrimos ${day} a las ${time}`;
}

// ============================================================
// Mensaje de "la fecha elegida cae fuera de horario".
//
// Sale de `openWindows` y de nada más (BUG-04: antes el server tenía el
// texto escrito a mano, y para Tandil decía "todos los días de 19:00 a
// 23:00" cuando la cena de viernes y sábado es 19:30-23:30. Peor: el
// rechazo era correcto y el mensaje lo contradecía, porque el cliente
// veía "podés pedir de 19:00 a 23:00" y el server le rechazaba las 19:15
// del viernes). Si se cambia un horario en branches.js, el texto cambia
// solo: no hay una segunda copia que quedar vieja.
// ============================================================

// 0=dom … 6=sáb. Es el mismo orden que `days` en branches.js.
const DAY_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const DAY_LONG = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

// "lunes" · "Dom–Jue" · "Vie y Sáb" · "todos los días" · "Sáb y Dom"
function daysLabel(days) {
  const set = new Set(days);
  if (set.size === 7) return "todos los días";
  // Se recorre en orden de semana y se agrupan los días corridos, así un
  // tramo como [0,1,2,3,4] sale "Dom–Jue" y no "Dom, Lun, Mar, Mié, Jue".
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
  // Dos días van con "y" ("Vie y Sáb") y los tramos más largos con guion
  // ("Dom–Jue"): es el mismo criterio con el que están escritas las chains
  // `hours` de branches.js, para que el cartel y el mensaje del checkout
  // se lean igual.
  return tramos
    .map(([a, b]) => {
      if (a === b) return DAY_SHORT[a];
      return b - a === 1 ? `${DAY_SHORT[a]} y ${DAY_SHORT[b]}` : `${DAY_SHORT[a]}–${DAY_SHORT[b]}`;
    })
    .join(" y ");
}

// "todos los días 11:00 a 15:00 y 19:30 a 23:30" ·
// "Dom–Jue 11:30 a 15:30 y 19:00 a 23:00 · Vie y Sáb 11:30 a 15:30 y 19:30 a 23:30"
export function hoursSummary(branchId) {
  const windows = branchWindows(branchId);
  if (!windows) return "";
  // Se agrupan las ventanas que comparten los mismos días: el almuerzo y la
  // cena de un mismo tramo salen en una sola frase.
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

// Texto completo para el 400 de una fecha programada fuera de horario.
export function outsideHoursMessage(branchId) {
  const base = "Elegí una fecha y hora dentro de nuestros horarios.";
  const resumen = hoursSummary(branchId);
  if (!resumen) return base; // sucursal sin horarios cargados: no se inventa nada
  return `${base} Podemos recibir tu pedido ${resumen}.`;
}

// ============================================================
// Pausa de pedidos (estado operativo del local, server/branch-pause.js)
// ============================================================

// "14:30" — la hora argentina de un instante, sin importar la zona del
// runtime (el server de Render corre en UTC; el navegador del cliente,
// en su zona). Mismo truco que usa el server para validar los pedidos
// programados: se pasa el instante a wall clock argentino y se lo
// formatea en la zona local, así siempre sale la hora del local.
export function arClockLabel(ms) {
  const d = toWallclock(new Date(ms), "America/Argentina/Buenos_Aires");
  return d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// Aviso de pausa que se muestra en la TIENDA (menú, checkout, landing).
// El texto del RECHAZO del server (pauseMessage en server/branch-pause.js)
// es otro: acá no se repite "Por el momento no estamos tomando pedidos"
// en cada vista; cada componente muestra el aviso con su tono (pill del
// menú, nota del checkout, estado de la landing).
//
// El mensaje del local se renderiza como TEXTO de React en todos los
// componentes que usan esto (nunca dangerouslySetInnerHTML), así que un
// "<b>" se vería literal y no puede ejecutar nada.
export function pauseNotice(pause) {
  if (!pause?.paused) return "";
  const parts = ["No estamos tomando pedidos por ahora."];
  // El mensaje del local es texto libre: si no cierra con puntuación, se
  // le agrega el punto para que no se pegue con lo que sigue.
  if (pause.message) {
    parts.push(/[.!?…]$/.test(pause.message.trim()) ? pause.message : `${pause.message}.`);
  }
  if (pause.until) parts.push(`Volvemos a las ${arClockLabel(pause.until)}.`);
  return parts.join(" ");
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