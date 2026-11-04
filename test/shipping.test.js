import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------
// FASE A: tests de computeShipping (tarifa por cuadras de Tandil).
//
// Regla comercial que se caracteriza: hasta 20 cuadras $4.000 fijos;
// cada cuadra extra (entera o parcial) $100; con tope de cobertura
// (SHIPPING_MAX_BLOCKS) las direcciones más lejos se rechazan como
// fuera de zona; Necochea no tiene envío.
//
// El cálculo real consulta geocoders (Nominatim/Photon) y routers
// (OpenRouteService/OSRM). Acá la red se mockea POR COMPLETO: ningún
// test puede salir a internet (y si el módulo consultara una URL que
// el mock no conoce, revienta en vez de contestar de forma amable).
//
// IMPORTANTE: shipping.js captura sus constantes (franquicia, tarifa,
// tope, ORS_API_KEY) AL IMPORTAR el módulo, no en cada llamada. Por
// eso este archivo fija esas env vars ANTES del import dinámico de
// abajo: la suite no depende del entorno ni de ningún .env. Corolario:
// TODO el archivo corre con tope SHIPPING_MAX_BLOCKS=40, un valor lo
// suficientemente alto como para no interferir con los casos de tarifa
// (0, 20, 20,5 y 21 cuadras) y a la vez permitir probar el rechazo de
// "fuera de zona".
// ---------------------------------------------------------------------

process.env.ORS_API_KEY = ""; // sin key: el router consultado es OSRM (el que este test mockea)
process.env.SHIPPING_FLAT_BLOCKS = "20";
process.env.SHIPPING_BASE_COST = "4000";
process.env.SHIPPING_PER_BLOCK = "100";
process.env.SHIPPING_BLOCK_METERS = "130"; // la cuadra de Tandil
process.env.SHIPPING_MAX_BLOCKS = "40"; // tope ACTIVO para el caso "fuera de zona"

const { computeShipping } = await import("../server/shipping.js");

// Metros de RUTA que la "red" mockeada devuelve por dirección.
// OJO: cada test usa una dirección NUEVA, porque computeShipping cachea
// el resultado por dirección a nivel módulo (TTL de 7 días): repetir
// una dirección devolvería el resultado del test anterior.
const METROS_POR_DIRECCION = new Map();

// Contador de llamadas "externas" del mock: sirve para afirmar que un
// caso (Necochea) no consulta absolutamente nada.
let llamadasExternas = 0;

function respuestaJson(obj) {
  // Response mínima con la forma que usa shipping.js (res.ok + res.json()).
  return { ok: true, status: 200, json: async () => obj };
}

function mockearRed(t) {
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = String(url);
    llamadasExternas += 1;
    if (u.includes("nominatim")) {
      const q = new URL(u).searchParams.get("q") || "";
      // Origen (el local de Chacabuco 660): coordenadas fijas, cualquiera
      // sirve porque la distancia la fija el mock de OSRM.
      if (q.includes("Chacabuco 660")) return respuestaJson([{ lat: "-37.32154", lon: "-59.13024" }]);
      // Destino: se busca con startsWith porque shipping.js enriquece la
      // dirección con ", Tandil, Buenos Aires, Argentina" antes de
      // geocodificar. La "longitud" del destino son los METROS de ruta:
      // el único que la lee es el mock de OSRM (haversine nunca se
      // calcula, OSRM siempre responde), así que no hace falta que sean
      // coordenadas creíbles. Se usan metros ENTEROS para que el borde
      // exacto de 20 cuadras no dependa de redondeos de punto flotante.
      for (const [dir, metros] of METROS_POR_DIRECCION) {
        if (q.startsWith(dir)) return respuestaJson([{ lat: "-37.32154", lon: String(metros) }]);
      }
      throw new Error(`El mock no sabe geocodificar: ${q}`);
    }
    if (u.includes("project-osrm")) {
      // URL: /route/v1/driving/{fromLng},{fromLat};{toLng},{toLat}?...
      // El "toLng" del destino son los metros de ruta (ver arriba).
      const m = /;(-?[\d.]+),(-?[\d.]+)\?/.exec(u);
      const metros = m ? Number(m[1]) : NaN;
      if (!Number.isFinite(metros)) throw new Error(`URL de OSRM que el mock no entiende: ${u}`);
      // Una ruta de 0 m hace fallar al OSRM real y el módulo caería a la
      // distancia en línea recta; para el caso "dirección del propio
      // local" se devuelven 1 m, que igual redondean a 0 cuadras.
      return respuestaJson({ routes: [{ distance: Math.max(metros, 1) }] });
    }
    throw new Error(`El mock no sabe responder esta URL: ${u}`);
  });
}

// Un solo juego de timers falsos por test. `enable()` dos veces sobre el mismo
// contexto tira ERR_INVALID_STATE, así que una función que corre más de una
// cotización dentro del mismo test (o que se llama desde dos helpers) moría con
// un error que parecía ser el del código de producción.
const relojesActivados = new WeakSet();
function activarReloj(t, apis = ["setTimeout", "Date"]) {
  if (relojesActivados.has(t)) return;
  relojesActivados.add(t);
  t.mock.timers.enable({ apis });
}

// shipping.js espacia sus llamadas externas con un throttle global de
// ~1,2 s (sleeps reales). En vez de esperar esos segundos por cada
// caso, se mockea setTimeout y se avanza el reloj hasta que la
// promesa termina: el test queda instantáneo y determinista.
async function cotizar(t, branch, address) {
  activarReloj(t, ["setTimeout"]);
  const promesa = computeShipping(branch, address);
  let termino = false;
  promesa.then(
    () => {
      termino = true;
    },
    () => {
      termino = true;
    }
  );
  for (let i = 0; !termino && i < 50; i++) {
    t.mock.timers.tick(1300); // un poco más que el espaciado (1.200 ms)
    // Dejar correr microtareas y el fetch mockeado (responde al instante,
    // sin I/O real). setImmediate queda sin mockear a propósito.
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
    mockearRed(t);
    METROS_POR_DIRECCION.set("Rodríguez 50", 0);
    const r = await cotizar(t, "tandil", "Rodríguez 50");
    assert.deepEqual(r, { cost: 4000, blocks: 0, supported: true });
  });

  it("justo 20 cuadras entra en la franquicia: $4.000 (borde exacto)", async (t) => {
    // Regresión que cubre: el borde `exact <= FLAT_BLOCKS`. Con un `<=`
    // cambiado por `<` (o con un redondeo mal puesto), la cuadra 20
    // empezaría a cobrarse como extra y todos los envíos del límite
    // subirían $100 de la nada.
    mockearRed(t);
    METROS_POR_DIRECCION.set("Rodríguez 200", 2600); // 2600 m / 130 m = 20 cuadras exactas
    const r = await cotizar(t, "tandil", "Rodríguez 200");
    assert.deepEqual(r, { cost: 4000, blocks: 20, supported: true });
  });

  it("21 cuadras: la primera extra suma $100 → $4.100", async (t) => {
    // Regresión que cubre: la primera cuadra fuera de la franquicia
    // cobra como extra. Es el caso que más se toca al ajustar la
    // tarifa; estos números son los que el cliente ve en el checkout.
    mockearRed(t);
    METROS_POR_DIRECCION.set("Rodríguez 210", 2730); // 21 cuadras exactas
    const r = await cotizar(t, "tandil", "Rodríguez 210");
    assert.deepEqual(r, { cost: 4100, blocks: 21, supported: true });
  });

  it("media cuadra extra cobra como cuadra entera: 20,5 cuadras → $4.100 y blocks 21", async (t) => {
    // Regresión que cubre: el redondeo es Math.ceil para el extra (la
    // cuadra PARCIAL paga como entera). Con Math.round, esta dirección
    // daría $4.000 y el reparto perdería $100 en cada borde.
    mockearRed(t);
    METROS_POR_DIRECCION.set("Maipú 310", 2665); // 2665 m / 130 m = 20,5 cuadras
    const r = await cotizar(t, "tandil", "Maipú 310");
    assert.deepEqual(r, { cost: 4100, blocks: 21, supported: true });
  });

  it("más allá del tope (SHIPPING_MAX_BLOCKS=40) se rechaza como fuera de zona", async (t) => {
    // Regresión que cubre: el tope de reparto existe para que nadie
    // pida a 50 cuadras "con envío barato": sin el rechazo, el pedido
    // pasaría igual y saldría a repartir a cualquier distancia.
    // El código de error ("zone") es lo que hace que el endpoint
    // devuelva 400 definitivo en vez de 503 reintentable.
    mockearRed(t);
    METROS_POR_DIRECCION.set("Alem 4200", 6500); // 50 cuadras > tope de 40
    await assert.rejects(
      cotizar(t, "tandil", "Alem 4200"),
      (err) => {
        assert.equal(err.code, "zone");
        assert.match(err.message, /50 cuadras/);
        assert.match(err.message, /hasta 40 cuadras/);
        return true;
      }
    );
  });

  it("Necochea no tiene envío: supported false, sin consultar nada", async (t) => {
    // Regresión que cubre: Necochea todavía no tiene reparto. Si se
    // "arregla" el cálculo para cotizar cualquier sucursal, el checkout
    // de Necochea ofrecería un envío que nadie puede entregar. Además,
    // este caso no puede tocar la red: se afirma con el contador.
    mockearRed(t);
    const antes = llamadasExternas;
    const r = await computeShipping("necochea", "Av. 59 1234");
    assert.deepEqual(r, { cost: 0, blocks: 0, supported: false });
    assert.equal(llamadasExternas, antes); // no hizo ninguna llamada externa
  });
});

// =====================================================================
// FASE B: resiliencia de la cadena externa (timeouts, 403, 429,
// suspensiones, techo global y caché negativo). RED 100% MOCKEADA.
//
// Estas pruebas controlan cada provider (nominatim / photon / OSRM) por
// COMPORTAMIENTO (ok, 403, 429, timeout, caída) y advanced el reloj falso para
// no esperar los sleeps reales (throttle, backoff, Retry-After, deadline). No
// tocan la fórmula de costos ni las tarifas: al final se re-verifican los
// valores de la Fase A.
//
// Dos detalles del harness que hacen que esto sea determinista:
//
// 1) Cada test importa una INSTANCIA NUEVA de server/shipping.js. Las
//    suspensiones de provider, la cola de espaciado entre llamadas y los cachés
//    (por dirección, negativos) viven a nivel de módulo. Con un reloj falso que
//    arranca en 0, una suspensión de 10 min simulados que dejó un test anterior
//    seguiría vigente para todos los que vinieran después. Node trata cada query
//    distinta como un módulo distinto, así que el estado limpio se consigue SIN
//    tocar una línea de producción (ni exponer un reset para tests).
//
// 2) El reloj falso mockea `Date` además de `setTimeout`: las suspensiones
//    (~10 min), el techo global (~12 s) y los TTL de las cachés negativas se
//    miden con `Date.now()`. Con `Date` real, avanzar el reloj no los vencía y
//    los tests affirmaban sobre tiempos que nunca habían pasado.
// =====================================================================

let instanciasShipping = 0;
async function shippingAislado() {
  instanciasShipping += 1;
  return import(`../server/shipping.js?instancia=${instanciasShipping}`);
}

// ---- Red mockeada ------------------------------------------------------
// Geocoders: el origen (Chacabuco 660) siempre devuelve ORIGEN_MOCK; el destino
// devuelve RED.destino. OSRM no ve la dirección (solo coordenadas), así que
// responde con `factorRuta × distancia en línea recta` entre lo que le pasaron:
// con factorRuta=1 la ruta es casi la línea recta, y como el fallback de
// shipping.js multiplica la línea recta por 1,25, los dos caminos dan números
// DISTINTOS. Un test puede afirmar cuál se usó.
const ORIGEN_MOCK = { lat: "-37.32154", lon: "-59.13024" };
// ~2.78 km al sur del local: OSRM sano → 2.780 m = 21,4 cuadras ($4.200);
// con el fallback haversine → 3.475 m = 26,7 cuadras ($4.700).
const DESTINO_MOCK = { lat: "-37.34654", lon: "-59.13024" };
// ~6.5 km al sur del local: 50 cuadras, más allá del tope de 40 (fuera de zona).
const DESTINO_LEJANO = { lat: "-37.38000", lon: "-59.13024" };

function redPorDefecto() {
  return {
    // Modo por proveedor: "ok" | "403" | "429" | "timeout" | "fail"
    nominatim: "ok",
    photon: "ok",
    osrm: "ok",
    // Modo forzado para certain consultas (p.ej. "solo el destino da 429").
    modoPorConsulta: {},
    origen: ORIGEN_MOCK,
    destino: DESTINO_MOCK,
    factorRuta: 1,
    // Consultas cuyo texto figure acá devuelven respuesta válida SIN
    // resultados: no es una falla, es "no encontramos esa dirección".
    sinResultado: [],
    // Demora (ms del reloj falso) por proveedor y por texto de consulta.
    demora: { nominatim: 0, photon: 0, osrm: 0 },
    demoraPorConsulta: {},
    // Segundos del header Retry-After en el 429 (null = no se manda el header).
    retryAfter: null,
    urls: [],
  };
}
let RED = redPorDefecto();

// Sleep que avanza el reloj falso: el mock del provider tarda lo que diga RED
// (así se simula latencia real sin esperar nada de verdad).
function dormirEnRelojFalso(ms) {
  return new Promise((listo) => setTimeout(listo, ms));
}

// respuestaJson() ya lo define la Fase A más arriba: se reutiliza.

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
  return null;
}

function consultaDe(u, host) {
  if (host === "osrm" || host === "ors") return "";
  return new URL(u).searchParams.get("q") || "";
}

// Primer valor de la tabla cuya clave aparece en el texto de la consulta.
function valorParaConsulta(tabla, q) {
  for (const clave of Object.keys(tabla)) {
    if (q.toLowerCase().includes(clave.toLowerCase())) return tabla[clave];
  }
  return undefined;
}

// Misma fórmula que shipping.js: el mock no "adivina" distancias, las calcula
// con las coordenadas que le pasaron, igual que haría el servicio real.
function distanciaLineaRectaKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function fetchMockeado(url) {
  const u = String(url);
  RED.urls.push(u);
  const host = hostDe(u);
  if (host === null) throw new Error(`El mock no sabe responder esta URL: ${u}`);
  // Sin ORS_API_KEY nunca se consulta; si alguien la setea, el test falla fuerte
  // en vez de salir a internet.
  if (host === "ors") throw new Error(`El mock no debe consultar ORS: ${u}`);

  const q = consultaDe(u, host);
  const modo = valorParaConsulta(RED.modoPorConsulta, q) ?? RED[host];
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

  const ql = q.toLowerCase();
  if (RED.sinResultado.some((s) => ql.includes(String(s).toLowerCase()))) {
    return sinResultados(host);
  }

  if (host === "osrm") {
    // /route/v1/driving/{lng},{lat};{lng},{lat}?overview=false...
    const m = /(-?[\d.]+),(-?[\d.]+);(-?[\d.]+),(-?[\d.]+)/.exec(u);
    if (!m) throw new Error(`URL de OSRM que el mock no entiende: ${u}`);
    const from = { lat: Number(m[2]), lng: Number(m[1]) };
    const to = { lat: Number(m[4]), lng: Number(m[3]) };
    const km = distanciaLineaRectaKm(from, to) * RED.factorRuta;
    return respuestaJson({ routes: [{ distance: Math.max(1, Math.round(km * 1000)) }] });
  }
  if (host === "photon") {
    // El origen se responde con SUS coordenadas también en photon: si el
    // mock devolviera el destino para "Chacabuco 660", la distancia sería 0 y
    // las cuotas saldrían como si el cliente viviera adentro del local.
    const coords = q.includes("Chacabuco 660") ? RED.origen : RED.destino;
    return respuestaJson({
      features: [{ geometry: { coordinates: [Number(coords.lon), Number(coords.lat)] } }],
    });
  }
  if (q.includes("Chacabuco 660")) return respuestaJson([RED.origen]);
  return respuestaJson([RED.destino]);
}

// Los console.warn del módulo se capturan en un array por test: se puede
// afirmar qué se logueó (y, sobre todo, qué NO).
const WARNINGS = [];

function armarRed(t) {
  RED = redPorDefecto();
  activarReloj(t);
  WARNINGS.length = 0;
  t.mock.method(console, "warn", (...args) => WARNINGS.push(args.join(" ")));
  t.mock.method(globalThis, "fetch", fetchMockeado);
}

// Corre una operación contra el módulo con el reloj falso y devuelve valor,
// error, warnings y cuánto tiempo de reloj consumió. NO tira: cada test afirma
// sobre error?.code, así que un throw inesperado se ve como code undefined y
// no se confunde con el error que el test provocó a propósito.
async function correr(t, fn, { maxMs = 30000, paso = 100 } = {}) {
  const inicio = Date.now();
  let valor = null;
  let error = null;
  let termino = false;
  Promise.resolve()
    .then(fn)
    .then(
      (v) => {
        valor = v;
        termino = true;
      },
      (e) => {
        error = e;
        termino = true;
      }
    );
  for (let elapsed = 0; !termino && elapsed < maxMs; elapsed += paso) {
    t.mock.timers.tick(paso);
    // setImmediate sin mockear a propósito: es lo que deja correr microtareas
    // y el await del fetch mockeado entre un tick y el siguiente.
    await new Promise((listo) => setImmediate(listo));
  }
  if (!termino) throw new Error(`la operación no terminó tras ${maxMs} ms simulados`);
  return { valor, error, warnings: [...WARNINGS], transcurrido: Date.now() - inicio };
}

// Adelanta el reloj falso entre dos fases del mismo test (vencer una
// suspensión, un TTL de caché negativa...).
async function avanzar(t, ms) {
  t.mock.timers.tick(ms);
  await new Promise((listo) => setImmediate(listo));
}

function llamadasDesde(indice, host) {
  return RED.urls.slice(indice).filter((u) => u.includes(host)).length;
}

describe("resiliencia de la cadena externa (red mockeada, relojes falsos)", () => {
  it("403 de Nominatim: loguea el status sin la dirección, suspende el provider ~10 min y después lo reactiva", async (t) => {
    const { computeShipping } = await shippingAislado();
    armarRed(t);
    RED.nominatim = "403";

    // 1) La cotización sale igual (Photon de respaldo), pero Nominatim queda
    //    suspendido y el log dice qué pasó SIN la dirección del cliente.
    const r1 = await correr(t, () => computeShipping("tandil", "Uruguay 1200"));
    assert.equal(r1.error, null, `no debe fallar la cotización: ${r1.error?.message}`);
    assert.deepEqual(r1.valor, { cost: 4200, blocks: 22, supported: true });
    assert.ok(
      r1.warnings.some((w) => w.includes("nominatim") && w.includes("403")),
      "loguea una línea con el provider y el status 403"
    );
    for (const w of r1.warnings) {
      assert.ok(!w.includes("Uruguay"), `el log no debe llevar la dirección: ${w}`);
    }

    // 2) Mientras está suspendido no se vuelve a llamar, ni una sola vez, y la
    //    cotización se resuelve con Photon.
    let marca = RED.urls.length;
    const r2 = await correr(t, () => computeShipping("tandil", "Uruguay 1300"));
    assert.equal(r2.error, null, `el respaldo tiene que cotizar: ${r2.error?.message}`);
    assert.deepEqual(r2.valor, { cost: 4200, blocks: 22, supported: true });
    assert.equal(llamadasDesde(marca, "nominatim"), 0, "no consulta nominatim suspendido");
    assert.ok(llamadasDesde(marca, "photon") > 0, "usa el provider de respaldo (photon)");

    // 3) Pasados los ~10 min la suspensión se libera y Nominatim vuelve.
    await avanzar(t, 10 * 60 * 1000 + 1000);
    RED.nominatim = "ok";
    marca = RED.urls.length;
    const r3 = await correr(t, () => computeShipping("tandil", "Uruguay 1400"));
    assert.equal(r3.error, null, `tras la suspensión vuelve a cotizar: ${r3.error?.message}`);
    assert.ok(llamadasDesde(marca, "nominatim") > 0, "nominatim se reactiva después de ~10 min");
  });

  it("timeout de Nominatim: NO suspende el provider (la cotización siguiente lo vuelve a consultar)", async (t) => {
    const { computeShipping } = await shippingAislado();
    armarRed(t);
    RED.nominatim = "timeout";

    const r1 = await correr(t, () => computeShipping("tandil", "Italia 2100"));
    assert.equal(r1.error, null, `photon de respaldo: ${r1.error?.message}`);
    assert.deepEqual(r1.valor, { cost: 4200, blocks: 22, supported: true });
    assert.ok(
      r1.warnings.some((w) => w.includes("nominatim") && w.includes("timeout")),
      "loguea el timeout del provider"
    );
    assert.ok(r1.transcurrido < 12000, `un timeout no cuesta la suspensión de 10 min: ${r1.transcurrido} ms`);

    // Si el timeout suspendiera al provider (como sí hace un 403), la segunda
    // cotización no volvería a tocarlo.
    const marca = RED.urls.length;
    const r2 = await correr(t, () => computeShipping("tandil", "Italia 2200"));
    assert.equal(r2.error, null, `la segunda también cotiza: ${r2.error?.message}`);
    assert.ok(llamadasDesde(marca, "nominatim") >= 1, "un timeout no suspende: se reintenta");
  });

  it("429 con Retry-After: respeta la espera del header y no suspende al provider", async (t) => {
    const { computeShipping } = await shippingAislado();
    armarRed(t);
    RED.nominatim = "429";
    RED.retryAfter = 3; // segundos
    // Solo el destino recibe el 429: así la espera medida es la del Retry-After
    // y no la suma de dos consultas (la del origen va por el override "ok").
    RED.modoPorConsulta = { "Chacabuco 660": "ok" };

    const r1 = await correr(t, () => computeShipping("tandil", "San Martín 1500"));
    assert.equal(r1.error, null, `con Retry-After la cotización sale: ${r1.error?.message}`);
    assert.deepEqual(r1.valor, { cost: 4200, blocks: 22, supported: true });
    assert.ok(
      r1.warnings.some((w) => w.includes("nominatim") && w.includes("429")),
      "loguea el 429 con su status"
    );
    assert.ok(r1.transcurrido >= 3000, `esperó el Retry-After: ${r1.transcurrido} ms`);

    // Un 429 con Retry-After es una pausa, NO una suspensión de 10 minutos.
    const marca = RED.urls.length;
    const r2 = await correr(t, () => computeShipping("tandil", "San Martín 1600"));
    assert.equal(r2.error, null, `vuelve a cotizar: ${r2.error?.message}`);
    assert.ok(llamadasDesde(marca, "nominatim") >= 1, "no queda suspendido por un 429 aislado");
  });

  it("429 con Retry-After enorme: la espera se topa (no se cuelga ni quema el techo de 12 s)", async (t) => {
    const { computeShipping } = await shippingAislado();
    armarRed(t);
    RED.nominatim = "429";
    RED.retryAfter = 30; // 30 s: sin tope quemaría el techo global de 12 s
    RED.modoPorConsulta = { "Chacabuco 660": "ok" };

    const r1 = await correr(t, () => computeShipping("tandil", "Bolívar 1700"));
    assert.equal(r1.error, null, `con el tope la cotización sale: ${r1.error?.message}`);
    assert.deepEqual(r1.valor, { cost: 4200, blocks: 22, supported: true });
    assert.ok(r1.transcurrido >= 5000, `esperó el tope de 5 s: ${r1.transcurrido} ms`);
    assert.ok(
      r1.transcurrido < 12000,
      `sin tope habría esperado 30 s y el techo global la cortado: ${r1.transcurrido} ms`
    );
  });

  it("Photon responde mientras Nominatim está suspendido: la cotización funciona", async (t) => {
    const { computeShipping } = await shippingAislado();
    armarRed(t);
    RED.nominatim = "403";
    // La primera cotización deja a Nominatim suspendido.
    await correr(t, () => computeShipping("tandil", "Urquiza 1800"));

    // La segunda tiene que salir igual, sin tocar Nominatim.
    const marca = RED.urls.length;
    const r = await correr(t, () => computeShipping("tandil", "Urquiza 1900"));
    assert.equal(r.error, null, `con photon la cotización sale: ${r.error?.message}`);
    assert.deepEqual(r.valor, { cost: 4200, blocks: 22, supported: true });
    assert.equal(llamadasDesde(marca, "nominatim"), 0, "photon respondió sin esperar a nominatim");
    assert.ok(llamadasDesde(marca, "photon") > 0, "photon es quien geocodifica");
  });

  it("techo global ~12 s: una cadena sana pero lenta termina en transient, no en una cotización", async (t) => {
    const { computeShipping } = await shippingAislado();
    armarRed(t);
    // Todos los providers responden bien: lo único que se rompe es el tiempo.
    // El origen tarda 13 s, más que el techo, así que la cotización no se
    // entrega (si no existiera el techo, el cliente esperaría los 13 s + la
    // consulta al router y se le cobraría una tarifa calculada sobre datos rancios).
    RED.demoraPorConsulta = { "Chacabuco 660": 13000 };

    const r = await correr(t, () => computeShipping("tandil", "Lenta 1900"), { maxMs: 40000 });
    assert.equal(r.error?.code, "transient", `debe cortar por el techo global: ${r.error?.code}`);
    assert.ok(
      r.transcurrido >= 13000 && r.transcurrido < 20000,
      `corta tras una sola consulta externa (1,2 s de espaciado + 13 s del proveedor): ${r.transcurrido} ms`
    );
  });

  it("el techo global NO dispara con demoras cortas: la misma cadena sana cotiza", async (t) => {
    // Contracara del caso anterior: si el techo se disparara siempre que hay
    // cualquier demora, las horas pico (servicios gratuitos lentos) dejarían de
    // cotizar y todo el checkout de Tandil caería en "envío a confirmar".
    const { computeShipping } = await shippingAislado();
    armarRed(t);
    RED.demora = { nominatim: 2000, photon: 2000, osrm: 2000 };

    const r = await correr(t, () => computeShipping("tandil", "Corta 2000"));
    assert.equal(r.error, null, `una cadena lenta pero viable cotiza: ${r.error?.message}`);
    assert.deepEqual(r.valor, { cost: 4200, blocks: 22, supported: true });
    assert.ok(r.transcurrido < 12000, `no debe acercarse al techo: ${r.transcurrido} ms`);
  });

  it("OSRM caído: la ruta cae al fallback haversine y la cotización sigue saliendo", async (t) => {
    const { computeShipping } = await shippingAislado();
    armarRed(t);
    RED.osrm = "timeout";

    // Con OSRM sano el destino da 2.780 m (21,4 cuadras → $4.200). El fallback
    // haversine de shipping.js multiplica la línea recta por 1,25 → 3.475 m
    // (26,7 cuadras → $4.700). Los números son distintos, así que este assert
    // no puede estar saliendo de OSRM.
    const r1 = await correr(t, () => computeShipping("tandil", "Brown 2300"));
    assert.equal(r1.error, null, `el fallback tiene que cotizar: ${r1.error?.message}`);
    assert.deepEqual(r1.valor, { cost: 4700, blocks: 27, supported: true });
    assert.ok(
      r1.warnings.some((w) => w.includes("osrm")),
      "loguea la falla del router"
    );

    // Contracara: con OSRM sano la MISMA distancia da $4.200 (o sea, los $4.700
    // de arriba salieron del haversine y no de una ruta que se|coló).
    RED.osrm = "ok";
    const r2 = await correr(t, () => computeShipping("tandil", "Brown 2400"));
    assert.equal(r2.error, null, `con OSRM sano cotiza: ${r2.error?.message}`);
    assert.deepEqual(r2.valor, { cost: 4200, blocks: 22, supported: true });
  });

  it("caché negativo de transient: 15 s sin repetir llamadas externas; después vuelve a consultar", async (t) => {
    const { computeShipping } = await shippingAislado();
    armarRed(t);
    RED.nominatim = "fail";
    RED.photon = "fail";
    const dir = "Falla 2400";

    const r1 = await correr(t, () => computeShipping("tandil", dir));
    assert.equal(r1.error?.code, "transient", `ante la cadena caída es transient: ${r1.error?.code}`);
    const llamadas = RED.urls.length;

    // Inmediatamente después: la caché negativa corta la martilla. Si no
    // existiera, el cliente reintentando cada 2 s le pegaría 4 golpes por
    // intento a dos servicios gratuitos (y por eso el TTL corto de 15 s).
    const r2 = await correr(t, () => computeShipping("tandil", dir), { maxMs: 5000 });
    assert.equal(r2.error?.code, "transient", `sigue siendo transient: ${r2.error?.code}`);
    assert.equal(RED.urls.length, llamadas, "dentro de los 15 s no vuelve a golpear la red");

    // Vencido el TTL corto, se vuelve a intentar (el cliente que reintenta
    // recupera la cotización solo).
    await avanzar(t, 15000 + 500);
    const r3 = await correr(t, () => computeShipping("tandil", dir));
    assert.equal(r3.error?.code, "transient", `sigue sin salida: ${r3.error?.code}`);
    assert.ok(RED.urls.length > llamadas, "pasados los 15 s vuelve a consultar");
  });

  it("unknown se cachea 90 s (no se re-consulta la red dentro de ese lapso)", async (t) => {
    const { computeShipping } = await shippingAislado();
    armarRed(t);
    // Los dos geocoders responden "no encontré esta dirección": no es una
    // falla de la cadena, así que el plazo es el largo de siempre (90 s).
    RED.sinResultado = ["Sin Coordenadas"];
    const dir = "Sin Coordenadas 2500";

    const r1 = await correr(t, () => computeShipping("tandil", dir));
    assert.equal(r1.error?.code, "unknown", `no encontrada es unknown: ${r1.error?.code}`);
    const llamadas = RED.urls.length;

    const r2 = await correr(t, () => computeShipping("tandil", dir), { maxMs: 5000 });
    assert.equal(r2.error?.code, "unknown", `desde caché sigue siendo unknown: ${r2.error?.code}`);
    assert.equal(RED.urls.length, llamadas, "unknown cacheado 90 s: no repite la red");

    await avanzar(t, 90 * 1000 + 1000);
    const r3 = await correr(t, () => computeShipping("tandil", dir));
    assert.equal(r3.error?.code, "unknown", `vencido el plazo se reintenta: ${r3.error?.code}`);
    assert.ok(RED.urls.length > llamadas, "pasados los 90 s vuelve a consultar");
  });

  it("zone se cachea 90 s (mismo plazo que unknown)", async (t) => {
    const { computeShipping } = await shippingAislado();
    armarRed(t);
    // ~6,5 km al sur del local = 50 cuadras, más allá del tope de 40.
    RED.destino = DESTINO_LEJANO;
    const dir = "Lejana 2600";

    const r1 = await correr(t, () => computeShipping("tandil", dir));
    assert.equal(r1.error?.code, "zone", `fuera de zona es zone: ${r1.error?.code}`);
    assert.match(r1.error.message, /50 cuadras/);
    const llamadas = RED.urls.length;

    const r2 = await correr(t, () => computeShipping("tandil", dir), { maxMs: 5000 });
    assert.equal(r2.error?.code, "zone", `desde caché sigue siendo zone: ${r2.error?.code}`);
    assert.equal(RED.urls.length, llamadas, "zone cacheado 90 s: no repite la red");

    await avanzar(t, 90 * 1000 + 1000);
    const r3 = await correr(t, () => computeShipping("tandil", dir));
    assert.equal(r3.error?.code, "zone", `vencido el plazo se reintenta: ${r3.error?.code}`);
    assert.ok(RED.urls.length > llamadas, "pasados los 90 s vuelve a consultar");
  });

  it("los logs de falla no contienen la dirección ni datos del cliente", async (t) => {
    const { computeShipping } = await shippingAislado();
    armarRed(t);
    RED.nominatim = "fail";
    RED.photon = "fail";
    const direccion = "Av. Secreta 1234 piso 2 depto B";

    const r = await correr(t, () => computeShipping("tandil", direccion));
    assert.equal(r.error?.code, "transient", `cadena caída: ${r.error?.code}`);
    // Si no se capturó ninguna línea, los asserts siguientes pasarían de vacío.
    assert.ok(r.warnings.length > 0, "hubo al menos una línea de log");
    for (const w of r.warnings) {
      assert.ok(!w.includes("Secreta"), `el log no debe llevar la calle: ${w}`);
      assert.ok(!w.includes("1234"), `el log no debe llevar el número: ${w}`);
      assert.ok(!/\d{6,}/.test(w), `el log no debe llevar teléfonos/ids: ${w}`);
    }
  });

  it("costos y cuadras idénticos a los de siempre (0, 20, 21 y 20,5 cuadras)", async (t) => {
    // Regresión de la tarifa después de todo el trabajo de resiliencia: la
    // cadena externa no puede haber movido un peso ni una cuadra. Usa los
    // helpers de la Fase A (metros por dirección) a propósito, así se comparan
    // los valores de la tarifa real, no los del mock de esta fase.
    mockearRed(t); // el mock de la Fase A define metros por dirección
    // OJO con los nombres: el mock de la Fase A busca la dirección con
    // startsWith, así que ninguna puede ser prefijo de otra ("Recheck 20"
    // encontraría primero la dirección "Recheck 205" y devolvería 20 cuadras
    // en el caso de la media cuadra).
    METROS_POR_DIRECCION.set("Recheck Local", 0);
    METROS_POR_DIRECCION.set("Recheck Exacta 20", 2600);
    METROS_POR_DIRECCION.set("Recheck Exacta 21", 2730);
    METROS_POR_DIRECCION.set("Recheck Media 205", 2665);
    assert.deepEqual(await cotizar(t, "tandil", "Recheck Local"), { cost: 4000, blocks: 0, supported: true });
    assert.deepEqual(await cotizar(t, "tandil", "Recheck Exacta 20"), { cost: 4000, blocks: 20, supported: true });
    assert.deepEqual(await cotizar(t, "tandil", "Recheck Exacta 21"), { cost: 4100, blocks: 21, supported: true });
    assert.deepEqual(await cotizar(t, "tandil", "Recheck Media 205"), { cost: 4100, blocks: 21, supported: true });
  });
});
