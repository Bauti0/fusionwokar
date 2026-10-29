import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldCacheQuoteError } from "../src/utils/shippingCache.js";

// El checkout cachea 10 min la cotización de una dirección (el servicio de mapas
// tiene cuota diaria). Cachear un fallo TRANSITORIO deja al cliente sin envío
// calculado durante 10 minutos por un saturón de 3 segundos; cachear un fallo
// DEFINITIVO (no lo encontramos / fuera de zona) no tiene ese problema, porque
// consultar de nuevo va a dar lo mismo.
//
// La decisión se toma por el `code` del ApiError (src/api.js lo arma con el
// `code` del body de POST /api/shipping/quote, server/index.js), nunca por el
// texto del mensaje. Estos tests fijan ese contrato de las dos puntas:
//   - qué código significa "definitivo" y cuál "reintentable",
//   - que un mensaje en español no cambia la decisión (ni para bien ni para mal).
describe("shouldCacheQuoteError (decisión pura por código)", () => {
  it("éxito → sí se cachea", () => {
    assert.equal(shouldCacheQuoteError(null), true);
    assert.equal(shouldCacheQuoteError(undefined), true);
  });

  it("transient → NO se cachea (el cliente tiene que poder reintentar)", () => {
    assert.equal(shouldCacheQuoteError({ code: "transient", status: 503 }), false);
  });

  it("unknown → sí se cachea (no la encontramos: reconsultar da lo mismo)", () => {
    assert.equal(shouldCacheQuoteError({ code: "unknown", status: 400 }), true);
  });

  it("zone → sí se cachea (fuera de zona: es definitivo)", () => {
    assert.equal(shouldCacheQuoteError({ code: "zone", status: 400 }), true);
  });

  it("red caída / timeout del fetch (status 0) → NO se cachea", () => {
    // Ni llegó al servidor: ni ApiError ni `code`. Es lo que devuelve el
    // fetch cuando no hay internet o cuando se aborta el request.
    assert.equal(shouldCacheQuoteError({ status: 0 }), false);
    assert.equal(shouldCacheQuoteError({}), false);
    assert.equal(shouldCacheQuoteError({ name: "TypeError" }), false);
  });

  it("5xx / 429 / 408 sin code → NO se cachea (fallo del servidor, reintentable)", () => {
    assert.equal(shouldCacheQuoteError({ status: 500 }), false);
    assert.equal(shouldCacheQuoteError({ status: 503 }), false);
    assert.equal(shouldCacheQuoteError({ status: 429 }), false);
    assert.equal(shouldCacheQuoteError({ status: 408 }), false);
  });

  it("4xx sin code conocido → sí se cachea (no es un fallo de transporte)", () => {
    // p.ej. "Falta la dirección" del propio endpoint: reintentar no cambia nada.
    assert.equal(shouldCacheQuoteError({ status: 400 }), true);
  });

  it("el mensaje NO decide: un mensaje de saturado con code definitivo se cachea igual", () => {
    // Si alguien reescribe el mensaje del server, la decisión no puede cambiar.
    assert.equal(
      shouldCacheQuoteError({ code: "unknown", message: "No pudimos consultar el mapa, está saturado" }),
      true
    );
    assert.equal(shouldCacheQuoteError({ code: "zone", message: "timeout de red" }), true);
    assert.equal(
      shouldCacheQuoteError({ code: "transient", message: "No pudimos ubicar esa dirección. Revisá calle y número." }),
      false
    );
  });

  it("las tres respuestas reales de POST /api/shipping/quote", () => {
    // Tal como las arma server/index.js hoy (status + code + mensaje): si el
    // backend cambia el status o el code, esta lista hay que actualizarla.
    const respuestasDelServer = [
      { status: 503, code: "transient", message: "No pudimos consultar el mapa. Volvé a intentar en unos segundos." },
      { status: 400, code: "unknown", message: "No pudimos ubicar esa dirección. Revisá calle y número." },
      {
        status: 400,
        code: "zone",
        message: "Esa dirección queda a 50 cuadras. Nuestro reparto cubre hasta 40 cuadras (~5 km).",
      },
    ];
    assert.deepEqual(
      respuestasDelServer.map(shouldCacheQuoteError),
      [false, true, true]
    );
  });
});
