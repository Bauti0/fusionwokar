import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { periodRange, startOfToday, dayShort } from "../src/utils/dates.js";

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
