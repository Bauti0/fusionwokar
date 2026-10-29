// Test de regresión para el indicador "pedido vivo" del seguimiento (V-18).
// Bug cubierto: updatedAgoLabel no debe parecer un contador exacto que salta
// entre "hace 0s" y "hace 6s" (justamente el ritmo del poll de TrackOrder):
//   - menos de 10s → "Actualizado hace un momento"
//   - de 10s a 59s → "Actualizado hace N s"
//   - 60s en adelante → minutos ("hace N min"), sin volver a segundos
// También: sin timestamp (primer render, poll aún no respondió) devuelve
// null y no se muestra nada; y un desfase de reloj (now < lastUpdated) no
// produce valores negativos.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { updatedAgoLabel } from "../src/utils/tracking.js";

const T0 = 1_700_000_000_000;
const s = 1000;

describe("updatedAgoLabel", () => {
  it("menos de 10s → 'hace un momento' (no contador 0s/6s)", () => {
    assert.equal(updatedAgoLabel(T0, T0), "Actualizado hace un momento");
    assert.equal(updatedAgoLabel(T0, T0 + 6 * s), "Actualizado hace un momento"); // ritmo del poll
    assert.equal(updatedAgoLabel(T0, T0 + 9.9 * s), "Actualizado hace un momento");
  });

  it("de 10s a 59s → 'hace N s' (sin decimales ni 60s)", () => {
    assert.equal(updatedAgoLabel(T0, T0 + 10 * s), "Actualizado hace 10 s");
    assert.equal(updatedAgoLabel(T0, T0 + 45 * s), "Actualizado hace 45 s");
    assert.equal(updatedAgoLabel(T0, T0 + 59.9 * s), "Actualizado hace 59 s");
  });

  it("60s en adelante → minutos", () => {
    assert.equal(updatedAgoLabel(T0, T0 + 60 * s), "Actualizado hace 1 min");
    assert.equal(updatedAgoLabel(T0, T0 + 119 * s), "Actualizado hace 1 min");
    assert.equal(updatedAgoLabel(T0, T0 + 120 * s), "Actualizado hace 2 min");
    assert.equal(updatedAgoLabel(T0, T0 + 5 * 60 * s), "Actualizado hace 5 min");
  });

  it("sin timestamp (first render) → null", () => {
    assert.equal(updatedAgoLabel(null, T0), null);
    assert.equal(updatedAgoLabel(undefined, T0), null);
  });

  it("desfase de reloj (now < lastUpdated) no da valores negativos", () => {
    assert.equal(updatedAgoLabel(T0 + 5 * s, T0), "Actualizado hace un momento");
  });
});
