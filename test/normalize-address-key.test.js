import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeAddressKey } from "../src/utils/normalizeAddressKey.js";

// Test que verifica que la normalización del server y el cliente dan el mismo resultado.
// El server tiene su propia copia (server/utils/normalizeAddressKey.js) para no depender del frontend.
import { normalizeAddressKey as normalizeServer } from "../server/utils/normalizeAddressKey.js";

describe("normalizeAddressKey (clave de caché de dirección)", () => {
  it("minúsculas", () => {
    assert.equal(normalizeAddressKey("CALLE FALSA 123"), "calle falsa 123");
  });

  it("quita tildes y diacríticos", () => {
    assert.equal(normalizeAddressKey("Av. Córdoba 100"), "av. cordoba 100");
    assert.equal(normalizeAddressKey("San Martín 200"), "san martin 200");
    assert.equal(normalizeAddressKey("Niño 300"), "nino 300");
    assert.equal(normalizeAddressKey("Jalapeño 400"), "jalapeno 400");
  });

  it("colapsa espacios múltiples", () => {
    assert.equal(normalizeAddressKey("Calle   Falsa   123"), "calle falsa 123");
    assert.equal(normalizeAddressKey("  Calle Falsa 123  "), "calle falsa 123");
    assert.equal(normalizeAddressKey("\tCalle\nFalsa\t123\n"), "calle falsa 123");
  });

  it("trim", () => {
    assert.equal(normalizeAddressKey("  Calle Falsa 123  "), "calle falsa 123");
  });

  it("NO expande abreviaturas", () => {
    assert.equal(normalizeAddressKey("Av. Corrientes 500"), "av. corrientes 500");
    assert.equal(normalizeAddressKey("Cno. Real 600"), "cno. real 600");
  });

  it("direcciones distintas por número NO colapsan", () => {
    assert.notEqual(
      normalizeAddressKey("San Martín 100"),
      normalizeAddressKey("San Martín 1000")
    );
  });

  it("colapso de espacios NO une dígitos de distinta parte", () => {
    // "Calle 1 23" → "calle 1 23"  vs  "Calle 12 3" → "calle 12 3"
    assert.notEqual(
      normalizeAddressKey("Calle 1 23"),
      normalizeAddressKey("Calle 12 3")
    );
  });

  it("direcciones distintas por calle NO colapsan", () => {
    assert.notEqual(
      normalizeAddressKey("San Martín 100"),
      normalizeAddressKey("Belgrano 100")
    );
  });

  it("versión server === versión cliente para la misma dirección", () => {
    const direcciones = [
      "Av. Córdoba 100",
      "San Martín 200",
      "Calle   Falsa   123",
      "  Niño 300  ",
      "Jalapeño 400",
      "San Martín 100",
      "San Martín 1000",
      "Calle 1 23",
      "Calle 12 3",
    ];
    for (const d of direcciones) {
      assert.equal(
        normalizeAddressKey(d),
        normalizeServer(d),
        `divergen en: "${d}"`
      );
    }
  });
});