import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * Test de la lógica de decisión del menú de respaldo (fallback).
 *
 * Cubre el comportamiento cuando fetchMenu falla:
 * - Si el menú real carga OK → use menú real + pause del menú
 * - Si el menú falla tras reintentos → use menú estático + fetch /api/pause aparte
 * - Si /api/pause también falla → menú estático + pause = null (sin bloquear)
 *
 * La lógica pura se extrae del useEffect de StoreApp.jsx para ser testeable
 * sin React ni fetch reales.
 */

// --- Helpers puros (extraídos de StoreApp para test) ---

/**
 * Decide qué menú y qué pausa mostrar según los resultados de las peticiones.
 * @param {Object} params
 * @param {boolean} params.menuOk - true si fetchMenu resolvió
 * @param {Object|null} params.menuPause - pause que vino en el menú real (si menuOk)
 * @param {boolean} params.pauseFetchOk - true si getPause() resolvió (solo si !menuOk)
 * @param {Object|null} params.pauseData - respuesta COMPLETA de /api/pause (si pauseFetchOk), shape: { branches: { <branchId>: { paused, until, message } } }
 * @param {string} params.branchId - id de la sucursal (para extraer pause de branches)
 * @returns {{ menu: 'real'|'static', pause: Object|null, usingFallback: boolean }}
 */
function decideMenuState({ menuOk, menuPause = null, pauseFetchOk = false, pauseData = null, branchId = "tandil" }) {
  if (menuOk) {
    return {
      menu: "real",
      pause: menuPause,
      usingFallback: false,
    };
  }

  // Menú falló tras reintentos → estático
  let pause = null;
  if (pauseFetchOk && pauseData?.branches?.[branchId]) {
    pause = pauseData.branches[branchId];
  }
  return {
    menu: "static",
    pause,
    usingFallback: true,
  };
}

// --- Tests ---

describe("menu fallback decision — qué menú y pausa mostrar según resultados de API", () => {

  it("menú real OK → usa menú real + pause del menú, usingFallback=false", () => {
    const out = decideMenuState({
      menuOk: true,
      menuPause: { paused: true, until: Date.now() + 3600000, message: "Volvemos a las 20:00" },
    });
    assert.equal(out.menu, "real");
    assert.equal(out.usingFallback, false);
    assert.deepEqual(out.pause, { paused: true, until: out.pause.until, message: "Volvemos a las 20:00" });
  });

  it("menú real OK sin pause → pause=null, usingFallback=false", () => {
    const out = decideMenuState({ menuOk: true, menuPause: null });
    assert.equal(out.menu, "real");
    assert.equal(out.usingFallback, false);
    assert.equal(out.pause, null);
  });

  it("menú falla + /api/pause OK → menú estático + pause de /api/pause, usingFallback=true", () => {
    const pauseFromApi = { paused: true, until: Date.now() + 1800000, message: "Descanso corto" };
    const out = decideMenuState({
      menuOk: false,
      pauseFetchOk: true,
      pauseData: { branches: { tandil: pauseFromApi } },
    });
    assert.equal(out.menu, "static");
    assert.equal(out.usingFallback, true);
    assert.deepEqual(out.pause, pauseFromApi);
  });

  it("menú falla + /api/pause OK pero sin datos de la branch → pause=null", () => {
    const out = decideMenuState({
      menuOk: false,
      pauseFetchOk: true,
      pauseData: { branches: {} },
    });
    assert.equal(out.menu, "static");
    assert.equal(out.usingFallback, true);
    assert.equal(out.pause, null);
  });

  it("menú falla + /api/pause TAMBIÉN falla → menú estático + pause=null, usingFallback=true", () => {
    const out = decideMenuState({
      menuOk: false,
      pauseFetchOk: false,
    });
    assert.equal(out.menu, "static");
    assert.equal(out.usingFallback, true);
    assert.equal(out.pause, null);
  });

  it("menú falla + /api/pause OK pero pauseData null → pause=null", () => {
    const out = decideMenuState({
      menuOk: false,
      pauseFetchOk: true,
      pauseData: null,
    });
    assert.equal(out.menu, "static");
    assert.equal(out.usingFallback, true);
    assert.equal(out.pause, null);
  });
});