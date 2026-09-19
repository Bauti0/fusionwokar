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