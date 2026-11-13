import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// FUSIÓN WOK — Geocodificación anclada a la sucursal (Necochea).
//
// La red se mockea POR COMPLETO: ningún test sale a internet. Se importa una
// instancia aislada de server/shipping.js con ORS_API_KEY seteada para que
// use OpenRouteService / Pelias (boundary.circle + boundary.country +
// focus.point, anclado a la sucursal).
// ---------------------------------------------------------------------------

process.env.ORS_API_KEY = "test-ors-key";
process.env.SHIPPING_FLAT_BLOCKS = "20";
process.env.SHIPPING_BASE_COST = "4000";
process.env.SHIPPING_PER_BLOCK = "100";
process.env.SHIPPING_BLOCK_METERS = "100"; // cuadra de Necochea
process.env.SHIPPING_MAX_BLOCKS = "0"; // sin tope de cobertura en Necochea

const {
  computeShipping,
  normalizarTexto,
  buildVariants,
} = await import("../server/shipping.js?instancia=necogeo");

const CENTRO_NECOCHEA = { lat: -38.5670514, lng: -58.7293811 };

function respuestaJson(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

function feature({ lat, lng, label = "Calle 95 1513, Necochea", confidence = 0.9 }) {
  return {
    type: "Feature",
    properties: {
      label,
      confidence,
      match_type: "exact",
      layer: "address",
      locality: "Necochea",
      region: "Buenos Aires",
      country: "Argentina",
    },
    geometry: { type: "Point", coordinates: [lng, lat] },
  };
}

function orsRespuesta(...features) {
  return respuestaJson({ type: "FeatureCollection", features: [...features] });
}
function orsVacia() {
  return respuestaJson({ type: "FeatureCollection", features: [] });
}

// Instala un mock de fetch que responde a ORS (geocode/search y driving-car).
// `geocodePorTexto`: mapa { cadenaQueActiva: [features] }. La clave es un
// fragmento del parámetro `text` de la consulta de geocodificación.
// `rutaKm`: distancia de ruta a devolver por driving-car (km).
function instalarMOCK(t, geocodePorTexto, rutaKm = 1) {
  const urls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/geocode/search")) {
      const q = new URL(u).searchParams.get("text") || "";
      const clave = Object.keys(geocodePorTexto).find((c) => q.includes(c));
      if (clave !== undefined) {
        const valor = geocodePorTexto[clave];
        const features = Array.isArray(valor) ? valor : (valor.features || []);
        return orsRespuesta(...features);
      }
      return orsVacia();
    }
    if (u.includes("nominatim")) return respuestaJson([]);
    if (u.includes("photon")) return respuestaJson({ features: [] });
    if (u.includes("/v2/directions/driving-car")) {
      return respuestaJson({ routes: [{ summary: { distance: Math.max(rutaKm * 1000, 1) } }] });
    }
    throw new Error("URL de ORS no esperada: " + u);
  };
  // Nota: no se restaura globalThis.fetch a propósito; cada test del archivo
  // reinstala su propio mock y el proceso termina al finalizar el archivo.
  return urls;
}

async function cotizar(t, branch, address, geocodePorTexto, rutaKm = 1) {
  const urls = instalarMOCK(t, geocodePorTexto, rutaKm);
  const valor = await computeShipping(branch, address);
  return { valor, urls };
}

// ---------------------------------------------------------------------------
describe("geocodificación anclada a la sucursal (Necochea)", () => {
  it("(a) la consulta de Necochea incluye la ciudad y el límite geográfico", async (t) => {
    const { urls } = await cotizar(t, "necochea", "Calle 95 1513", {
      "Diagonal San Martín": [feature({ lat: CENTRO_NECOCHEA.lat, lng: CENTRO_NECOCHEA.lng, label: "Diagonal San Martín 1258, Necochea" })],
      "Calle 95 1513": [feature({ lat: -38.567, lng: -58.729 })],
    });
    const geo = urls.find((u) => u.includes("/geocode/search"));
    assert.ok(geo, "se consultó el geocodificador");
    assert.ok(geo.includes("Necochea"), "la consulta incluye la ciudad de la sucursal");
    assert.ok(geo.includes("boundary.circle.lat"), "usa boundary.circle.lat");
    assert.ok(geo.includes("boundary.circle.lon"), "usa boundary.circle.lon");
    assert.ok(geo.includes("boundary.circle.radius"), "usa boundary.circle.radius");
    assert.ok(geo.includes("boundary.country=AR"), "usa boundary.country=AR");
    assert.ok(geo.includes("focus.point.lat"), "usa focus.point.lat");
    assert.ok(geo.includes("focus.point.lon"), "usa focus.point.lon");
    assert.ok(geo.includes(`boundary.circle.lat=${CENTRO_NECOCHEA.lat}`), "centro del círculo = origen de Necochea");
    assert.ok(geo.includes(`boundary.circle.radius=14`), "radio de búsqueda = 14 km");
  });

  it("(c) '95 1513 entre 36 y 38' se normaliza a 'Calle 95 1513' y el cruce no entra en el texto geocodificado", () => {
    const n = normalizarTexto("95 1513 entre 36 y 38");
    assert.equal(n.texto, "Calle 95 1513", "se normaliza a calle y altura");
    assert.equal(n.cruces[0], "entre 36 y 38", "se detecta el cruce para las notas");
    assert.ok(!n.texto.includes("entre"), "el cruce no entra en el texto geocodificado");
    assert.ok(!n.texto.includes("36 y 38"), "el cruce no entra en el texto geocodificado");
  });

  it("variantes definidas: cruce, solo calle y ciudad", () => {
    const v = buildVariants("Av. 59 y 10", {
      city: "Necochea",
      region: "Buenos Aires",
      country: "Argentina",
    });
    assert.ok(v.length >= 1, "genera al menos una variante");
    const principal = v[0];
    assert.ok(principal.texto.includes("Necochea"), "la variante principal incluye la ciudad");
    assert.ok(!principal.texto.includes(" y 10"), "el cruce no entra en la variante principal");
  });

  it("(d) computeShipping lanza 'unknown' cuando no se ubica la dirección", async (t) => {
    let error = null;
    try {
      await cotizar(t, "necochea", "Calle 999 99999", {
        "Diagonal San Martín": [feature({ lat: CENTRO_NECOCHEA.lat, lng: CENTRO_NECOCHEA.lng, label: "Diagonal San Martín 1258, Necochea" })],
        "Calle 999": orsVacia(),
        "Calle 999, Necochea": orsVacia(),
      });
    } catch (e) {
      error = e;
    }
    assert.equal(error.code, "unknown", "debe ser unknown: " + (error && error.code));
    assert.equal(error.message, "No pudimos ubicar esa dirección con exactitud.");
  });

  it("(e) dirección ubicada pero más allá del reparto → 'zone' con distancia correcta", async (t) => {
    process.env.SHIPPING_MAX_BLOCKS = "20";
    const { computeShipping: cs } = await import("../server/shipping.js?instancia=necogeo2");
    let error = null;
    try {
      await instalarMOCK(t, {
        "Diagonal San Martín": [feature({ lat: CENTRO_NECOCHEA.lat, lng: CENTRO_NECOCHEA.lng, label: "Diagonal San Martín 1258, Necochea" })],
        "Calle 1": [feature({ lat: -38.567, lng: -58.729 })],
      }, 50);
      await cs("necochea", "Calle 1 100");
    } catch (e) {
      error = e;
    } finally {
      process.env.SHIPPING_MAX_BLOCKS = "0";
    }
    assert.equal(error.code, "zone", "debe ser zone: " + (error && error.code));
    assert.ok(error.message.includes("cuadras"), "el mensaje lleva la distancia en cuadras");
  });
});
