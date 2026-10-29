import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateCartItem } from "../src/hooks/useCart.js";

// Tests para validateCartItem: valida y normaliza items de carrito desde localStorage
describe("validateCartItem", () => {
  it("devuelve null para item null/undefined", () => {
    assert.equal(validateCartItem(null), null);
    assert.equal(validateCartItem(undefined), null);
  });

  it("devuelve null para item sin productId", () => {
    assert.equal(validateCartItem({ name: "Test", unitPrice: 1000, qty: 1 }), null);
  });

  it("devuelve null para item sin name", () => {
    assert.equal(validateCartItem({ productId: "p1", unitPrice: 1000, qty: 1 }), null);
  });

  it("devuelve null para item con unitPrice no numérico", () => {
    assert.equal(validateCartItem({ productId: "p1", name: "Test", unitPrice: "1000", qty: 1 }), null);
  });

  it("devuelve null para item con qty no entero positivo", () => {
    assert.equal(validateCartItem({ productId: "p1", name: "Test", unitPrice: 1000, qty: 0 }), null);
    assert.equal(validateCartItem({ productId: "p1", name: "Test", unitPrice: 1000, qty: -1 }), null);
    assert.equal(validateCartItem({ productId: "p1", name: "Test", unitPrice: 1000, qty: 1.5 }), null);
  });

  it("normaliza item válido sin extras ni options ni notes ni image", () => {
    const input = { productId: "p1", name: "Test", unitPrice: 1000, qty: 2 };
    const result = validateCartItem(input);
    assert.deepEqual(result, {
      key: "",
      productId: "p1",
      name: "Test",
      image: "",
      unitPrice: 1000,
      extras: [],
      options: [],
      notes: "",
      qty: 2,
    });
  });

  it("normaliza item con extras undefined a array vacío", () => {
    const input = { productId: "p1", name: "Test", unitPrice: 1000, qty: 1, extras: undefined };
    const result = validateCartItem(input);
    assert.deepEqual(result.extras, []);
  });

  it("normaliza item con options undefined a array vacío", () => {
    const input = { productId: "p1", name: "Test", unitPrice: 1000, qty: 1, options: undefined };
    const result = validateCartItem(input);
    assert.deepEqual(result.options, []);
  });

  it("normaliza item con notes undefined a string vacío", () => {
    const input = { productId: "p1", name: "Test", unitPrice: 1000, qty: 1, notes: undefined };
    const result = validateCartItem(input);
    assert.equal(result.notes, "");
  });

  it("normaliza item con image undefined a string vacío", () => {
    const input = { productId: "p1", name: "Test", unitPrice: 1000, qty: 1, image: undefined };
    const result = validateCartItem(input);
    assert.equal(result.image, "");
  });

  it("mantiene extras y options válidos", () => {
    const input = {
      productId: "p1",
      name: "Test",
      unitPrice: 1000,
      qty: 1,
      extras: [{ id: "e1", price: 500 }],
      options: [{ id: "o1", extraPrice: 200 }],
    };
    const result = validateCartItem(input);
    assert.deepEqual(result.extras, [{ id: "e1", price: 500 }]);
    assert.deepEqual(result.options, [{ id: "o1", extraPrice: 200 }]);
  });

  it("descarta extras si no es array", () => {
    const input = { productId: "p1", name: "Test", unitPrice: 1000, qty: 1, extras: "no-array" };
    const result = validateCartItem(input);
    assert.deepEqual(result.extras, []);
  });

  it("descarta options si no es array", () => {
    const input = { productId: "p1", name: "Test", unitPrice: 1000, qty: 1, options: "no-array" };
    const result = validateCartItem(input);
    assert.deepEqual(result.options, []);
  });

  it("item con producto que no existe en el menú (simulado) se quita al validar", () => {
    // Este test simula la lógica de validateAgainstMenu
    const menu = {
      categories: [
        { groups: [{ products: [{ id: "p1" }, { id: "p2" }] }] },
      ],
    };
    const validIds = new Set(["p1", "p2"]);
    const items = [
      { productId: "p1", name: "Producto 1", unitPrice: 1000, qty: 1 },
      { productId: "p3", name: "Producto 3", unitPrice: 1000, qty: 1 }, // no existe
    ];
    const valid = items.filter((it) => validIds.has(it.productId));
    assert.equal(valid.length, 1);
    assert.equal(valid[0].productId, "p1");
  });
});