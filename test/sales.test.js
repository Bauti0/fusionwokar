import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSalesReport, arDay } from "../server/reports.js";

// ---------------------------------------------------------------------
// LA REGRESION: /api/admin/stats muestra la venta NETA (bruto - devuelto)
// pero /api/admin/sales devolvia `total` (BRUTO) y era lo que el panel
// pintaba como "Total vendido". Dos tarjetas distintas para el mismo
// numero, y la de Ventas era la que sobraba plata: un pedido con
// devolucion seguia contando completo como ingreso.
// ---------------------------------------------------------------------

const DIA_A = "2026-03-10T02:00:00.000Z"; // 23:00 del 09/03 en Argentina
const DIA_B = "2026-03-11T14:00:00.000Z"; // 11:00 del 11/03 en Argentina

function pedido(payment_method, total, created_at) {
  return { payment_method, total, created_at };
}

describe("reporte de ventas", () => {
  it("expone la venta neta, no solo el bruto", () => {
    const r = buildSalesReport({
      rows: [pedido("efectivo", 1000, DIA_A), pedido("mercadopago", 2000, DIA_B)],
      refunded: 600,
    });
    assert.equal(r.total, 3000, "el bruto sigue disponible como total");
    assert.equal(r.net, 2400, "la neta es lo que se muestra como titular");
    assert.equal(r.devuelto, 600);
  });

  it("sin devoluciones la neta es igual al bruto", () => {
    const r = buildSalesReport({ rows: [pedido("efectivo", 1000, DIA_A)], refunded: 0 });
    assert.equal(r.net, 1000);
  });

  it("la neta nunca es negativa si se devolvio mas de lo vendido", () => {
    const r = buildSalesReport({ rows: [pedido("efectivo", 500, DIA_A)], refunded: 900 });
    assert.equal(r.net, 0);
  });

  it("tolera que no le pasen devuelto", () => {
    const r = buildSalesReport({ rows: [pedido("efectivo", 1000, DIA_A)] });
    assert.equal(r.net, 1000);
    assert.equal(r.devuelto, 0);
  });

  it("sin pedidos devuelve todo en cero y no falla", () => {
    const r = buildSalesReport({ rows: [], refunded: 0 });
    assert.deepEqual(r, {
      total: 0,
      net: 0,
      devuelto: 0,
      count: 0,
      average: 0,
      byMethod: [],
      byDay: [],
    });
  });

  // El ticket promedio tiene que salir de la NETA, como en /api/admin/stats.
  // Si saliera del bruto, dividir la tarjeta titular por los pedidos daria
  // otro numero: la misma contradiccion que se vino a arreglar.
  it("el ticket promedio se calcula sobre la neta, igual que en /stats", () => {
    const r = buildSalesReport({
      rows: [pedido("efectivo", 1000, DIA_A), pedido("efectivo", 2000, DIA_B)],
      refunded: 500,
    });
    assert.equal(r.average, 1250, "net 2500 / 2 pedidos");
  });

  it("el ticket promedio no explota sin pedidos", () => {
    assert.equal(buildSalesReport({ rows: [] }).average, 0);
  });
});

describe("desglose por metodo de pago", () => {
  it("agrupa y ordena de mayor a menor", () => {
    const r = buildSalesReport({
      rows: [
        pedido("efectivo", 1000, DIA_A),
        pedido("mercadopago", 5000, DIA_A),
        pedido("efectivo", 2000, DIA_B),
        pedido("transferencia", 700, DIA_B),
      ],
    });
    assert.deepEqual(
      r.byMethod.map((m) => [m.method, m.count, m.total]),
      [
        ["mercadopago", 1, 5000],
        ["efectivo", 2, 3000],
        ["transferencia", 1, 700],
      ]
    );
  });

  it("tolera pedidos sin metodo de pago", () => {
    const r = buildSalesReport({ rows: [{ total: 1000, created_at: DIA_A }] });
    assert.equal(r.byMethod.length, 1);
    assert.equal(r.byMethod[0].method, undefined);
    assert.equal(r.byMethod[0].total, 1000);
  });
});

// La agrupacion diaria tiene que usar el dia ARGENTINO, no el del servidor:
// un pedido de las 23:00 AR cae al dia siguiente en UTC. Este test es el que
// se rompe solo al correr la matriz de husos.
describe("ventas por dia", () => {
  it("agrupa por el dia del local, no por el dia UTC", () => {
    const r = buildSalesReport({
      rows: [pedido("efectivo", 1000, DIA_A), pedido("efectivo", 2000, DIA_B)],
    });
    assert.deepEqual(
      r.byDay.map((d) => [d.date, d.count, d.total]),
      [
        ["2026-03-09", 1, 1000],
        ["2026-03-11", 1, 2000],
      ]
    );
  });

  it("los dias salen ordenados de mas viejo a mas nuevo", () => {
    const r = buildSalesReport({
      rows: [pedido("efectivo", 2000, DIA_B), pedido("efectivo", 1000, DIA_A)],
    });
    assert.deepEqual(
      r.byDay.map((d) => d.date),
      ["2026-03-09", "2026-03-11"]
    );
  });

  it("el total del dia coincide con el total del reporte", () => {
    const r = buildSalesReport({
      rows: [pedido("efectivo", 1000, DIA_A), pedido("efectivo", 2000, DIA_A), pedido("efectivo", 300, DIA_B)],
    });
    assert.equal(
      r.byDay.reduce((s, d) => s + d.total, 0),
      r.total
    );
  });
});

describe("arDay", () => {
  it("manda un pedido de la madrugada al dia anterior", () => {
    assert.equal(arDay("2026-03-10T02:00:00.000Z"), "2026-03-09");
  });

  it("deja un pedido de la tarde en su dia", () => {
    assert.equal(arDay("2026-03-11T14:00:00.000Z"), "2026-03-11");
  });

  it("no se corre de dia con una fecha invalida", () => {
    assert.equal(arDay("basura"), "basura");
    assert.equal(arDay(""), "");
    assert.equal(arDay(null), "");
  });
});
