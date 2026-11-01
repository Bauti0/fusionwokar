import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Componente de prueba con la misma firma que los íconos de
// src/components/ui/icons.jsx: { size, ...props }, base 24x24,
// stroke currentColor, aria-hidden calculado (solo si no hay
// aria-label / aria-labelledby / title).
function TestIcon({ size, ...props }) {
  const hasName =
    props["aria-label"] || props["aria-labelledby"] || props["title"];
  const children =
    props.title !== undefined ? createElement("title", null, props.title) : null;
  return createElement(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      width: size ?? 24,
      height: size ?? 24,
      ...props,
      "aria-hidden": hasName ? undefined : "true",
    },
    children
  );
}

describe("iconos: aria-hidden y tamaño", () => {
  it("sin props: renderiza aria-hidden=\"true\"", () => {
    const html = renderToStaticMarkup(createElement(TestIcon));
    assert.ok(html.includes('aria-hidden="true"'));
  });

  it("con aria-label: no renderiza aria-hidden", () => {
    const html = renderToStaticMarkup(
      createElement(TestIcon, { "aria-label": "Ver carrito" })
    );
    assert.ok(!html.includes("aria-hidden"));
    assert.ok(html.includes('aria-label="Ver carrito"'));
  });

  it("con aria-labelledby: no renderiza aria-hidden", () => {
    const html = renderToStaticMarkup(
      createElement(TestIcon, { "aria-labelledby": "lbl" })
    );
    assert.ok(!html.includes("aria-hidden"));
    assert.ok(html.includes('aria-labelledby="lbl"'));
  });

  it("con title: renderiza un <title> hijo y no renderiza aria-hidden", () => {
    const html = renderToStaticMarkup(createElement(TestIcon, { title: "Mi carrito" }));
    assert.ok(!html.includes("aria-hidden"));
    assert.ok(html.includes("<title>Mi carrito</title>"));
  });

  it("tamaño por defecto es 24x24", () => {
    const html = renderToStaticMarkup(createElement(TestIcon));
    assert.ok(html.includes('width="24"'));
    assert.ok(html.includes('height="24"'));
  });

  it("la prop size sobrescribe width/height", () => {
    const html = renderToStaticMarkup(createElement(TestIcon, { size: 16 }));
    assert.ok(html.includes('width="16"'));
    assert.ok(html.includes('height="16"'));
    assert.ok(!html.includes('width="24"'));
  });
});
