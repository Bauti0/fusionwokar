// Test unitario para las funciones de normalización de horarios
// admin-branch-hours: normalizeServerHours, denormalizeForServer, isFullyClosed

import { describe, it } from "node:test";
import assert from "node:assert";

// Copiamos las funciones aquí para testearlas aisladamente (sin depender del componente)
// Deben ser IDÉNTICAS a las de AdminBranchHours.jsx
const EMPTY_SLOT = { open: "", close: "", closed: false };

function normalizeServerHours(serverHours) {
  if (!serverHours || typeof serverHours !== "object" || Object.keys(serverHours).length === 0) return {};
  const normalized = {};
  for (let day = 0; day < 7; day++) {
    const d = serverHours[String(day)] || serverHours[day];
    if (!d) {
      normalized[String(day)] = [{ ...EMPTY_SLOT }];
      continue;
    }
    if (d.closed) {
      normalized[String(day)] = [{ ...EMPTY_SLOT, closed: true }];
      continue;
    }
    const slots = (d.slots || []).map((s, i) => ({
      open: s.open || "",
      close: s.close || "",
      closed: false,
    }));
    normalized[String(day)] = slots.length ? slots : [{ ...EMPTY_SLOT }];
  }
  return normalized;
}

function denormalizeForServer(formHours) {
  if (!formHours || typeof formHours !== "object" || Object.keys(formHours).length === 0) return {};
  const payload = {};
  for (let day = 0; day < 7; day++) {
    const key = String(day);
    const slots = formHours[key] || [];
    // Un slot es válido solo si tiene open/close Y no está marcado como closed
    const validSlots = slots.filter((s) => s.open && s.close && !s.closed);
    if (validSlots.length === 0) {
      payload[key] = { closed: true, slots: [] };
    } else {
      payload[key] = {
        closed: false,
        slots: validSlots.map((s, i) => ({ open: s.open, close: s.close })),
      };
    }
  }
  return payload;
}

function isFullyClosed(formHours) {
  if (!formHours) return true;
  for (let day = 0; day < 7; day++) {
    const slots = formHours[String(day)] || [];
    const hasOpen = slots.some((s) => s.open && s.close && !s.closed);
    if (hasOpen) return false;
  }
  return true;
}

describe("normalizeServerHours", () => {
  it("convierte respuesta completa del servidor", () => {
    const serverHours = {
      "0": { closed: false, slots: [{ open: "12:00", close: "15:00" }] },
      "1": { closed: true, slots: [] },
      "2": { closed: false, slots: [{ open: "19:00", close: "23:00" }, { open: "20:00", close: "01:00" }] },
    };
    const result = normalizeServerHours(serverHours);
    assert.deepStrictEqual(result["0"], [{ open: "12:00", close: "15:00", closed: false }]);
    assert.deepStrictEqual(result["1"], [{ open: "", close: "", closed: true }]);
    assert.deepStrictEqual(result["2"], [
      { open: "19:00", close: "23:00", closed: false },
      { open: "20:00", close: "01:00", closed: false },
    ]);
  });

  it("tolera días sin datos (faltantes)", () => {
    const serverHours = { "0": { closed: false, slots: [{ open: "12:00", close: "15:00" }] } };
    const result = normalizeServerHours(serverHours);
    // Días 1-6 deben tener slot vacío
    for (let d = 1; d <= 6; d++) {
      assert.deepStrictEqual(result[String(d)], [{ open: "", close: "", closed: false }]);
    }
  });

  it("tolera nulos y objetos vacíos -> devuelve objeto vacío", () => {
    const result = normalizeServerHours(null);
    assert.deepStrictEqual(result, {});
    const result2 = normalizeServerHours({});
    assert.deepStrictEqual(result2, {});
  });

  it("maneja franja que cruza medianoche (cierre < apertura)", () => {
    const serverHours = {
      "5": { closed: false, slots: [{ open: "20:00", close: "01:00" }] },
    };
    const result = normalizeServerHours(serverHours);
    assert.deepStrictEqual(result["5"], [{ open: "20:00", close: "01:00", closed: false }]);
  });

  it("filtra slots con valores vacíos en slots del servidor", () => {
    const serverHours = {
      "0": { closed: false, slots: [{ open: "12:00", close: "15:00" }, { open: "", close: "" }] },
    };
    const result = normalizeServerHours(serverHours);
    // El slot vacío debería incluirse en la normalización (el formulario decide si mostrarlo)
    assert.strictEqual(result["0"].length, 2);
  });
});

describe("denormalizeForServer", () => {
  it("convierte formulario a payload del servidor", () => {
    const formHours = {
      "0": [{ open: "12:00", close: "15:00", closed: false }],
      "1": [{ open: "", close: "", closed: true }],
      "2": [
        { open: "19:00", close: "23:00", closed: false },
        { open: "20:00", close: "01:00", closed: false },
      ],
    };
    const result = denormalizeForServer(formHours);
    assert.deepStrictEqual(result["0"], { closed: false, slots: [{ open: "12:00", close: "15:00" }] });
    assert.deepStrictEqual(result["1"], { closed: true, slots: [] });
    assert.deepStrictEqual(result["2"], {
      closed: false,
      slots: [{ open: "19:00", close: "23:00" }, { open: "20:00", close: "01:00" }],
    });
  });

  it("ignora slots sin open/close válidos", () => {
    const formHours = {
      "0": [
        { open: "12:00", close: "15:00", closed: false },
        { open: "", close: "", closed: false },
        { open: "16:00", close: "", closed: false },
      ],
    };
    const result = denormalizeForServer(formHours);
    assert.deepStrictEqual(result["0"], { closed: false, slots: [{ open: "12:00", close: "15:00" }] });
  });

  it("día vacío -> cerrado", () => {
    const formHours = { "0": [] };
    const result = denormalizeForServer(formHours);
    assert.deepStrictEqual(result["0"], { closed: true, slots: [] });
  });

  it("tolera nulos -> devuelve objeto vacío", () => {
    assert.deepStrictEqual(denormalizeForServer(null), {});
    assert.deepStrictEqual(denormalizeForServer({}), {});
  });
});

describe("isFullyClosed", () => {
  it("sucursal cerrada todos los días", () => {
    const formHours = {
      "0": [{ open: "", close: "", closed: true }],
      "1": [{ open: "", close: "", closed: true }],
      "2": [{ open: "", close: "", closed: true }],
      "3": [{ open: "", close: "", closed: true }],
      "4": [{ open: "", close: "", closed: true }],
      "5": [{ open: "", close: "", closed: true }],
      "6": [{ open: "", close: "", closed: true }],
    };
    assert.strictEqual(isFullyClosed(formHours), true);
  });

  it("sucursal con al menos un día abierto", () => {
    const formHours = {
      "0": [{ open: "", close: "", closed: true }],
      "1": [{ open: "12:00", close: "15:00", closed: false }],
      "2": [{ open: "", close: "", closed: true }],
      "3": [{ open: "", close: "", closed: true }],
      "4": [{ open: "", close: "", closed: true }],
      "5": [{ open: "", close: "", closed: true }],
      "6": [{ open: "", close: "", closed: true }],
    };
    assert.strictEqual(isFullyClosed(formHours), false);
  });

  it("null/undefined -> true", () => {
    assert.strictEqual(isFullyClosed(null), true);
    assert.strictEqual(isFullyClosed(undefined), true);
  });

  it("día con closed=false pero sin slots válidos -> cuenta como cerrado", () => {
    const formHours = {
      "0": [{ open: "", close: "", closed: false }],
      "1": [{ open: "", close: "", closed: true }],
      "2": [{ open: "", close: "", closed: true }],
      "3": [{ open: "", close: "", closed: true }],
      "4": [{ open: "", close: "", closed: true }],
      "5": [{ open: "", close: "", closed: true }],
      "6": [{ open: "", close: "", closed: true }],
    };
    assert.strictEqual(isFullyClosed(formHours), true);
  });

  it("BUG: día con slots que tienen open/close pero closed=true -> denormalize lo trata como cerrado", () => {
    // Simula el bug: el usuario apaga el día (closed=true) pero los slots
    // conservan sus valores open/close del estado anterior
    const formHours = {
      "1": [
        { open: "11:00", close: "15:00", closed: true },  // cerrado PERO con valores
        { open: "19:30", close: "23:30", closed: true },
      ],
    };
    const result = denormalizeForServer(formHours);
    // Debería tratar el día como cerrado (no enviar las franjas)
    assert.deepStrictEqual(result["1"], { closed: true, slots: [] });
  });
});