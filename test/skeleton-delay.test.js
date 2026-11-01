import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldShowSkeleton, shouldHideSkeleton } from "../src/utils/skeleton-delay.js";

// Estas pruebas cubren la lógica pura de anti-parpadeo del skeleton.
// Bug que evita: mostrar el skeleton en cargas rapidísimas (< 200 ms)
// provoca un parpadeo innecesario; y ocultarlo antes de 300 ms hace que
// el contenido "salte" demasiado rápido. El hook useDelayedLoading usa
// estas dos funciones puras internamente con setTimeout y cleanup.

describe("shouldShowSkeleton", () => {
  it("carga más rápida que 200 ms no muestra skeleton", () => {
    assert.equal(shouldShowSkeleton(0), false);
    assert.equal(shouldShowSkeleton(100), false);
    assert.equal(shouldShowSkeleton(199), false);
  });
  it("carga de exactamente 200 ms muestra skeleton", () => {
    assert.equal(shouldShowSkeleton(200), true);
  });
  it("carga lenta muestra skeleton", () => {
    assert.equal(shouldShowSkeleton(500), true);
    assert.equal(shouldShowSkeleton(1000), true);
  });
});

describe("shouldHideSkeleton", () => {
  it("menos de 300 ms no oculta el skeleton (se mantiene visible)", () => {
    assert.equal(shouldHideSkeleton(0), false);
    assert.equal(shouldHideSkeleton(100), false);
    assert.equal(shouldHideSkeleton(299), false);
  });
  it("300 ms u más permite ocultar el skeleton", () => {
    assert.equal(shouldHideSkeleton(300), true);
    assert.equal(shouldHideSkeleton(500), true);
    assert.equal(shouldHideSkeleton(1000), true);
  });
  it("umbrales personalizados funcionan", () => {
    assert.equal(shouldHideSkeleton(150, 100), true);
    assert.equal(shouldHideSkeleton(50, 100), false);
  });
});
