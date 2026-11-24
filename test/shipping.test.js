import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------
// FUSIÓN WOK — Cálculo de envío por sucursal (con configuración en BD)
//
// Regla comercial: las primeras flatBlocks cuadras a la redonda del local
// cuestan baseCost fijos; cada cuadra extra cuesta perBlock. Una cuadra ≈
// blockMeters m (constante técnica: no viaja a la BD ni al panel).
//
// El cálculo lee la configuración de BD (server/shipping-settings.js), que
// al arrancar se siembra con los valores de .env/código y después puede
// editarse desde el panel. Estos tests siembran la BD con esos valores
// iniciales para que la tarifa sea idéntica a la de main.
// ---------------------------------------------------------------------

// ORS_API_KEY se mantiene en .env (secreto). En tests va vacía para que el
// router usado sea OSRM (mockeado) y nunca salga a internet.
process.env.ORS_API_KEY = "";

import { createTestDb } from "./db.js";
import { saveShippingSettings } from "../server/shipping-settings.js";
import { computeShipping } from "../server/shipping.js";

const ADMIN = { adminUserId: null, adminUsername: "prueba", adminRole: "superadmin" };

// Valores de semilla (los de .env / código de hoy) para cada sucursal.
function semilla(branch, sobre = {}) {
  return {
    origin_address: branch === "tandil"
      ? "Chacabuco 660, Tandil, Buenos Aires, Argentina"
      : "Diagonal San Martín 1258, Necochea, Buenos Aires, Argentina",
    origin_lat: null,
    origin_lng: null,
    base_cost: 4000,
    flat_blocks: 20,
    per_block: 100,
    max_blocks: 0, // 0 = sin tope
    auto_enabled: 1,
    ...sobre,
  };
}

async function dbConTarifa(branch, sobre = {}) {
  const { db, close } = await createTestDb();
  await saveShippingSettings({ db, branch, values: semilla(branch, sobre), ...ADMIN });
  return { db, close };
}

// Respuesta mínima con la forma que usa shipping.js (res.ok + res.json()).
function respuestaJson(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

// Contador de llamadas "externas" del mock: sirve para afirmar que un caso
// (p. ej. automático apagado) no consulta absolutamente nada.
let llamadasExternas = 0;

function mockearRed(t, { origen = { lat: "-37.32154", lon: "-59.13024" }, destinos = [] } = {}) {
  llamadasExternas = 0;
  // 1 grado de latitud ≈ 111.32 km = 111320 metros (aproximación suficiente para tests)
  const METROS_POR_GRADO_LAT = 111320;
  // Mapa clave -> metros para que OSRM calcule distancia real desde coordenadas
  const metrosPorClave = Object.fromEntries(destinos.map(d => [d.clave, Number(d.metros) || 0]));
  // Helper: respuesta Nominatim con address.city para validación de ciudad
  const nomResponse = (lat, lon, city) => [{
    lat: String(lat),
    lon: String(lon),
    address: { city: city, town: city, village: city, state: "Buenos Aires", country: "Argentina" }
  }];
  // Helper: respuesta Georef Argentina API
  const georefResponse = (lat, lon, city) => ({
    direcciones: [{
      tipo: "calle",
      nomenclatura: `${city} street`,
      nombre: `${city} street`,
      ubicacion: { lat: Number(lat), lon: Number(lon) },
      localidad: { nombre: city },
      departamento: { nombre: city },
      provincia: { nombre: "Buenos Aires" }
    }]
  });
  // Detectar ciudad esperada según la query (Necochea usa "Calle N", "Diagonal", "Av." + número)
  const detectarCiudad = (q) => {
    if (q.includes("Diagonal San Martín")) return "Necochea";
    if (q.includes("Chacabuco 660")) return "Tandil";
    // Calles numeradas estilo Necochea/La Plata: "Calle 5", "95 1513", "Av. 59"
    if (/\b(Calle|Av\.|Avenida)\s+\d+/.test(q) || /^\d+\s+\d+/.test(q)) return "Necochea";
    return "Tandil"; // default
  };
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = String(url);
    // Georef Argentina API: /direcciones?direccion=...&provincia=...&departamento=...
    if (u.includes("apis.datos.gob.ar/georef/api/direcciones")) {
      llamadasExternas += 1;
      const params = new URL(u).searchParams;
      const direccion = params.get("direccion") || "";
      const dept = params.get("departamento") || "";
      const city = dept || detectarCiudad(direccion);
      // Origen Tandil (Chacabuco 660)
      if (direccion.includes("Chacabuco 660")) return respuestaJson(georefResponse(origen.lat, origen.lon, city));
      // Origen Necochea (Diagonal San Martín 1258)
      if (direccion.includes("Diagonal San Martín")) return respuestaJson(georefResponse("-38.56705", "-58.72938", city));
      // Destinos
      for (const d of destinos) {
        if (direccion.includes(d.clave)) {
          const metros = Number(d.metros) || 0;
          const deltaLat = metros / METROS_POR_GRADO_LAT;
          const latDestino = Number(origen.lat) - deltaLat;
          return respuestaJson(georefResponse(latDestino, origen.lon, city));
        }
      }
      // No encontrado: devolver vacío para que falle a respaldos
      return respuestaJson({ direcciones: [] });
    }
    // Nominatim/Photon: usan parámetro 'q'
    const q = new URL(u).searchParams.get("q") || "";
    llamadasExternas += 1;
    const city = detectarCiudad(q);
    // Origen Tandil (Chacabuco 660): coordenadas fijas
    if (q.includes("Chacabuco 660")) return respuestaJson(nomResponse(origen.lat, origen.lon, city));
    // Origen Necochea (Diagonal San Martín 1258): coordenadas fijas
    if (q.includes("Diagonal San Martín")) return respuestaJson(nomResponse("-38.56705", "-58.72938", city));
    // Destino: para geocodificación, devolver coordenadas a la distancia esperada del origen.
    for (const d of destinos) {
      if (q.includes(d.clave)) {
        const metros = Number(d.metros) || 0;
        const deltaLat = metros / METROS_POR_GRADO_LAT;
        const latDestino = Number(origen.lat) - deltaLat; // hacia el sur
        return respuestaJson(nomResponse(latDestino, origen.lon, city));
      }
    }
    // OSRM / router: usa la misma aproximación lineal que el test (1 grado = 111320 m)
    // para que 2600 m den exactamente 20 cuadras (2600/130).
    if (u.includes("project-osrm")) {
      // URL: .../driving/fromLng,fromLat;toLng,toLat?overview=false...
      const m = /driving\/(-?[\d.]+),(-?[\d.]+);(-?[\d.]+),(-?[\d.]+)\?/.exec(u);
      if (!m) throw new Error(`URL de OSRM que el mock no entiende: ${u}`);
      const fromLat = Number(m[2]);
      const toLat = Number(m[4]);
      // Aproximación lineal: deltaLat * 111320 = metros. Redondear para evitar error flotante
      // en el borde exacto (2600/130 = 20.0000000049 > 20).
      const metros = Math.round(Math.abs(toLat - fromLat) * METROS_POR_GRADO_LAT);
      return respuestaJson({ routes: [{ distance: Math.max(metros, 1) }] });
    }
    throw new Error(`El mock no sabe responder esta URL: ${u}`);
  });
}

// Un solo juego de timers falsos por test. `enable()` dos veces sobre el
// mismo contexto tira ERR_INVALID_STATE.
const relojesActivados = new WeakSet();
function activarReloj(t, apis = ["setTimeout", "Date"]) {
  if (relojesActivados.has(t)) return;
  relojesActivados.add(t);
  t.mock.timers.enable({ apis });
}

// Cada test de Fase B importa una INSTANCIA NUEVA de server/shipping.js. Los
// cachés (por dirección, negativos), las suspensiones de provider y la cola de
// espaciado viven a nivel de módulo. Con un query distinto en la importación se
// obtiene un módulo limpio sin tocar una línea de producción.
let instanciasShipping = 0;
async function shippingAislado() {
  instanciasShipping += 1;
  return import(`../server/shipping.js?instancia=${instanciasShipping}`);
}

// cotizar(db, t, branch, address): corre computeShipping con el reloj falso
// para no esperar los sleeps reales del throttle. Usa una dirección nueva
// por test (computeShipping cachea por dirección 7 días).
async function cotizar(db, t, branch, address) {
  activarReloj(t, ["setTimeout"]);
  const promesa = computeShipping(db, branch, address);
  let termino = false;
  promesa.then(
    () => { termino = true; },
    () => { termino = true; }
  );
  for (let i = 0; !termino && i < 50; i++) {
    t.mock.timers.tick(1300);
    await new Promise((listo) => setImmediate(listo));
  }
  if (!termino) throw new Error("computeShipping no terminó tras avanzar el reloj mockeado");
  return promesa;
}

describe("computeShipping (tarifa por cuadras, con la red mockeada)", () => {
  it("0 cuadras (la dirección del propio local) también paga la base: $4.000", async (t) => {
    // Regresión que cubre: la regla comercial dice que la franquicia
    // cobra la base desde la cuadra 0; si alguien "optimiza" el cálculo
    // para devolver $0 cuando la ruta es mínima, el envío al propio
    // local dejaría de cobrarse.
    const { db, close } = await dbConTarifa("tandil");
    try {
      mockearRed(t, { destinos: [{ clave: "Rodríguez 50", lat: "-37.32154", metros: 0 }] });
      const r = await cotizar(db, t, "tandil", "Rodríguez 50");
      assert.deepEqual(r, { cost: 4000, blocks: 0, supported: true });
    } finally {
      await close();
    }
  });

  it("justo 20 cuadras entra en la franquicia: $4.000 (borde exacto)", async (t) => {
    // Regresión que cubre: el borde `exact <= FLAT_BLOCKS`. Con un `<=`
    // cambiado por `<` (o con un redondeo mal puesto), la cuadra 20
    // empezaría a cobrarse como extra y todos los envíos del límite
    // subirían $100 de la nada.
    const { db, close } = await dbConTarifa("tandil");
    try {
      mockearRed(t, { destinos: [{ clave: "Rodríguez 200", lat: "-37.32154", metros: 2600 }] });
      const r = await cotizar(db, t, "tandil", "Rodríguez 200");
      assert.deepEqual(r, { cost: 4000, blocks: 20, supported: true });
    } finally {
      await close();
    }
  });

  it("21 cuadras: la primera extra suma $100 → $4.100", async (t) => {
    // Regresión que cubre: la primera cuadra fuera de la franquicia
    // cobra como extra. Es el caso que más se toca al ajustar la
    // tarifa; estos números son los que el cliente ve en el checkout.
    const { db, close } = await dbConTarifa("tandil");
    try {
      mockearRed(t, { destinos: [{ clave: "Rodríguez 210", lat: "-37.32154", metros: 2730 }] });
      const r = await cotizar(db, t, "tandil", "Rodríguez 210");
      assert.deepEqual(r, { cost: 4100, blocks: 21, supported: true });
    } finally {
      await close();
    }
  });

  it("media cuadra extra cobra como cuadra entera: 20,5 cuadras → $4.100 y blocks 21", async (t) => {
    // Regresión que cubre: el redondeo es Math.ceil para el extra (la
    // cuadra PARCIAL paga como entera). Con Math.round, esta dirección
    // daría $4.000 y el reparto perdería $100 en cada borde.
    const { db, close } = await dbConTarifa("tandil");
    try {
      mockearRed(t, { destinos: [{ clave: "Maipú 310", lat: "-37.32154", metros: 2665 }] });
      const r = await cotizar(db, t, "tandil", "Maipú 310");
      assert.deepEqual(r, { cost: 4100, blocks: 21, supported: true });
    } finally {
      await close();
    }
  });

  it("más allá del tope (SHIPPING_MAX_BLOCKS=40) se rechaza como fuera de zona", async (t) => {
    // Regresión que cubre: el tope de reparto existe para que nadie
    // pida a 50 cuadras "con envío barato": sin el rechazo, el pedido
    // pasaría igual y saldría a repartir a cualquier distancia.
    // El código de error ("zone") es lo que hace que el endpoint
    // devuelva 400 definitivo en vez de 503 reintentable.
    const { db, close } = await dbConTarifa("tandil", { max_blocks: 40 });
    try {
      mockearRed(t, { destinos: [{ clave: "Alem 4200", lat: "-37.32154", metros: 6500 }] });
      await assert.rejects(
        cotizar(db, t, "tandil", "Alem 4200"),
        (err) => {
          assert.equal(err.code, "zone");
          assert.match(err.message, /50 cuadras/);
          assert.match(err.message, /hasta 40 cuadras/);
          return true;
        }
      );
    } finally {
      await close();
    }
  });

  it("Necochea calcula envío con misma tarifa: $4.000 hasta 20 cuadras (13 cuadras a 100 m/cuadra)", async (t) => {
    // Regresión que cubre: Necochea tiene reparto con la misma tarifa.
    // La cuadra de Necochea es 100 m (constante técnica), así que 1300 m
    // de ruta = 13 cuadras, dentro de la franquicia de 20.
    const { db, close } = await dbConTarifa("necochea");
    try {
      mockearRed(t, {
        origen: { lat: "-38.56705", lon: "-58.72938" },
        destinos: [{ clave: "Calle 5 678", lat: "-38.567", metros: 1300 }],
      });
      const r = await cotizar(db, t, "necochea", "Calle 5 678");
      assert.deepEqual(r, { cost: 4000, blocks: 13, supported: true });
    } finally {
      await close();
    }
  });
});

describe("automático de encendido/apagado", () => {
  it("auto apagado: no hace llamadas de red y el pedido queda pendiente", async (t) => {
    // Regresión del punto 3: con auto_enabled = 0 el servidor no llama al
    // geocodificador ni a ORS. Se mockea fetch y se verifica que no se llamó.
    const { db, close } = await dbConTarifa("necochea", { auto_enabled: 0 });
    try {
      mockearRed(t);
      const r = await cotizar(db, t, "necochea", "Calle 5 678");
      assert.equal(r.supported, true);
      assert.equal(r.pending, true);
      assert.equal(r.cost, 0);
      assert.equal(llamadasExternas, 0, "cero llamadas de red");
    } finally {
      await close();
    }
  });

  it("auto encendido: igual que antes (cálculo normal)", async (t) => {
    // Regresión del punto 3: con auto_enabled = 1 todo funciona como hoy.
    const { db, close } = await dbConTarifa("necochea", { auto_enabled: 1 });
    try {
      mockearRed(t, {
        origen: { lat: "-38.56705", lon: "-58.72938" },
        destinos: [{ clave: "Calle 5 678", lat: "-38.567", metros: 1300 }],
      });
      const r = await cotizar(db, t, "necochea", "Calle 5 678");
      assert.deepEqual(r, { cost: 4000, blocks: 13, supported: true });
    } finally {
      await close();
    }
  });

  it("apagar Necochea no afecta a Tandil", async (t) => {
    // Regresión del punto 3: la configuración es por sucursal.
    const { db, close } = await createTestDb();
    try {
      await saveShippingSettings({ db, branch: "necochea", values: semilla("necochea", { auto_enabled: 0 }), ...ADMIN });
      await saveShippingSettings({ db, branch: "tandil", values: semilla("tandil"), ...ADMIN });
      mockearRed(t, { destinos: [{ clave: "Rodríguez 200", lat: "-37.32154", metros: 2600 }] });
      const neo = await cotizar(db, t, "necochea", "Calle 5 678");
      const tan = await cotizar(db, t, "tandil", "Rodríguez 200");
      assert.equal(neo.pending, true, "Necochea queda a confirmar");
      assert.deepEqual(tan, { cost: 4000, blocks: 20, supported: true }, "Tandil sigue calculando");
    } finally {
      await close();
    }
  });
});

// =====================================================================
// FASE B: resiliencia de la cadena externa (timeouts, 403, 429,
// suspensiones, techo global y caché negativo). RED 100% MOCKEADA.
//
// Estas pruebas controlan cada provider (nominatim / photon / OSRM) por
// COMPORTAMIENTO (ok, 403, 429, timeout, caída) y avanzan el reloj falso para
// no esperar los sleeps reales. No tocan la fórmula de costos ni las tarifas.
// =====================================================================

const ORIGEN_MOCK = { lat: "-37.32154", lon: "-59.13024" };
// ~2.78 km al sur del local: OSRM sano → 2.780 m = 21,4 cuadras ($4.200).
const DESTINO_MOCK = { lat: "-37.34654", lon: "-59.13024" };
// ~6.5 km al sur del local: 50 cuadras, más allá del tope de 40.
const DESTINO_LEJANO = { lat: "-37.38000", lon: "-59.13024" };

function redPorDefecto() {
  return {
    nominatim: "ok",
    photon: "ok",
    osrm: "ok",
    georef: "ok",
    modoPorConsulta: {},
    origen: ORIGEN_MOCK,
    destino: DESTINO_MOCK,
    factorRuta: 1,
    sinResultado: [],
    demora: { nominatim: 0, photon: 0, osrm: 0, georef: 0 },
    demoraPorConsulta: {},
    retryAfter: null,
    urls: [],
    georefCallCount: new Map(), // query -> call count
  };
}
let RED = redPorDefecto();

function dormirEnRelojFalso(ms) {
  return new Promise((listo) => setTimeout(listo, ms));
}

function respuestaError(status, headers = {}) {
  return {
    ok: false,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    json: async () => ({}),
  };
}

function sinResultados(host) {
  return host === "photon" ? respuestaJson({ features: [] }) : respuestaJson([]);
}

function hostDe(u) {
  if (u.includes("nominatim")) return "nominatim";
  if (u.includes("photon")) return "photon";
  if (u.includes("project-osrm")) return "osrm";
  if (u.includes("openrouteservice")) return "ors";
  if (u.includes("apis.datos.gob.ar/georef/api/direcciones")) return "georef";
  return null;
}

function consultaDe(u, host) {
  if (host === "osrm" || host === "ors") return "";
  if (host === "georef") return new URL(u).searchParams.get("direccion") || "";
  return new URL(u).searchParams.get("q") || "";
}

function valorParaConsulta(tabla, q) {
  for (const clave of Object.keys(tabla)) {
    if (q.toLowerCase().includes(clave.toLowerCase())) return tabla[clave];
  }
  return undefined;
}

function distanciaLineaRectaKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function fetchMockeado(url) {
  const u = String(url);
  RED.urls.push(u);
  const host = hostDe(u);
  if (host === null) throw new Error(`El mock no sabe responder esta URL: ${u}`);
  if (host === "ors") throw new Error(`El mock no debe consultar ORS: ${u}`);

  const q = consultaDe(u, host);

  // Track call count for georef to allow first call to fail with 429 and retry to succeed
  if (host === "georef") {
    const count = (RED.georefCallCount.get(q) || 0) + 1;
    RED.georefCallCount.set(q, count);
    // On first call, use default mode (e.g., 429). On retry, use modoPorConsulta if defined.
    let modo;
    if (count === 1) {
      modo = RED[host] ?? "ok";
    } else {
      modo = valorParaConsulta(RED.modoPorConsulta, q) ?? (RED[host] ?? "ok");
    }
    const demora = valorParaConsulta(RED.demoraPorConsulta, q) ?? RED.demora[host] ?? 0;
    if (demora > 0) await dormirEnRelojFalso(demora);

    if (modo === "403") return respuestaError(403);
    if (modo === "429") {
      const headers = RED.retryAfter == null ? {} : { "retry-after": String(RED.retryAfter) };
      return respuestaError(429, headers);
    }
    if (modo === "timeout") {
      const e = new Error("abortado");
      e.name = "AbortError";
      throw e;
    }
    if (modo === "fail") throw new Error("red caída");
  } else {
    // For other hosts, use the original logic
    const modo = valorParaConsulta(RED.modoPorConsulta, q) ?? (RED[host] ?? "ok");
    const demora = valorParaConsulta(RED.demoraPorConsulta, q) ?? RED.demora[host] ?? 0;
    if (demora > 0) await dormirEnRelojFalso(demora);

    if (modo === "403") return respuestaError(403);
    if (modo === "429") {
      const headers = RED.retryAfter == null ? {} : { "retry-after": String(RED.retryAfter) };
      return respuestaError(429, headers);
    }
    if (modo === "timeout") {
      const e = new Error("abortado");
      e.name = "AbortError";
      throw e;
    }
    if (modo === "fail") throw new Error("red caída");
  }

  const ql = q.toLowerCase();
  if (RED.sinResultado.some((s) => ql.includes(String(s).toLowerCase()))) {
    return sinResultados(host);
  }

  // Georef Argentina API: usar parámetro 'direccion'
  if (host === "georef") {
    const direccion = new URL(u).searchParams.get("direccion") || "";
    const dept = new URL(u).searchParams.get("departamento") || "";
    const city = dept || (direccion.includes("Diagonal San Martín") ? "Necochea" : "Tandil");
    // Respuesta Georef vacía si sinResultado activo y no es el origen
    if (RED.sinResultado.length > 0 && !direccion.includes("Chacabuco 660") && !direccion.includes("Diagonal San Martín")) {
      return respuestaJson({ direcciones: [] });
    }
    // Origen Tandil
    if (direccion.includes("Chacabuco 660")) {
      return respuestaJson({
        direcciones: [{
          tipo: "calle",
          nomenclatura: "Chacabuco 660",
          nombre: "Chacabuco 660",
          ubicacion: { lat: Number(RED.origen.lat), lon: Number(RED.origen.lon) },
          localidad: { nombre: city },
          departamento: { nombre: city },
          provincia: { nombre: "Buenos Aires" }
        }]
      });
    }
    // Origen Necochea
    if (direccion.includes("Diagonal San Martín")) {
      return respuestaJson({
        direcciones: [{
          tipo: "calle",
          nomenclatura: "Diagonal San Martín 1258",
          nombre: "Diagonal San Martín 1258",
          ubicacion: { lat: Number(RED.origen.lat), lon: Number(RED.origen.lon) },
          localidad: { nombre: city },
          departamento: { nombre: city },
          provincia: { nombre: "Buenos Aires" }
        }]
      });
    }
    // Destino: buscar en RED.destino o usar coordenadas por defecto
    return respuestaJson({
      direcciones: [{
        tipo: "calle",
        nomenclatura: direccion,
        nombre: direccion,
        ubicacion: { lat: Number(RED.destino.lat), lon: Number(RED.destino.lon) },
        localidad: { nombre: city },
        departamento: { nombre: city },
        provincia: { nombre: "Buenos Aires" }
      }]
    });
  }

  if (host === "osrm") {
    // URL: .../driving/fromLng,fromLat;toLng,toLat?overview=false...
    const m = /driving\/(-?[\d.]+),(-?[\d.]+);(-?[\d.]+),(-?[\d.]+)\?/.exec(u);
    if (!m) throw new Error(`URL de OSRM que el mock no entiende: ${u}`);
    const from = { lat: Number(m[2]), lng: Number(m[1]) };
    const to = { lat: Number(m[4]), lng: Number(m[3]) };
    const km = distanciaLineaRectaKm(from, to) * RED.factorRuta;
    return respuestaJson({ routes: [{ distance: Math.max(1, Math.round(km * 1000)) }] });
  }
  if (host === "photon") {
    // Si hay sinResultado activo, devolver vacío para consultas que no sean el origen
    if (RED.sinResultado.length > 0 && !q.includes("Chacabuco 660")) {
      return respuestaJson({ features: [] });
    }
    const coords = q.includes("Chacabuco 660") ? RED.origen : RED.destino;
    const city = q.includes("Chacabuco 660") ? "Tandil" : "Tandil"; // tests usan Tandil
    return respuestaJson({
      features: [{
        geometry: { coordinates: [Number(coords.lon), Number(coords.lat)] },
        properties: { city, state: "Buenos Aires", country: "Argentina" }
      }],
    });
  }
  // Para Nominatim: si hay sinResultado configurado (test de unknown), devolver vacío
  // para CUALQUIER consulta que no sea el origen.
  if (RED.sinResultado.length > 0 && !q.includes("Chacabuco 660")) {
    return respuestaJson([]);
  }
  // Nominatim response con address para validación de ciudad
  const withAddress = (obj, city) => ({
    ...obj,
    address: { city, town: city, village: city, state: "Buenos Aires", country: "Argentina" }
  });
  if (q.includes("Chacabuco 660")) return respuestaJson([withAddress(RED.origen, "Tandil")]);
  return respuestaJson([withAddress(RED.destino, "Tandil")]);
}

const WARNINGS = [];

function armarRed(t, { db, branch = "tandil" }) {
  RED = redPorDefecto();
  activarReloj(t);
  WARNINGS.length = 0;
  t.mock.method(console, "warn", (...args) => WARNINGS.push(args.join(" ")));
  t.mock.method(globalThis, "fetch", fetchMockeado);
  return { db, branch };
}

async function correr(t, fn, { maxMs = 30000, paso = 100 } = {}) {
  const inicio = Date.now();
  let valor = null;
  let error = null;
  let termino = false;
  Promise.resolve()
    .then(fn)
    .then(
      (v) => { valor = v; termino = true; },
      (e) => { error = e; termino = true; }
    );
  for (let elapsed = 0; !termino && elapsed < maxMs; elapsed += paso) {
    t.mock.timers.tick(paso);
    await new Promise((listo) => setImmediate(listo));
  }
  if (!termino) throw new Error(`la operación no terminó tras ${maxMs} ms simulados`);
  return { valor, error, warnings: [...WARNINGS], transcurrido: Date.now() - inicio };
}

async function avanzar(t, ms) {
  t.mock.timers.tick(ms);
  await new Promise((listo) => setImmediate(listo));
}

function llamadasDesde(indice, host) {
  return RED.urls.slice(indice).filter((u) => u.includes(host)).length;
}

describe("resiliencia de la cadena externa (red mockeada, relojes falsos)", () => {
  it("403 de Georef: loguea el status sin la dirección, suspende el provider ~10 min y después lo reactiva", async (t) => {
    const { db, close } = await dbConTarifa("tandil");
    try {
      const { computeShipping } = await shippingAislado();
      armarRed(t, { db });
      RED.georef = "403";

      const r1 = await correr(t, () => computeShipping(db, "tandil", "Uruguay 1200"));
      assert.equal(r1.error, null, `no debe fallar la cotización: ${r1.error?.message}`);
      assert.deepEqual(r1.valor, { cost: 4200, blocks: 22, supported: true });
      assert.ok(
        r1.warnings.some((w) => w.includes("georef") && w.includes("403")),
        "loguea una línea con el provider y el status 403"
      );
      for (const w of r1.warnings) {
        assert.ok(!w.includes("Uruguay"), `el log no debe llevar la dirección: ${w}`);
      }

      let marca = RED.urls.length;
      const r2 = await correr(t, () => computeShipping(db, "tandil", "Uruguay 1300"));
      assert.equal(r2.error, null, `el respaldo tiene que cotizar: ${r2.error?.message}`);
      assert.deepEqual(r2.valor, { cost: 4200, blocks: 22, supported: true });
      assert.equal(llamadasDesde(marca, "georef"), 0, "no consulta georef suspendido");
      assert.ok(llamadasDesde(marca, "photon") > 0 || llamadasDesde(marca, "nominatim") > 0, "usa el provider de respaldo");

      await avanzar(t, 10 * 60 * 1000 + 1000);
      RED.georef = "ok";
      marca = RED.urls.length;
      const r3 = await correr(t, () => computeShipping(db, "tandil", "Uruguay 1400"));
      assert.equal(r3.error, null, `tras la suspensión vuelve a cotizar: ${r3.error?.message}`);
      assert.ok(llamadasDesde(marca, "georef") > 0, "georef se reactiva después de ~10 min");
    } finally {
      await close();
    }
  });

  it("timeout de Georef: NO suspende el provider (la cotización siguiente lo vuelve a consultar)", async (t) => {
    const { db, close } = await dbConTarifa("tandil");
    try {
      const { computeShipping } = await shippingAislado();
      armarRed(t, { db });
      RED.georef = "timeout";

      const r1 = await correr(t, () => computeShipping(db, "tandil", "Italia 2100"));
      assert.equal(r1.error, null, `photon de respaldo: ${r1.error?.message}`);
      assert.deepEqual(r1.valor, { cost: 4200, blocks: 22, supported: true });
      assert.ok(
        r1.warnings.some((w) => w.includes("georef") && w.includes("timeout")),
        "loguea el timeout del provider"
      );
      assert.ok(r1.transcurrido < 12000, `un timeout no cuesta la suspensión de 10 min: ${r1.transcurrido} ms`);

      const marca = RED.urls.length;
      const r2 = await correr(t, () => computeShipping(db, "tandil", "Italia 2200"));
      assert.equal(r2.error, null, `la segunda también cotiza: ${r2.error?.message}`);
      assert.ok(llamadasDesde(marca, "georef") >= 1, "un timeout no suspende: se reintenta");
    } finally {
      await close();
    }
  });

  it("429 con Retry-After: respeta la espera del header y no suspende al provider", async (t) => {
    const { db, close } = await dbConTarifa("tandil");
    try {
      const { computeShipping } = await shippingAislado();
      armarRed(t, { db });
      RED.georef = "429";
      RED.retryAfter = 3; // segundos
      // Permitir que el origen y el reintento de la primera consulta tengan éxito
      RED.modoPorConsulta = { "Chacabuco 660": "ok", "San Martín 1500": "ok" };

      const r1 = await correr(t, () => computeShipping(db, "tandil", "San Martín 1500"));
      assert.equal(r1.error, null, `con Retry-After la cotización sale: ${r1.error?.message}`);
      assert.deepEqual(r1.valor, { cost: 4200, blocks: 22, supported: true });
      assert.ok(
        r1.warnings.some((w) => w.includes("georef") && w.includes("429")),
        "loguea el 429 con su status"
      );
      assert.ok(r1.transcurrido >= 3000, `esperó el Retry-After: ${r1.transcurrido} ms`);

      const marca = RED.urls.length;
      const r2 = await correr(t, () => computeShipping(db, "tandil", "San Martín 1600"));
      assert.equal(r2.error, null, `vuelve a cotizar: ${r2.error?.message}`);
      assert.ok(llamadasDesde(marca, "georef") >= 1, "no queda suspendido por un 429 aislado");
    } finally {
      await close();
    }
  });

  it("429 con Retry-After enorme: la espera se topa (no se cuelga ni quema el techo de 12 s)", async (t) => {
    const { db, close } = await dbConTarifa("tandil");
    try {
      const { computeShipping } = await shippingAislado();
      armarRed(t, { db });
      RED.georef = "429";
      RED.retryAfter = 30; // 30 s: sin tope quemaría el techo global de 12 s
      RED.modoPorConsulta = { "Chacabuco 660": "ok" };

      const r1 = await correr(t, () => computeShipping(db, "tandil", "Bolívar 1700"), { maxMs: 40000 });
      assert.equal(r1.error, null, `con el tope la cotización sale: ${r1.error?.message}`);
      assert.deepEqual(r1.valor, { cost: 4200, blocks: 22, supported: true });
      assert.ok(r1.transcurrido >= 5000, `esperó el tope de 5 s: ${r1.transcurrido} ms`);
      assert.ok(
        r1.transcurrido < 12000,
        `sin tope habría esperado 30 s y el techo global la cortado: ${r1.transcurrido} ms`
      );
    } finally {
      await close();
    }
  });

  it("Photon responde mientras Georef está suspendido: la cotización funciona", async (t) => {
    const { db, close } = await dbConTarifa("tandil");
    try {
      const { computeShipping } = await shippingAislado();
      armarRed(t, { db });
      RED.georef = "403";
      RED.nominatim = "403"; // Suspender también Nominatim para forzar Photon
      await correr(t, () => computeShipping(db, "tandil", "Urquiza 1800"));

      const marca = RED.urls.length;
      const r = await correr(t, () => computeShipping(db, "tandil", "Urquiza 1900"));
      assert.equal(r.error, null, `con photon la cotización sale: ${r.error?.message}`);
      assert.deepEqual(r.valor, { cost: 4200, blocks: 22, supported: true });
      assert.equal(llamadasDesde(marca, "georef"), 0, "photon respondió sin esperar a georef");
      assert.equal(llamadasDesde(marca, "nominatim"), 0, "photon respondió sin esperar a nominatim");
      assert.ok(llamadasDesde(marca, "photon") > 0, "photon es quien geocodifica");
    } finally {
      await close();
    }
  });

  it("techo global ~12 s: una cadena sana pero lenta termina en transient, no en una cotización", async (t) => {
    const { db, close } = await dbConTarifa("tandil");
    try {
      const { computeShipping } = await shippingAislado();
      armarRed(t, { db });
      RED.demoraPorConsulta = { "Chacabuco 660": 13000 };

      const r = await correr(t, () => computeShipping(db, "tandil", "Lenta 1900"), { maxMs: 40000 });
      assert.equal(r.error?.code, "transient", `debe cortar por el techo global: ${r.error?.code}`);
      assert.ok(
        r.transcurrido >= 13000 && r.transcurrido < 20000,
        `corta tras una sola consulta externa: ${r.transcurrido} ms`
      );
    } finally {
      await close();
    }
  });

  it("el techo global NO dispara con demoras cortas: la misma cadena sana cotiza", async (t) => {
    const { db, close } = await dbConTarifa("tandil");
    try {
      const { computeShipping } = await shippingAislado();
      armarRed(t, { db });
      RED.demora = { nominatim: 2000, photon: 2000, osrm: 2000 };

      const r = await correr(t, () => computeShipping(db, "tandil", "Corta 2000"));
      assert.equal(r.error, null, `una cadena lenta pero viable cotiza: ${r.error?.message}`);
      assert.deepEqual(r.valor, { cost: 4200, blocks: 22, supported: true });
      assert.ok(r.transcurrido < 12000, `no debe acercarse al techo: ${r.transcurrido} ms`);
    } finally {
      await close();
    }
  });

  it("OSRM caído: la ruta cae al fallback haversine y la cotización sigue saliendo", async (t) => {
    const { db, close } = await dbConTarifa("tandil");
    try {
      const { computeShipping } = await shippingAislado();
      armarRed(t, { db });
      RED.osrm = "timeout";

      const r1 = await correr(t, () => computeShipping(db, "tandil", "Brown 2300"));
      assert.equal(r1.error, null, `el fallback tiene que cotizar: ${r1.error?.message}`);
      assert.deepEqual(r1.valor, { cost: 4700, blocks: 27, supported: true });
      assert.ok(r1.warnings.some((w) => w.includes("osrm")), "loguea la falla del router");

      RED.osrm = "ok";
      const r2 = await correr(t, () => computeShipping(db, "tandil", "Brown 2400"));
      assert.equal(r2.error, null, `con OSRM sano cotiza: ${r2.error?.message}`);
      assert.deepEqual(r2.valor, { cost: 4200, blocks: 22, supported: true });
    } finally {
      await close();
    }
  });

  it("caché negativo de transient: 15 s sin repetir llamadas externas; después vuelve a consultar", async (t) => {
    const { db, close } = await dbConTarifa("tandil");
    try {
      const { computeShipping } = await shippingAislado();
      armarRed(t, { db });
      RED.georef = "fail";
      RED.nominatim = "fail";
      RED.photon = "fail";
      const dir = "Falla 2400";

      const r1 = await correr(t, () => computeShipping(db, "tandil", dir));
      assert.equal(r1.error?.code, "transient", `ante la cadena caída es transient: ${r1.error?.code}`);
      const llamadas = RED.urls.length;

      const r2 = await correr(t, () => computeShipping(db, "tandil", dir), { maxMs: 5000 });
      assert.equal(r2.error?.code, "transient", `sigue siendo transient: ${r2.error?.code}`);
      assert.equal(RED.urls.length, llamadas, "dentro de los 15 s no vuelve a golpear la red");

      await avanzar(t, 15000 + 500);
      const r3 = await correr(t, () => computeShipping(db, "tandil", dir));
      assert.equal(r3.error?.code, "transient", `sigue sin salida: ${r3.error?.code}`);
      assert.ok(RED.urls.length > llamadas, "pasados los 15 s vuelve a consultar");
    } finally {
      await close();
    }
  });

  it("unknown se cachea 90 s (no se re-consulta la red dentro de ese lapso)", async (t) => {
    const { db, close } = await dbConTarifa("tandil");
    try {
      const { computeShipping } = await shippingAislado();
      armarRed(t, { db });
      RED.sinResultado = ["Sin Coordenadas"];
      const dir = "Sin Coordenadas 2500";

      const r1 = await correr(t, () => computeShipping(db, "tandil", dir));
      assert.equal(r1.error?.code, "unknown", `no encontrada es unknown: ${r1.error?.code}`);
      const llamadas = RED.urls.length;

      const r2 = await correr(t, () => computeShipping(db, "tandil", dir), { maxMs: 5000 });
      assert.equal(r2.error?.code, "unknown", `desde caché sigue siendo unknown: ${r2.error?.code}`);
      assert.equal(RED.urls.length, llamadas, "unknown cacheado 90 s: no repite la red");

      await avanzar(t, 90 * 1000 + 1000);
      const r3 = await correr(t, () => computeShipping(db, "tandil", dir));
      assert.equal(r3.error?.code, "unknown", `vencido el plazo se reintenta: ${r3.error?.code}`);
      assert.ok(RED.urls.length > llamadas, "pasados los 90 s vuelve a consultar");
    } finally {
      await close();
    }
  });

  it("zone se cachea 90 s (mismo plazo que unknown)", async (t) => {
    const { db, close } = await dbConTarifa("tandil", { max_blocks: 40 });
    try {
      const { computeShipping } = await shippingAislado();
      armarRed(t, { db });
      RED.destino = DESTINO_LEJANO;
      const dir = "Lejana 2600";

      const r1 = await correr(t, () => computeShipping(db, "tandil", dir));
      assert.equal(r1.error?.code, "zone", `fuera de zona es zone: ${r1.error?.code}`);
      assert.match(r1.error.message, /50 cuadras/);
      const llamadas = RED.urls.length;

      const r2 = await correr(t, () => computeShipping(db, "tandil", dir), { maxMs: 5000 });
      assert.equal(r2.error?.code, "zone", `desde caché sigue siendo zone: ${r2.error?.code}`);
      assert.equal(RED.urls.length, llamadas, "zone cacheado 90 s: no repite la red");

      await avanzar(t, 90 * 1000 + 1000);
      const r3 = await correr(t, () => computeShipping(db, "tandil", dir));
      assert.equal(r3.error?.code, "zone", `vencido el plazo se reintenta: ${r3.error?.code}`);
      assert.ok(RED.urls.length > llamadas, "pasados los 90 s vuelve a consultar");
    } finally {
      await close();
    }
  });

  it("los logs de falla no contienen la dirección ni datos del cliente", async (t) => {
    const { db, close } = await dbConTarifa("tandil");
    try {
      const { computeShipping } = await shippingAislado();
      armarRed(t, { db });
      RED.georef = "fail";
      RED.nominatim = "fail";
      RED.photon = "fail";
      const direccion = "Av. Secreta 1234 piso 2 depto B";

      const r = await correr(t, () => computeShipping(db, "tandil", direccion));
      assert.equal(r.error?.code, "transient", `cadena caída: ${r.error?.code}`);
      assert.ok(r.warnings.length > 0, "hubo al menos una línea de log");
      for (const w of r.warnings) {
        assert.ok(!w.includes("Secreta"), `el log no debe llevar la calle: ${w}`);
        assert.ok(!w.includes("1234"), `el log no debe llevar el número: ${w}`);
        assert.ok(!/\d{6,}/.test(w), `el log no debe llevar teléfonos/ids: ${w}`);
      }
    } finally {
      await close();
    }
  });

  it("costos y cuadras idénticos a los de siempre (0, 20, 21 y 20,5 cuadras)", async (t) => {
    // Regresión de la tarifa después de todo el trabajo de resiliencia: la
    // cadena externa no puede haber movido un peso ni una cuadra. Usa los
    // helpers de esta fase (metros por dirección) a propósito, así se comparan
    // los valores de la tarifa real, no los del mock de esta fase.
    const { db, close } = await dbConTarifa("tandil");
    try {
      mockearRed(t, {
        destinos: [
          { clave: "Recheck Local", lat: "-37.32154", metros: 0 },
          { clave: "Recheck Exacta 20", lat: "-37.32154", metros: 2600 },
          { clave: "Recheck Exacta 21", lat: "-37.32154", metros: 2730 },
          { clave: "Recheck Media 205", lat: "-37.32154", metros: 2665 },
        ],
      });
      // OJO con los nombres: el mock busca la dirección con includes, así que
      // ninguna puede ser prefijo de otra ("Recheck 20" encontraría primero la
      // dirección "Recheck 205" y devolvería 20 cuadras en el caso de la media
      // cuadra).
      assert.deepEqual(await cotizar(db, t, "tandil", "Recheck Local"), { cost: 4000, blocks: 0, supported: true });
      assert.deepEqual(await cotizar(db, t, "tandil", "Recheck Exacta 20"), { cost: 4000, blocks: 20, supported: true });
      assert.deepEqual(await cotizar(db, t, "tandil", "Recheck Exacta 21"), { cost: 4100, blocks: 21, supported: true });
      assert.deepEqual(await cotizar(db, t, "tandil", "Recheck Media 205"), { cost: 4100, blocks: 21, supported: true });
    } finally {
      await close();
    }
  });
});
