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

// shipping.js espacia sus llamadas externas con un throttle global de
// ~1,2 s (sleeps reales). En vez de esperar esos segundos por cada
// caso, se mockea setTimeout y se avanza el reloj hasta que la
// promesa termina: el test queda instantáneo y determinista.
async function cotizar(t, branch, address) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
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
