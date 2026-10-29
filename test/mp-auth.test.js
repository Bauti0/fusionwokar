import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mpAuthError, MpError } from "../server/mp.js";

// ---------------------------------------------------------------------
// 2a: el MP_ACCESS_TOKEN de .env está revocado (MP responde
// PA_UNAUTHORIZED_RESULT_FROM_POLICIES). Cuando el arranque lo detecta, el
// resto de las operaciones de MP tienen que caer con ESE error y no volver
// a golpear la API: es el mismo error que devolvería Mercado Pago, pero sin
// gastar una request ni esperar los 15s de timeout.
//
// Por eso el error se fabrica en un solo lugar: si el checkout y la
// devolución fabricaran el error a mano, se desincronizarían (uno decía
// "no retry", el otro "reintentá") y el panel mostraría mensajes distintos
// para la misma causa.
// ---------------------------------------------------------------------

describe("error de credenciales de MP (2a)", () => {
  it("es un MpError, para que el caller lo distinga de una caída de red", () => {
    assert.ok(mpAuthError() instanceof MpError);
  });

  it("se marca como error de autenticación (401), no como caída transitoria", () => {
    const err = mpAuthError();
    assert.equal(err.isAuthError, true);
    assert.equal(err.status, 401);
  });

  it("no se reintenta: es un problema de configuración, no de la red", () => {
    assert.equal(mpAuthError().retryable, false);
  });

  it("el mensaje dice cuál es la causa y qué hay que hacer", () => {
    const msg = mpAuthError().message;
    assert.match(msg, /credenciales/i);
    assert.match(msg, /token/i);
  });

  it("el código es estable: el front lo puede usar sin parsear el texto", () => {
    assert.equal(mpAuthError().mpCode, "credentials_invalid");
  });
});
