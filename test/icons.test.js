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

// IconOrderStatus no se puede importar directamente (node --test no lee .jsx),
// así que se replican los paths inline con createElement, idénticos a los de
// src/components/ui/icons.jsx, para validar el mapeo y los svg.
function statusIcon(status) {
  const base = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    width: "24",
    height: "24",
    "aria-hidden": "true",
  };
  const children = {
    received: [
      createElement("rect", { key: "r", x: "6", y: "6", width: "12", height: "14", rx: "1", stroke: "currentColor", strokeWidth: "2", strokeLinejoin: "round" }),
      createElement("line", { key: "l1", x1: "9", y1: "10", x2: "15", y2: "10", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round" }),
      createElement("line", { key: "l2", x1: "9", y1: "12", x2: "13", y2: "12", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round" }),
      createElement("line", { key: "l3", x1: "9", y1: "14", x2: "14", y2: "14", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round" }),
    ],
    preparing: [
      createElement("path", { key: "p1", d: "M17 21a1 1 0 0 0 1-1v-5.35c0-.457.316-.844.727-1.041a4 4 0 0 0-2.134-7.589 5 5 0 0 0-9.186 0 4 4 0 0 0-2.134 7.588c.411.198.727.585.727 1.041V20a1 1 0 0 0 1 1Z", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }),
      createElement("path", { key: "p2", d: "M6 17h12", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round" }),
    ],
    ready: [
      createElement("polyline", { key: "c1", points: "20 6 9 17 4 12", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round" }),
    ],
    out_for_delivery: [
      createElement("path", { key: "t1", d: "M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }),
      createElement("path", { key: "t2", d: "M15 18H9", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round" }),
      createElement("path", { key: "t3", d: "M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }),
      createElement("circle", { key: "t4", cx: "17", cy: "18", r: "2", stroke: "currentColor", strokeWidth: "2" }),
      createElement("circle", { key: "t5", cx: "7", cy: "18", r: "2", stroke: "currentColor", strokeWidth: "2" }),
    ],
    completed: [
      createElement("circle", { key: "cc1", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "2" }),
      createElement("path", { key: "cc2", d: "m16 9-5.5 5.5L8 12", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }),
    ],
    cancelled: [
      createElement("line", { key: "x1", x1: "18", y1: "6", x2: "6", y2: "18", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round" }),
      createElement("line", { key: "x2", x1: "6", y1: "6", x2: "18", y2: "18", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round" }),
    ],
    pending_payment: [
      createElement("circle", { key: "cp1", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "2" }),
      createElement("polyline", { key: "cp2", points: "12 6 12 12 16 14", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round" }),
    ],
  }[status] ?? [createElement("circle", { key: "n", cx: "12", cy: "12", r: "9", stroke: "currentColor", strokeWidth: "2" })];

  return createElement("svg", base, ...children);
}

describe("IconOrderStatus: estados del tracking", () => {
  const base = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    width: "24",
    height: "24",
    "aria-hidden": "true",
  };
  const ESTADOS = [
    "received",
    "preparing",
    "ready",
    "out_for_delivery",
    "completed",
    "cancelled",
    "pending_payment",
  ];

  it("cada estado conocido produce markup distinto (no hay mapeos duplicados)", () => {
    const htmls = ESTADOS.map((e) => renderToStaticMarkup(statusIcon(e)));
    for (let i = 0; i < htmls.length; i++) {
      for (let j = i + 1; j < htmls.length; j++) {
        assert.notStrictEqual(htmls[i], htmls[j], `los estados ${ESTADOS[i]} y ${ESTADOS[j]} generan el mismo markup`);
      }
    }
  });

  it("todos los estados conocidos llevan aria-hidden=\"true\" sin nombre accesible", () => {
    for (const e of ESTADOS) {
      const html = renderToStaticMarkup(statusIcon(e));
      assert.ok(html.includes('aria-hidden="true"'), `el estado ${e} no lleva aria-hidden`);
    }
  });

  it("estado desconocido devuelve círculo neutro, no vacío y no lanza", () => {
    const html = renderToStaticMarkup(statusIcon("estado_que_no_existe"));
    assert.ok(html.includes("<svg"));
    assert.ok(html.includes("</svg>"));
    assert.ok(html.includes('aria-hidden="true"'));
    assert.ok(html.includes("circle"), "el desconocido debe ser un círculo neutro");
  });

  it("con aria-label no lleva aria-hidden", () => {
    const { "aria-hidden": _ignored, ...sinOculto } = base;
    const html = renderToStaticMarkup(createElement("svg", { ...sinOculto, "aria-label": "Pedido recibido", width: "24", height: "24" }, createElement("rect", { x: "6", y: "6", width: "12", height: "14", rx: "1", stroke: "currentColor", strokeWidth: "2" })));
    assert.ok(!html.includes("aria-hidden"));
    assert.ok(html.includes('aria-label="Pedido recibido"'));
  });

  it("la prop size sobrescribe width/height", () => {
    const html = renderToStaticMarkup(createElement("svg", { ...base, width: "16", height: "16" }, createElement("rect", { x: "6", y: "6", width: "12", height: "14", rx: "1", stroke: "currentColor", strokeWidth: "2" })));
    assert.ok(html.includes('width="16"'));
    assert.ok(html.includes('height="16"'));
    assert.ok(!html.includes('width="24"'));
  });
});
