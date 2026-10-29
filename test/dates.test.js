import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { periodRange, startOfToday, dayShort, dayLabel, dateShort, dateTimeShort, isToday } from "../src/utils/dates.js";

// El contrato clave: "YYYY-MM-DD" se parsea como HORA LOCAL, no como la
// medianoche UTC que produce new Date("2026-01-15"). Ese fue un bug real:
// un rango de un solo dia ("Hoy") quedaba de ancho cero.
describe("periodRange — rangos por defecto", () => {
  it("today arranca a la medianoche local", () => {
    const { from } = periodRange("today");
    assert.equal(from.getHours(), 0);
    assert.equal(from.getMinutes(), 0);
    assert.equal(from.getSeconds(), 0);
    assert.equal(from.getMilliseconds(), 0);
  });

  it("today empieza hoy, no ayer", () => {
    const { from } = periodRange("today");
    const today = new Date();
    assert.equal(from.getFullYear(), today.getFullYear());
    assert.equal(from.getMonth(), today.getMonth());
    assert.equal(from.getDate(), today.getDate());
  });

  it("today termina en el ahora", () => {
    const { to } = periodRange("today");
    assert.ok(Math.abs(Date.now() - to.getTime()) < 5000);
  });

  it("7d cubre aproximadamente siete dias", () => {
    const { from, to } = periodRange("7d");
    const days = (to.getTime() - from.getTime()) / 86400000;
    assert.ok(Math.abs(days - 7) < 0.01, `esperaba ~7 dias, dio ${days}`);
  });

  it("30d cubre aproximadamente treinta dias", () => {
    const { from, to } = periodRange("30d");
    const days = (to.getTime() - from.getTime()) / 86400000;
    assert.ok(Math.abs(days - 30) < 0.01, `esperaba ~30 dias, dio ${days}`);
  });
});

describe("periodRange — rango custom", () => {
  it("el limite inferior es la medianoche local de ese dia", () => {
    const { from } = periodRange("custom", "2026-01-15", "2026-01-20");
    // Comparado contra el parseo local explicito. Si alguien cambia esto por
    // new Date("2026-01-15"), que es UTC, el test falla.
    assert.equal(from.getTime(), new Date("2026-01-15T00:00:00").getTime());
    assert.equal(from.getHours(), 0);
  });

  it("el limite superior es el fin del dia completo", () => {
    const { to } = periodRange("custom", "2026-01-15", "2026-01-20");
    assert.equal(to.getTime(), new Date("2026-01-20T23:59:59.999").getTime());
    assert.equal(to.getDate(), 20);
    assert.equal(to.getHours(), 23);
  });

  it("un rango de un solo dia NO es de ancho cero", () => {
    // Este es el caso que rompia el filtro "Hoy" del panel admin.
    const { from, to } = periodRange("custom", "2026-01-15", "2026-01-15");
    assert.ok(to > from, "el rango deberia tener ancho");
    const hours = (to.getTime() - from.getTime()) / 3600000;
    assert.ok(hours > 23.9 && hours < 24, `esperaba ~24h, dio ${hours}h`);
  });

  it("el ultimo dia del rango queda incluido", () => {
    const { to } = periodRange("custom", "2026-01-15", "2026-01-20");
    assert.equal(to.getDate(), 20, "el dia final tiene que estar dentro del rango");
  });

  it("sin limite inferior cae a 30 dias atras", () => {
    const { from } = periodRange("custom", null, null);
    const days = (Date.now() - from.getTime()) / 86400000;
    assert.ok(Math.abs(days - 30) < 0.01, `esperaba ~30 dias atras, dio ${days}`);
  });

  it("sin limites usa el rango por defecto completo", () => {
    const { from, to } = periodRange("custom", null, null);
    assert.ok(from < to);
    assert.ok((to.getTime() - from.getTime()) / 86400000 > 29);
  });
});

describe("startOfToday", () => {
  it("devuelve la medianoche de hoy", () => {
    const d = startOfToday();
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getSeconds(), 0);
    assert.equal(d.getMilliseconds(), 0);
  });
});

// El servidor manda byDay[].date como el dia calendario de ARGENTINA
// (arDate), no como un instante. Si dayShort lo parsea con new Date(fecha),
// eso se interpreta como medianoche UTC y el grafico de ventas del admin
// muestra TODOS los dias corridos en uno (verificado: difiere en el 100%
// de los casos en Argentina).
describe("dayShort — etiqueta de dia para el grafico de ventas", () => {
  it("devuelve el dia de la semana de esa fecha", () => {
    assert.equal(dayShort("2026-09-29"), "mar");
    assert.equal(dayShort("2026-01-01"), "jue");
    assert.equal(dayShort("2026-06-15"), "lun");
  });

  it("no corre un dia, aunque el parseo UTC si lo haria", () => {
    // Si dayShort usara new Date("2026-09-29") daria "lun" (UTC), no "mar".
    assert.notEqual(dayShort("2026-09-29"), "lun");
    assert.notEqual(dayShort("2026-01-01"), "mi\u00e9");
  });

  it("no se corre de dia en los bordes de mes y anio", () => {
    assert.equal(dayShort("2026-01-01"), "jue");
    assert.equal(dayShort("2026-12-31"), "jue");
  });
});

// El pie de cada barra es "jue 1/10". Si dayLabel no parseara la fecha como
// HORA LOCAL, el día del mes correría y la barra quedaría rotulada con el
// día anterior.
describe("dayLabel — etiqueta de la barra", () => {
  it("devuelve dia/mes en dos digitos", () => {
    assert.equal(dayLabel("2026-10-01"), "01/10");
    assert.equal(dayLabel("2026-01-05"), "05/01");
    assert.equal(dayLabel("2026-12-31"), "31/12");
  });

  it("no corre el dia, aunque el parseo UTC si lo haria", () => {
    // new Date("2026-01-01") en un huso negativo al este es 31/12 UTC.
    assert.equal(dayLabel("2026-01-01"), "01/01");
  });

  it("el ancho no depende del valor: siempre 5 caracteres", () => {
    // La barra reserva el ancho del monto segun la cantidad de digitos: si
    // "1/10" y "31/12" midieran distinto, el grafico bailea entre dias.
    assert.equal(dayLabel("2026-10-01").length, dayLabel("2026-12-31").length);
  });
});

// La linea atenuada "Caja abierta desde 02/10/2026 11:35" y las fechas del
// historial. El "a. m." de es-AR duplicaba el ancho y descuadraba la linea del
// centro de la tarjeta, asi que se arma a mano en 24 h.
describe("dateTimeShort / dateShort — arqueo de caja", () => {
  it("fecha y hora en 24 h, sin segundos ni AM/PM", () => {
    const d = new Date(2026, 9, 2, 11, 35, 22);
    assert.equal(dateTimeShort(d.toISOString()), "02/10/2026 11:35");
  });

  it("rellena con cero las horas de una y dos digitos", () => {
    assert.equal(dateTimeShort(new Date(2026, 9, 3, 0, 5, 0).toISOString()), "03/10/2026 00:05");
    assert.equal(dateTimeShort(new Date(2026, 9, 3, 23, 5, 0).toISOString()), "03/10/2026 23:05");
  });

  it("la fecha sola no trae la hora", () => {
    assert.equal(dateShort(new Date(2026, 9, 2, 11, 35, 22).toISOString()), "02/10/2026");
  });

  it("una fecha inválida no rompe el render", () => {
    assert.equal(dateTimeShort("no-es-fecha"), "");
    assert.equal(dateShort(undefined), "");
  });
});

// El resaltado de "hoy" tiene que usar el día de ARGENTINA, no el del
// navegador ni el UTC: el servidor agrupa por arDay(). Entre las 21:00 y las
// 24:00 ARG los tres relojes difieren, así que una comparación contra
// new Date() marcaría el día equivocado justo cuando el local ya cerró el día.
describe("isToday — resaltado del dia de hoy", () => {
  // Instantes fijo con offset -03:00 (hora de Argentina, sin DST).
  const LATE_2230 = new Date("2026-10-02T23:30:00-03:00"); // 02/10 23:30 AR = 03/10 02:30 UTC
  const EARLY_0030 = new Date("2026-10-03T00:30:00-03:00"); // 03/10 00:30 AR = 03/10 03:30 UTC

  it("a las 23:30 ARG todavía es el 2/10", () => {
    assert.equal(isToday("2026-10-02", LATE_2230), true);
  });

  it("a las 23:30 ARG NO es ya el 3/10 aunque en UTC lo sea", () => {
    // Si isToday comparara contra el día UTC, acá marcaría el 3/10 como
    // "hoy" tres horas antes de que en Argentina cambie el día.
    assert.equal(isToday("2026-10-03", LATE_2230), false);
  });

  it("a las 00:30 ARG ya es el 3/10", () => {
    assert.equal(isToday("2026-10-03", EARLY_0030), true);
  });

  it("a las 00:30 ARG el 2/10 ya no es hoy", () => {
    assert.equal(isToday("2026-10-02", EARLY_0030), false);
  });

  it("no marca dias sueltos ni entradas invalidas", () => {
    assert.equal(isToday("2026-10-05", EARLY_0030), false);
    assert.equal(isToday("", EARLY_0030), false);
    assert.equal(isToday(null, EARLY_0030), false);
    assert.equal(isToday(undefined, EARLY_0030), false);
  });
});
