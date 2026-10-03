// ============================================================
// Rango de fechas para los filtros del panel admin.
// "YYYY-MM-DD" se interpreta como HORA LOCAL (Argentina), NO como
// la medianoche UTC que genera new Date("YYYY-MM-DD"). De no ser
// así, un rango de un solo día ("Hoy") quedaba de ancho cero y el
// último día del rango quedaba excluido siempre.
// ============================================================

export function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Etiqueta de dia para el grafico de ventas del admin ("lun", "mar", ...).
// La fecha viene del servidor como dia calendario de Argentina, asi que se
// parsea a la midnight local: new Date(fecha) seria UTC y correria el dia.
export function dayShort(isoDate) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString("es-AR", {
    weekday: "short",
  });
}

// "jue 1/10" para el pie de cada barra del gráfico: día de la semana + día/mes.
//
// El día/mes se arma a mano en vez de pedirlo a toLocaleDateString: el ICU de
// es-AR NO rellena con cero cuando no hay año en el formato (devuelve "1/10",
// no "01/10"), y el ancho de la columna de la barra necesita un ancho estable
// entre los días.
export function dayLabel(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
}

// "Caja abierta desde 02/10/2026 11:35" y la fecha del historial de arqueos.
// Hora de 24 h sin AM/PM: "11:35 a. m." duplicaba el ancho de la línea y la
// desplazaba del centro de la tarjeta.
export function dateTimeShort(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// "02/10/2026" (sin hora) para las filas del historial.
export function dateShort(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// ¿Es `isoDate` el día de HOY, según el reloj de Argentina?
//
// El servidor agrupa por arDay() = día calendario de America/Argentina/
// Buenos_Aires, así que el "hoy" que hay que resaltar es el del local, NO el
// del navegador ni el UTC. Entre las 21:00 y las 24:00 ARG los tres difieren:
// a las 23:30 ya es el día siguiente en UTC, así que comparar contra
// new Date() "cortaría" el resaltado en el día anterior.
//
// `now` es inyectable por la misma razón que `dayOf` en server/reports.js:
// para poder probar los bordes de las 23:30 y las 00:00 sin depender de la
// hora en que corre el test.
const AR_TODAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Argentina/Buenos_Aires",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function isToday(isoDate, now = new Date()) {
  if (!isoDate || typeof isoDate !== "string") return false;
  return AR_TODAY_FORMAT.format(now) === isoDate.slice(0, 10);
}

export function periodRange(period, from, to) {
  const nowDate = new Date();
  if (period === "today") return { from: startOfToday(), to: nowDate };
  if (period === "7d") return { from: new Date(nowDate.getTime() - 7 * 86400000), to: nowDate };
  if (period === "30d") return { from: new Date(nowDate.getTime() - 30 * 86400000), to: nowDate };
  // custom: the rango seleccionado abarca el día COMPLETO del límite superior
  const f = from ? new Date(`${from}T00:00:00`) : new Date(nowDate.getTime() - 30 * 86400000);
  const t = to ? new Date(`${to}T23:59:59.999`) : nowDate;
  return { from: f, to: t };
}