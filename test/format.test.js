import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatPrice, lineTotal, cartKey } from "../src/utils/format.js";

// Estas funciones son la fórmula de línea del carrito. El servidor calcula lo
// mismo en server/index.js, pero desde la DB. Estos tests fijan el contrato
// del lado del cliente: cualquier pantalla que muestre un precio de línea
// tiene que dar el mismo número.
describe("lineTotal", () => {
  it("sin extras y cantidad 1 devuelve el precio unitario", () => {
    assert.equal(lineTotal({ unitPrice: 18900, qty: 1, extras: [] }), 18900);
  });

  it("sin extras multiplica por la cantidad", () => {
    assert.equal(lineTotal({ unitPrice: 18900, qty: 3, extras: [] }), 56700);
  });

  it("el extra se suma al unitario y recien ahi se multiplica por cantidad", () => {
    // El extra se cobra una vez por unidad, no una vez por línea.
    // OJO: `unitPrice * qty` da 20000 acá. Esa es la diferencia entre la
    // fórmula correcta y la que usa TrackOrder.jsx, que por eso muestra un
    // desglose que no cierra contra el total.
    assert.equal(lineTotal({ unitPrice: 10000, qty: 2, extras: [{ id: "a", price: 2000 }] }), 24000);
  });

  it("varios extras se acumulan antes de multiplicar", () => {
    const item = {
      unitPrice: 10000,
      qty: 2,
      extras: [{ id: "a", price: 2000 }, { id: "b", price: 500 }],
    };
    assert.equal(lineTotal(item), 25000);
  });

  it("tolera items sin la propiedad extras", () => {
    assert.equal(lineTotal({ unitPrice: 5000, qty: 2 }), 10000);
  });

  it("un extra de precio 0 no altera el total", () => {
    assert.equal(lineTotal({ unitPrice: 5000, qty: 1, extras: [{ id: "z", price: 0 }] }), 5000);
  });

  it("cantidad 0 da total 0", () => {
    assert.equal(lineTotal({ unitPrice: 5000, qty: 0, extras: [] }), 0);
  });
});

describe("cartKey", () => {
  it("mismo producto y mismos extras dan la misma clave", () => {
    const a = { productId: "wok-1", extras: [{ id: "e1" }, { id: "e2" }] };
    const b = { productId: "wok-1", extras: [{ id: "e1" }, { id: "e2" }] };
    assert.equal(cartKey(a), cartKey(b));
  });

  it("el orden de los extras no cambia la clave", () => {
    const a = { productId: "wok-1", extras: [{ id: "e1" }, { id: "e2" }] };
    const b = { productId: "wok-1", extras: [{ id: "e2" }, { id: "e1" }] };
    assert.equal(cartKey(a), cartKey(b));
  });

  it("productos distintos dan claves distintas", () => {
    const a = { productId: "wok-1", extras: [] };
    const b = { productId: "wok-2", extras: [] };
    assert.notEqual(cartKey(a), cartKey(b));
  });

  it("sin extras ni nota, ambas partes quedan vacías", () => {
    // Desde que la nota forma parte de la clave el formato es `producto|extras|nota`:
    // sin extras ni nota quedan los dos separadores pegados.
    assert.equal(cartKey({ productId: "wok-1" }), "wok-1||");
  });

  it("un extra distinto da una clave distinta", () => {
    const a = { productId: "wok-1", extras: [{ id: "e1" }] };
    const b = { productId: "wok-1", extras: [{ id: "e2" }] };
    assert.notEqual(cartKey(a), cartKey(b));
  });

  it("la misma nota en ambos items da la misma clave (se fusionan en una línea)", () => {
    const a = { productId: "wok-1", extras: [{ id: "e1" }], notes: "sin cebolla" };
    const b = { productId: "wok-1", extras: [{ id: "e1" }], notes: "sin cebolla" };
    assert.equal(cartKey(a), cartKey(b));
  });

  it("notas distintas dan claves distintas (líneas separadas, una no pisa la otra)", () => {
    // Regresión: antes la clave no incluía la nota y dos líneas idénticas
    // con notas distintas se fusionaban; la segunda pisaba la nota de la
    // primera (useCart.js addItem).
    const a = { productId: "wok-1", extras: [{ id: "e1" }], notes: "sin cebolla" };
    const b = { productId: "wok-1", extras: [{ id: "e1" }], notes: "sin salsa" };
    assert.notEqual(cartKey(a), cartKey(b));
  });

  it("item sin nota e item con nota dan claves distintas", () => {
    const a = { productId: "wok-1", extras: [] };
    const b = { productId: "wok-1", extras: [], notes: "sin cebolla" };
    assert.notEqual(cartKey(a), cartKey(b));
  });

  it("la nota se normaliza con trim antes de entrar en la clave", () => {
    // "sin cebolla" y " sin cebolla " son la misma nota: no tiene sentido
    // que generen dos líneas separadas.
    const a = { productId: "wok-1", extras: [], notes: "sin cebolla" };
    const b = { productId: "wok-1", extras: [], notes: "  sin cebolla  " };
    assert.equal(cartKey(a), cartKey(b));
  });
});

describe("formatPrice", () => {
  it("devuelve un string con el símbolo de moneda", () => {
    assert.equal(typeof formatPrice(18900), "string");
    assert.match(formatPrice(18900), /\$/);
  });

  it("agrupa los miles", () => {
    // Tolerante al separador: es-AR usa "." pero el output de Intl depende
    // de la versión de ICU. Lo que importa es que agrupe.
    assert.match(formatPrice(18900), /18\.?900/);
  });

  it("no muestra decimales", () => {
    // es-AR usa "," como separador decimal; maximumFractionDigits: 0 lo evita.
    assert.doesNotMatch(formatPrice(18900.5), /,/);
  });

  it("maneja cero", () => {
    assert.match(formatPrice(0), /0/);
  });

  it("maneja negativos (devoluciones, ajustes)", () => {
    assert.match(formatPrice(-2500), /2\.?500/);
  });
});
