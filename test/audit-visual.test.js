import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Regresiones de la auditoría visual (02-visual.md) aplicadas en global.css e
// index.html. Son asserts estáticos: se lee el archivo y se fija el valor que
// se pintó a mano. Cualquier revert accidental del CSS hace fallar acá.

const css = readFileSync("src/styles/global.css", "utf8");
const html = readFileSync("index.html", "utf8");

/** Devuelve las declaraciones del selector `sel` en el CSS (todas las coincidencias). */
function rule(sel) {
  const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g");
  return [...css.matchAll(re)].map((m) => m[1]);
}

describe("auditoría visual — regresiones", () => {
  it("V-06: .cart-bar respeta el gesto del home con env(safe-area-inset-bottom)", () => {
    assert.match(css, /\.cart-bar\s*\{[^}]*env\(safe-area-inset-bottom\)/);
  });

  it("V-03: placeholder del buscador con contraste AA (rgba .55, obra .35 daba 2.9:1)", () => {
    assert.match(css, /\.menu__search input::placeholder\s*\{[^}]*rgba\(255,\s*255,\s*255,\s*\.55\)/);
  });

  it("V-04: chips de categoría con área de toque de 44px", () => {
    assert.match(css, /\.cat-chip\s*\{[^}]*min-height:\s*44px/);
  });

  it("V-07: stepper de cantidad con botones de 44px (eran 32x32, bajo WCAG 2.5.5)", () => {
    const blocks = rule(".qty button");
    assert.ok(blocks.length >= 1 && blocks.some((b) => b.includes("width: 44px") && b.includes("height: 44px")));
  });

  it("V-08: botones cerrar a 44px (drawer 38/34px y modal 36px, todos bajo el mínimo)", () => {
    assert.ok(rule(".drawer__close").every((b) => b.includes("width: 44px") && b.includes("height: 44px")));
    const modal = rule(".modal__close");
    assert.ok(modal.some((b) => b.includes("width: 44px") && b.includes("height: 44px")));
  });

  it("V-29: preload del CSS de Google Fonts con el mismo href del stylesheet", () => {
    assert.match(
      html,
      /rel="preload"\s+as="style"\s+href="https:\/\/fonts\.googleapis\.com\/css2\?family=Archivo\+Black[^"]*"/
    );
  });
});
