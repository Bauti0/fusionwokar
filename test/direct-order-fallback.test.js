import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideDirectOrderOutcome } from "../src/utils/whatsapp.js";

const err = (status, message, pause = null) => ({
  status,
  message,
  pause,
});

describe("decideDirectOrderOutcome — decide qué pasa cuando POST /api/orders falla", () => {
  // 400: validación del server (producto no disponible, datos inválidos).
  // El pedido NO se creó. No abre WhatsApp, muestra mensaje exacto del server,
  // carrito intacto. kind "rejected".
  it("400 → rejected: no abre WhatsApp, mensaje del server, carrito intacto", () => {
    const out = decideDirectOrderOutcome(err(400, "Producto no disponible."));
    assert.equal(out.kind, "rejected");
    assert.equal(out.openWhatsApp, false);
    assert.equal(out.notRegistered, false);
    assert.equal(out.registerInHistory, false);
    assert.equal(out.message, "Producto no disponible.");
    assert.equal(out.note, "No registramos ningún pedido y tu carrito quedó como estaba.");
  });

  // 409: clave de idempotencia en conflicto (reintento con datos cambiados).
  // Igual que 400: pedido no creado, no abre WhatsApp.
  it("409 → rejected: idempotencia, mismo comportamiento que 400", () => {
    const out = decideDirectOrderOutcome(err(409, "Clave de idempotencia en conflicto."));
    assert.equal(out.kind, "rejected");
    assert.equal(out.openWhatsApp, false);
    assert.equal(out.notRegistered, false);
    assert.equal(out.registerInHistory, false);
    assert.equal(out.message, "Clave de idempotencia en conflicto.");
    assert.equal(out.note, "No registramos ningún pedido y tu carrito quedó como estaba.");
  });

  // 423: sucursal pausada por el local (orders_paused). El pedido NO se creó.
  // No abre WhatsApp. Muestra mensaje del server (incluye until/message) y note
  // para volver al menú. Propaga pause para que el checkout muestre cuándo vuelve.
  // kind "paused" (NUEVO).
  it("423 → paused: sucursal pausada, no abre WhatsApp, note para volver al menú, propaga pause", () => {
    const pause = { paused: true, until: Date.now() + 3600000, message: "Volvemos a las 20:00" };
    const out = decideDirectOrderOutcome(err(423, "Sucursal pausada. Volvemos a las 20:00.", pause));
    assert.equal(out.kind, "paused");
    assert.equal(out.openWhatsApp, false);
    assert.equal(out.notRegistered, false);
    assert.equal(out.registerInHistory, false);
    assert.equal(out.message, "Sucursal pausada. Volvemos a las 20:00.");
    assert.equal(out.note, "La sucursal está pausada. Podés volver al menú e intentar más tarde.");
    assert.deepEqual(out.pause, pause);
  });

  // 500: error del server. El pedido PUEDE haberse creado y la respuesta se perdió.
  // Abre WhatsApp con notRegistered=true. kind "unreachable".
  it("500 → unreachable: abre WhatsApp, notRegistered=true, mensaje 'puede haber quedado creado'", () => {
    const out = decideDirectOrderOutcome(err(500, "Error interno."));
    assert.equal(out.kind, "unreachable");
    assert.equal(out.openWhatsApp, true);
    assert.equal(out.notRegistered, true);
    assert.equal(out.registerInHistory, false);
    assert.match(out.message, /No pudimos confirmar que tu pedido se haya guardado/);
    assert.match(out.message, /[Ee]l servidor puede haberlo creado igual/);
    assert.equal(out.note, "");
  });

  // status 0: red caída / timeout. Igual que 500.
  it("status 0 (sin red) → unreachable: mismo comportamiento que 5xx", () => {
    const out = decideDirectOrderOutcome(err(0, "Network error"));
    assert.equal(out.kind, "unreachable");
    assert.equal(out.openWhatsApp, true);
    assert.equal(out.notRegistered, true);
    assert.equal(out.registerInHistory, false);
    assert.match(out.message, /No pudimos confirmar que tu pedido se haya guardado/);
  });

  // Error sin status numérico: se trata como 0 (red).
  it("error sin status → unreachable: trata status como 0", () => {
    const out = decideDirectOrderOutcome({ message: "Algo falló" });
    assert.equal(out.kind, "unreachable");
    assert.equal(out.openWhatsApp, true);
    assert.equal(out.notRegistered, true);
  });
});