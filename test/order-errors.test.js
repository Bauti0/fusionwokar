import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeOrderError } from "../src/utils/orderErrors.js";

const err = (code, message, pause = null) => ({
  code,
  message,
  pause,
});

describe("describeOrderError — mensaje de checkout según code del server", () => {
  // shipping_unavailable: no se pudo calcular envío (solo Tandil delivery).
  // canRetry=true: si el cliente corrige la dirección, puede volver a intentar.
  it("shipping_unavailable → message del server, canRetry=true, note de envío", () => {
    const out = describeOrderError(err("shipping_unavailable", "Dirección fuera de zona."));
    assert.equal(out.message, "Dirección fuera de zona.");
    assert.equal(out.canRetry, true);
    assert.equal(out.note, "Para cobrar con Mercado Pago necesitamos saber el costo de envío.");
  });

  // mp_unauthorized: credenciales de MP inválidas. El pedido YA quedó guardado.
  // canRetry=false: reintentar no sirve, la salida es WhatsApp con el número de pedido.
  it("mp_unauthorized → message fijo, canRetry=false, note de WhatsApp", () => {
    const out = describeOrderError(err("mp_unauthorized", "Invalid token"));
    assert.match(out.message, /Mercado Pago no está disponible/);
    assert.match(out.message, /pedido quedó registrado/);
    assert.equal(out.canRetry, false);
    assert.match(out.note, /problema es de nuestro lado/);
  });

  // mp_unavailable / mp_link_missing: MP caído o link no generado.
  // canRetry=true: el cliente puede reintentar el link.
  it("mp_unavailable → message fijo, canRetry=true", () => {
    const out = describeOrderError(err("mp_unavailable", "MP down"));
    assert.match(out.message, /No pudimos generar el link/);
    assert.match(out.message, /reintentar/);
    assert.equal(out.canRetry, true);
  });

  it("mp_link_missing → mismo comportamiento que mp_unavailable", () => {
    const out = describeOrderError(err("mp_link_missing", "No link"));
    assert.match(out.message, /No pudimos generar el link/);
    assert.equal(out.canRetry, true);
  });

  // orders_paused (423): sucursal pausada por el local. El pedido NO se creó.
  // canRetry=false: reintentar sin que el local reabra no sirve.
  // El message viene del server (incluye until/message). La note guía al menú.
  it("orders_paused → message del server, canRetry=false, note de volver al menú", () => {
    const pause = { paused: true, until: Date.now() + 3600000, message: "Volvemos a las 20:00" };
    const out = describeOrderError(err("orders_paused", "Sucursal pausada. Volvemos a las 20:00.", pause));
    assert.equal(out.message, "Sucursal pausada. Volvemos a las 20:00.");
    assert.equal(out.canRetry, false);
    assert.equal(out.note, "La sucursal está pausada. Podés volver al menú e intentar más tarde.");
  });

  // default: código desconocido → mensaje genérico, canRetry=true (seguro).
  it("código desconocido → mensaje genérico, canRetry=true", () => {
    const out = describeOrderError(err("unknown_code", "Algo falló"));
    assert.equal(out.message, "Algo falló");
    assert.equal(out.canRetry, true);
    assert.equal(out.note, undefined);
  });

  it("sin message → fallback genérico", () => {
    const out = describeOrderError(err("unknown_code", ""));
    assert.equal(out.message, "No se pudo iniciar el pago.");
    assert.equal(out.canRetry, true);
  });
});