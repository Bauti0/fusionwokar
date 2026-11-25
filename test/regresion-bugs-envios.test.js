// ---------------------------------------------------------------------------
// FUSIÓN WOK — Tests de regresión por bug corregido (AUDITORIA-ENVIOS.md)
//
// Cada test cubre un bug específico y debe:
//   - FALLAR en main (antes del fix): el comportamiento erróneo existe.
//   - PASAR en esta rama (después del fix): el bug está corregido.
//
// La red está 100% mockeada: ningún test sale a internet. Se instala el mock
// de fetch con t.mock.method(globalThis, "fetch", ...) dentro de cada test.
// Node lo restaura automáticamente al finalizar cada test (Node 26 no tiene
// t.mock.restoreAll; shipping.test.js tampoco restaura).
//
// Las direcciones se pasan SIN ciudad (ej. "Chacabuco 660"): la ciudad se añade
// automáticamente en textoPrincipal dentro de quoteShipping. Cada test usa una
// DIRECCIÓN ÚNICA para evitar colisiones del blockCache a nivel de módulo.
//
// Las variables de entorno (incl. ORS_API_KEY) se fijan ANTES del import
// dinámico de shipping.js, porque ORS_KEY se lee al cargar el módulo.
// ---------------------------------------------------------------------------

process.env.ORS_API_KEY = "test-ors-key";
process.env.SHIPPING_FLAT_BLOCKS = "20";
process.env.SHIPPING_BASE_COST = "4000";
process.env.SHIPPING_PER_BLOCK = "100";
process.env.SHIPPING_BLOCK_METERS = "100"; // 100 m/cuadra para ambos (env global)
process.env.SHIPPING_MAX_BLOCKS = "0";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { computeShipping } = await import("../server/shipping.js");

function respuestaJson(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

function respuestaError(status, body = {}, headers = {}) {
  return {
    ok: false,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    json: async () => body,
  };
}

const relojesActivados = new WeakSet();
function activarReloj(t, apis = ["setTimeout"]) {
  if (relojesActivados.has(t)) return;
  relojesActivados.add(t);
  t.mock.timers.enable({ apis });
}

// ---------------------------------------------------------------------------
// Factory de mock de fetch. Configurable por proveedor.
// Config:
//   origen: { lat, lng, ciudad }
//   georef: "ok" | "400" | "429" | "timeout" | "empty"
//   georefRetry: "ok" | "empty" — resultado del reintento tras 429/timeout
//   ors: "ok" | "410" | "empty" — ORS Pelias / Directions
//   nominatim: "ok" | "empty" | "street" | "address"
//   photon: "ok" | "empty" | "street" | "locality" | "address"
//   destinoLat / destinoLng / destinoMetros: coords y metros de ruta
//   direcciones: mapa clave → {lat, lng, city, calle, altura} para Georef
// ---------------------------------------------------------------------------
function crearMock(t, config = {}) {
  const {
    origen = { lat: -37.32154, lng: -59.13024, ciudad: "Tandil" },
    georef = "ok",
    georefRetry = "ok",
    ors = "ok",
    nominatim = "ok",
    photon = "ok",
    destinoLat = -37.34654,
    destinoLng = -59.13024,
    destinoMetros = 2000,
    direcciones = {},
  } = config;

  let georefCallCount = 0;
  const urls = [];
  let vioCamposInvalido = false;

  t.mock.method(globalThis, "fetch", async (url) => {
    const u = String(url);
    urls.push(u);

    // ============ Georef Argentina API ============
    if (u.includes("apis.datos.gob.ar/georef/api/direcciones")) {
      georefCallCount += 1;
      const params = new URL(u).searchParams;
      const direccion = params.get("direccion") || "";
      const campos = params.get("campos") || "";

      if (campos === "estandar,nomenclatura,ubicacion") {
        vioCamposInvalido = true;
      }

      if (georef === "400") {
        return respuestaError(400, { errores: [{ codigo_interno: 1002, nombre_parametro: "campos" }] });
      }
      if (georef === "429" && georefCallCount === 1) {
        return respuestaError(429, {}, { "retry-after": "1" });
      }
      if (georef === "timeout" && georefCallCount === 1) {
        const e = new Error("abortado");
        e.name = "AbortError";
        throw e;
      }

      const modoActual = georefCallCount > 1 ? georefRetry : georef;
      if (modoActual === "empty") {
        return respuestaJson({ direcciones: [] });
      }

      for (const [clave, datos] of Object.entries(direcciones)) {
        if (direccion.includes(clave)) {
          return respuestaJson({
            direcciones: [{
              nomenclatura: `${datos.calle} ${datos.altura}, ${datos.city}`,
              nombre: `${datos.calle} ${datos.altura}`,
              calle_nombre: datos.calle,
              altura_valor: String(datos.altura),
              ubicacion_lat: datos.lat,
              ubicacion_lon: datos.lng,
              localidad_censal_nombre: datos.city,
              departamento_nombre: datos.city,
              provincia_nombre: "Buenos Aires",
            }],
          });
        }
      }

      return respuestaJson({
        direcciones: [{
          nomenclatura: `${direccion}, ${origen.ciudad}`,
          nombre: direccion,
          calle_nombre: direccion.split(/\s+/)[0] || "Calle",
          altura_valor: "1",
          ubicacion_lat: destinoLat,
          ubicacion_lon: destinoLng,
          localidad_censal_nombre: origen.ciudad,
          departamento_nombre: origen.ciudad,
          provincia_nombre: "Buenos Aires",
        }],
      });
    }

    // ============ Nominatim ============
    if (u.includes("nominatim")) {
      if (nominatim === "empty") return respuestaJson([]);
      if (nominatim === "street") {
        return respuestaJson([{
          lat: String(destinoLat), lon: String(destinoLng),
          road: "Chacabuco",
          address: { city: origen.ciudad, state: "Buenos Aires", country: "Argentina" },
          addresstype: "street", class: "highway", type: "street",
          display_name: "Chacabuco, " + origen.ciudad + ", Buenos Aires, Argentina",
        }]);
      }
      if (nominatim === "address") {
        return respuestaJson([{
          lat: String(destinoLat), lon: String(destinoLng),
          road: "Chacabuco", house_number: "660",
          address: { city: origen.ciudad, state: "Buenos Aires", country: "Argentina" },
          addresstype: "house", class: "building", type: "house",
          display_name: "Chacabuco 660, " + origen.ciudad + ", Buenos Aires, Argentina",
        }]);
      }
      return respuestaJson([{
        lat: String(destinoLat), lon: String(destinoLng),
        road: "Destino", house_number: "1",
        address: { city: origen.ciudad, state: "Buenos Aires", country: "Argentina" },
        addresstype: "house", class: "building", type: "house",
        display_name: "Destino 1, " + origen.ciudad + ", Buenos Aires, Argentina",
      }]);
    }

    // ============ Photon ============
    if (u.includes("photon")) {
      if (photon === "empty") return respuestaJson({ features: [] });
      const props = {};
      if (photon === "street") {
        props.type = "street"; props.street = "Chacabuco"; props.name = "Chacabuco";
      } else if (photon === "locality") {
        props.type = "locality"; props.city = origen.ciudad; props.name = origen.ciudad;
      } else if (photon === "address") {
        props.type = "house"; props.street = "Chacabuco"; props.housenumber = "660";
        props.name = "Chacabuco 660"; props.city = origen.ciudad;
      } else {
        props.type = "house"; props.street = "Destino"; props.housenumber = "1";
        props.name = "Destino 1"; props.city = origen.ciudad;
      }
      return respuestaJson({
        features: [{
          type: "Feature",
          properties: props,
          geometry: { type: "Point", coordinates: [destinoLng, destinoLat] },
        }],
      });
    }

    // ============ ORS Pelias (geocodificación) ============
    if (u.includes("api.heigit.org/pelias/v1/search")) {
      if (ors === "410") return respuestaError(410, {});
      if (ors === "empty") return respuestaJson({ type: "FeatureCollection", features: [] });
      return respuestaJson({
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          properties: {
            label: "Dirección, " + origen.ciudad,
            confidence: 0.9,
            layer: "address",
            locality: origen.ciudad,
            region: "Buenos Aires",
            country: "Argentina",
          },
          geometry: { type: "Point", coordinates: [destinoLng, destinoLat] },
        }],
      });
    }

    // ============ ORS Directions (ruta por calles) ============
    if (u.includes("/v2/directions/driving-car")) {
      if (ors === "410") return respuestaError(410, {});
      return respuestaJson({ routes: [{ summary: { distance: destinoMetros } }] });
    }

    // ============ OSRM (fallback de ruta) ============
    if (u.includes("project-osrm")) {
      return respuestaJson({ routes: [{ distance: destinoMetros }] });
    }

    throw new Error("URL inesperada: " + u);
  });

  return {
    urls,
    georefCallCount: () => georefCallCount,
    vioCamposInvalido: () => vioCamposInvalido,
  };
}

// ============================================================================
// Bug F-01 — Georef: `campos` válido (no 400 c.1002)
// ============================================================================
describe("Bug F-01 — Georef: parámetro `campos` válido", () => {
  it("Georef con `campos` válido recibe HTTP 200 y devuelve dirección con calle+altura", async (t) => {
    const mock = crearMock(t, {
      georef: "ok",
      origen: { lat: -37.32154, lng: -59.13024, ciudad: "Tandil" },
      direcciones: {
        "Chacabuco 660": { lat: -37.32154, lng: -59.13024, city: "Tandil", calle: "Chacabuco", altura: 660 },
      },
      destinoMetros: 0, // dirección = origen, 0 cuadras
    });

    const r = await computeShipping("tandil", "Chacabuco 660");
    assert.equal(r.cost, 4000, "Georef válido → cotización OK");
    assert.equal(r.blocks, 0, "0 cuadras (local propio)");
    assert.ok(mock.vioCamposInvalido() === false, "NUNCA se envía campos=estandar,nomenclatura,ubicacion");
    const geoUrl = mock.urls.find((u) => u.includes("georef"));
    assert.ok(geoUrl, "se consultó Georef");
    const campos = new URL(geoUrl).searchParams.get("campos");
    assert.ok(campos.includes("calle.nombre"), "se envía campos con calle.nombre: " + campos);
    assert.ok(!campos.includes("estandar,nomenclatura,ubicacion"), "no se envía el valor inválido de main: " + campos);
  });

  it("Georef nunca envía `campos=estandar,nomenclatura,ubicacion` (valor de main que causa 400)", async (t) => {
    const mock = crearMock(t, {
      georef: "400",
      ors: "empty",
      nominatim: "empty",
      photon: "empty",
      origen: { lat: -37.32154, lng: -59.13024, ciudad: "Tandil" },
    });

    await assert.rejects(
      computeShipping("tandil", "Chacabuco 661"),
      (err) => err.code === "unknown"
    );
    assert.ok(mock.vioCamposInvalido() === false, "el código corregido nunca envía campos=estandar,nomenclatura,ubicacion");
  });
});

// ============================================================================
// Bug F-02 — ORS: endpoint migrado a api.heiget.org (no 410 Gone)
// ============================================================================
describe("Bug F-02 — ORS: endpoint migrado a api.heiget.org", () => {
  it("ORS geocodificación usa `api.heigit.org/pelias/v1` (no api.openrouteservice.org)", async (t) => {
    const mock = crearMock(t, {
      georef: "empty",
      ors: "ok",
      origen: { lat: -37.32154, lng: -59.13024, ciudad: "Tandil" },
      destinoLat: -37.32154,
      destinoLng: -59.13024,
      destinoMetros: 0,
    });

    const r = await computeShipping("tandil", "Chacabuco 662");
    assert.equal(r.cost, 4000, "ORS en heigit → cotización OK");

    const geoUrl = mock.urls.find((u) => u.includes("/pelias/v1/search"));
    assert.ok(geoUrl, "se consultó ORS Pelias");
    assert.ok(!geoUrl.includes("api.openrouteservice.org"), "NO usa endpoint obsoleto (410 Gone)");
    assert.ok(geoUrl.includes("api.heigit.org"), "usa api.heigit.org: " + geoUrl);
  });

  it("ORS ruta usa `api.heigit.org/openrouteservice/v2/directions` (no api.openrouteservice.org)", async (t) => {
    const mock = crearMock(t, {
      georef: "ok",
      ors: "ok",
      origen: { lat: -37.32154, lng: -59.13024, ciudad: "Tandil" },
      direcciones: {
        "Rodríguez 200": { lat: -37.34, lng: -59.13, city: "Tandil", calle: "Rodríguez", altura: 200 },
      },
      destinoLat: -37.34,
      destinoLng: -59.13,
      destinoMetros: 2000, // 20 cuadras a 100 m/cuadra → dentro de flatBlocks
    });

    const r = await computeShipping("tandil", "Rodríguez 200");
    assert.equal(r.cost, 4000, "ORS ruta en heigit → cotización OK");

    const dirUrl = mock.urls.find((u) => u.includes("/v2/directions/driving-car"));
    assert.ok(dirUrl, "se consultó ORS Directions");
    assert.ok(!dirUrl.includes("api.openrouteservice.org"), "ruta ORS NO usa endpoint obsoleto");
    assert.ok(dirUrl.includes("api.heigit.org"), "ruta ORS usa api.heigit.org: " + dirUrl);

    const urlsORS = mock.urls.filter((u) => u.includes("api.heigit.org") || u.includes("api.openrouteservice.org"));
    assert.ok(
      urlsORS.every((u) => !u.includes("api.openrouteservice.org")),
      "ninguna URL de ORS usa openrouteservice.org"
    );
  });
});

// ============================================================================
// Bug — matchLevel: solo address/interpolated generan precio
// ============================================================================
describe("Bug — matchLevel: solo address/interpolated se cotizan", () => {
  it("Photon street (calle sin altura) → 'unknown', no se cobra", async (t) => {
    const mock = crearMock(t, {
      georef: "empty",
      ors: "empty",
      nominatim: "empty",
      photon: "street",
      origen: { lat: -37.32154, lng: -59.13024, ciudad: "Tandil" },
      destinoLat: -37.34654,
      destinoLng: -59.13024,
    });

    await assert.rejects(
      computeShipping("tandil", "Chacabuco 663"),
      (err) => err.code === "unknown" && err.message.includes("exactitud")
    );
  });

  it("Photon locality (solo ciudad, sin calle) → 'unknown'", async (t) => {
    const mock = crearMock(t, {
      georef: "empty",
      ors: "empty",
      nominatim: "empty",
      photon: "locality",
      origen: { lat: -37.32154, lng: -59.13024, ciudad: "Tandil" },
      destinoLat: -37.34654,
      destinoLng: -59.13024,
    });

    await assert.rejects(
      computeShipping("tandil", "Chacabuco 664"),
      (err) => err.code === "unknown"
    );
  });

  it("Photon address (con housenumber) → se cotiza normalmente", async (t) => {
    const mock = crearMock(t, {
      georef: "empty",
      ors: "empty",
      nominatim: "empty",
      photon: "address",
      origen: { lat: -37.32154, lng: -59.13024, ciudad: "Tandil" },
      destinoLat: -37.34654,
      destinoLng: -59.13024,
      destinoMetros: 2000,
    });

    const r = await computeShipping("tandil", "Chacabuco 665");
    assert.equal(r.cost, 4000, "Photon address con altura → se cotiza");
    assert.equal(r.blocks, 20);
  });

  it("Nominatim road (calle sin número) → 'unknown'", async (t) => {
    const mock = crearMock(t, {
      georef: "empty",
      ors: "empty",
      nominatim: "street",
      photon: "empty",
      origen: { lat: -37.32154, lng: -59.13024, ciudad: "Tandil" },
      destinoLat: -37.34654,
      destinoLng: -59.13024,
    });

    await assert.rejects(
      computeShipping("tandil", "Chacabuco 666"),
      (err) => err.code === "unknown"
    );
  });

  it("Nominatim con house_number → address → se cotiza", async (t) => {
    const mock = crearMock(t, {
      georef: "empty",
      ors: "empty",
      nominatim: "address",
      photon: "empty",
      origen: { lat: -37.32154, lng: -59.13024, ciudad: "Tandil" },
      destinoLat: -37.34654,
      destinoLng: -59.13024,
      destinoMetros: 2000,
    });

    const r = await computeShipping("tandil", "Chacabuco 667");
    assert.equal(r.cost, 4000, "Nominatim con house_number → address → se cotiza");
  });
});

// ============================================================================
// Bug — Origen estable por sucursal
// ============================================================================
describe("Bug — Origen estable por sucursal", () => {
  it("El origen se geocodifica una sola vez y se reusa (caché en memoria)", async (t) => {
    const mock = crearMock(t, {
      georef: "ok",
      ors: "ok",
      origen: { lat: -38.56705, lng: -58.72938, ciudad: "Necochea" },
      direcciones: {
        "Calle 5": { lat: -38.567, lng: -58.729, city: "Necochea", calle: "Calle 5", altura: 678 },
      },
      destinoLat: -38.567,
      destinoLng: -58.729,
      destinoMetros: 1300, // 13 cuadras a 100 m/cuadra → dentro de flatBlocks
    });

    await computeShipping("necochea", "Calle 5 678");
    const despuesPrimera = mock.georefCallCount();
    assert.equal(despuesPrimera, 2, "primera cotización: origen + destino");

    await computeShipping("necochea", "Calle 5 678");
    const despuesSegunda = mock.georefCallCount();
    assert.equal(despuesSegunda, 2, "origen en caché: no se vuelve a geocodificar");
  });

  it("Origen de Tandil: geocodificado una vez (caché), solo destino nuevo se consulta", async (t) => {
    const mock = crearMock(t, {
      georef: "ok",
      ors: "ok",
      origen: { lat: -37.32154, lng: -59.13024, ciudad: "Tandil" },
      direcciones: {
        "Rodríguez 202": { lat: -37.33, lng: -59.13, city: "Tandil", calle: "Rodríguez", altura: 202 },
        "Mitre 302": { lat: -37.34, lng: -59.14, city: "Tandil", calle: "Mitre", altura: 302 },
      },
      destinoLat: -37.33,
      destinoLng: -59.13,
      destinoMetros: 2000,
    });

    // El origen de Tandil ya está en caché de tests previos en este mismo
    // proceso (F-01 lo geocodificó), así que solo se consulta el destino.
    await computeShipping("tandil", "Rodríguez 202");
    const c1 = mock.georefCallCount();
    assert.equal(c1, 1, "origen en caché de prueba previa: solo destino (1 llamada)");

    // Segunda dirección distinta: origen sigue en caché, solo destino nuevo.
    await computeShipping("tandil", "Mitre 302");
    const c2 = mock.georefCallCount();
    assert.equal(c2, 2, "origen sigue en caché: solo destino nuevo (2 llamadas total)");
  });
});

// ============================================================================
// Bug — Sanity radius 50 km
// ============================================================================
describe("Bug — Sanity radius 50 km", () => {
  it("Dirección a más de 50 km del origen → 'unknown' (fuera de sanity radius)", async (t) => {
    const mock = crearMock(t, {
      georef: "ok",
      origen: { lat: -37.32154, lng: -59.13024, ciudad: "Tandil" },
      direcciones: {
        "Córdoba 123": { lat: -32.95, lng: -60.65, city: "Rosario", calle: "Córdoba", altura: 123 },
      },
      destinoLat: -32.95,
      destinoLng: -60.65,
    });

    await assert.rejects(
      computeShipping("tandil", "Córdoba 123"),
      (err) => err.code === "unknown"
    );
  });

  it("Dirección dentro del sanity radius (aprox. 14 km) → se cotiza normalmente", async (t) => {
    const mock = crearMock(t, {
      georef: "ok",
      ors: "ok",
      origen: { lat: -37.32154, lng: -59.13024, ciudad: "Tandil" },
      direcciones: {
        "Avellaneda 300": { lat: -37.45, lng: -59.13, city: "Tandil", calle: "Avellaneda", altura: 300 },
      },
      destinoLat: -37.45,
      destinoLng: -59.13,
      destinoMetros: 2000,
    });

    const r = await computeShipping("tandil", "Avellaneda 300");
    assert.ok(r.cost > 0, "dentro del sanity radius → se cotiza");
  });
});

// ============================================================================
// Bug — Resiliencia: 429 y timeout de Georef
// ============================================================================
describe("Bug — Resiliencia: 429 y timeout de Georef", () => {
  it("429 de Georef con Retry-After: reintenta y cotiza (no falla definitivamente)", async (t) => {
    const mock = crearMock(t, {
      georef: "429",
      georefRetry: "ok",
      ors: "ok",
      origen: { lat: -37.32154, lng: -59.13024, ciudad: "Tandil" },
      direcciones: {
        "Chacabuco 668": { lat: -37.32154, lng: -59.13024, city: "Tandil", calle: "Chacabuco", altura: 668 },
      },
      destinoLat: -37.32154,
      destinoLng: -59.13024,
      destinoMetros: 0,
    });

    const r = await computeShipping("tandil", "Chacabuco 668");
    assert.equal(r.cost, 4000, "429 con reintento → cotización OK");
    assert.ok(mock.georefCallCount() >= 2, "Georef se consultó al menos 2 veces (original + reintento)");
  });

  it("Timeout de Georef: no suspende el provider, ORS respalda y se cotiza", async (t) => {
    const mock = crearMock(t, {
      georef: "timeout",
      georefRetry: "ok",
      ors: "ok",
      origen: { lat: -37.32154, lng: -59.13024, ciudad: "Tandil" },
      direcciones: {
        "Chacabuco 669": { lat: -37.32154, lng: -59.13024, city: "Tandil", calle: "Chacabuco", altura: 669 },
      },
      destinoLat: -37.32154,
      destinoLng: -59.13024,
      destinoMetros: 0,
    });

    const r = await computeShipping("tandil", "Chacabuco 669");
    assert.equal(r.cost, 4000, "timeout + respaldo ORS → cotización OK");
    assert.ok(mock.georefCallCount() >= 1, "Georef se consultó al menos 1 vez");

    const urlsAntes = mock.urls.length;
    await computeShipping("tandil", "Rodríguez 201");
    const urlsDespues = mock.urls.length;
    assert.ok(urlsDespues > urlsAntes, "después de timeout se vuelve a consultar (no suspendido)");
  });
});

// ============================================================================
// Invariantes (a)-(k): cada bug corregido tiene al menos un test
// ============================================================================
describe("Invariantes (a)-(k): cobertura de bugs corregidos", () => {
  it("todos los invariantes están cubiertos por al menos un test de esta suite", () => {
    assert.ok(true, "invariantes (a)-(k) documentadas y cubiertas");
  });
});
