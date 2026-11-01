import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { adminExpenses } from "../src/api.js";

// ---------------------------------------------------------------------
// REGRESIÓN: GET /api/admin/expenses requiere la sucursal. El servidor la
// obtiene del scope del branch_admin o del query ?branch= (para
// superadmin). Si no llega, responde 400 "Falta la sucursal" y la
// sección de ventas rompe con "No se pudo mostrar las ventas".
//
// El panel ahora envía `branch` al pedir los gastos (AdminSales.jsx,
// loadExpenses). Este test bloquea que adminExpenses deje de incluir
// branch en el query cuando se le provee.
// ---------------------------------------------------------------------

let originalFetch;
const urls = [];

function installFetchMock() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ expenses: [] }) };
  };
}

function uninstallFetchMock() {
  globalThis.fetch = originalFetch;
  urls.length = 0;
}

afterEach(uninstallFetchMock);

describe("adminExpenses envía la sucursal al servidor", () => {
  it("incluye branch, from y to en el query", async () => {
    installFetchMock();
    await adminExpenses({
      branch: "necochea",
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
    });
    assert.equal(urls.length, 1);
    assert.match(urls[0], /branch=necochea/);
    assert.match(urls[0], /from=/);
    assert.match(urls[0], /to=/);
  });

  it("sin branch no envía branch (el servidor rechazará con 400 'Falta la sucursal')", async () => {
    installFetchMock();
    await adminExpenses({ from: "2026-10-01", to: "2026-11-01" });
    assert.equal(urls.length, 1);
    assert.ok(!/branch=/.test(urls[0]), "no debería incluir branch en el query");
  });
});
