import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeStatementDescriptor, buildOrderBody } from "../server/mp.js";

// ============================================================
// Tests del body de la order de Checkout Pro (Orders API).
//
// buildOrderBody es la función PURA que arma el JSON de POST /v1/orders:
// vive separada de createOrder (que hace fetch) para poder fijar acá,
// sin red ni credenciales, el contrato con la API de MP:
//   - total_amount como string,
//   - config.statement_descriptor dentro de config (hermano de online),
//   - payer solo cuando hay email (si viene payer, MP exige payer.email),
//   - backUrls y auto_return sin cambios de comportamiento.
// La referencia oficial: developers.mercadopago.com.ar → reference →
// online-payments → checkout-pro → Create order.
// ============================================================

const BACK_URLS = {
  success: "https://fusionwok.ar/?pago=aprobado",
  failure: "https://fusionwok.ar/?pago=rechazado",
  pending: "https://fusionwok.ar/?pago=pendiente",
};

describe("sanitizeStatementDescriptor", () => {
  it("usa FUSION WOK como fallback cuando no hay variable", () => {
    assert.equal(sanitizeStatementDescriptor(undefined), "FUSION WOK");
    assert.equal(sanitizeStatementDescriptor(""), "FUSION WOK");
    assert.equal(sanitizeStatementDescriptor("   "), "FUSION WOK");
  });

  it("deja pasar ASCII alfanumerico y espacio", () => {
    assert.equal(sanitizeStatementDescriptor("FUSION WOK"), "FUSION WOK");
    assert.equal(sanitizeStatementDescriptor("Wok 123"), "Wok 123");
  });

  it("elimina caracteres fuera de ASCII alfanumerico y espacio", () => {
    // La Ó con tilde y el guion no son ASCII alfanumérico ni espacio.
    assert.equal(sanitizeStatementDescriptor("Fusión-Wok!!"), "FusinWok");
  });

  it("colapsa espacios multiples dejando uno", () => {
    assert.equal(sanitizeStatementDescriptor("FUSION    WOK"), "FUSION WOK");
  });

  it("trunca a 13 caracteres: el limite documentado del resumen de tarjeta", () => {
    // Doc oficial (Configure invoice description): "up to 13 characters".
    assert.equal(sanitizeStatementDescriptor("FUSION WOK DEMASIADO LARGO"), "FUSION WOK DE");
    assert.equal(sanitizeStatementDescriptor("ABCDEFGHIJKLMN"), "ABCDEFGHIJKLM");
    assert.equal(sanitizeStatementDescriptor("ABCDEFGHIJKLM").length, 13);
  });

  it("si despues de limpiar queda vacio, cae al fallback", () => {
    assert.equal(sanitizeStatementDescriptor("---"), "FUSION WOK");
    assert.equal(sanitizeStatementDescriptor("!!"), "FUSION WOK");
  });

  it("tolera null sin tirar", () => {
    assert.equal(sanitizeStatementDescriptor(null), "FUSION WOK");
  });
});

describe("buildOrderBody", () => {
  it("total_amount va como string del monto entero", () => {
    const body = buildOrderBody({ orderNumber: "FW-00001", total: 15000, backUrls: BACK_URLS });
    assert.equal(body.total_amount, "15000");
  });

  it("total redondeado a entero aunque llegue con decimales", () => {
    const body = buildOrderBody({ orderNumber: "FW-00001", total: 15000.7, backUrls: BACK_URLS });
    assert.equal(body.total_amount, "15001");
  });

  it("no cambia el modo de procesamiento ni de captura del flujo actual", () => {
    const body = buildOrderBody({ orderNumber: "FW-00001", total: 15000, backUrls: BACK_URLS });
    assert.equal(body.type, "online");
    assert.equal(body.processing_mode, "manual");
    assert.equal(body.capture_mode, "automatic");
  });

  it("external_reference es el numero de pedido", () => {
    const body = buildOrderBody({ orderNumber: "FW-00042", total: 15000, backUrls: BACK_URLS });
    assert.equal(body.external_reference, "FW-00042");
  });

  it("statement_descriptor va dentro de config, hermano de online", () => {
    const body = buildOrderBody({ orderNumber: "FW-00001", total: 15000, backUrls: BACK_URLS });
    assert.equal(typeof body.config.statement_descriptor, "string");
    assert.ok(body.config.statement_descriptor.length > 0);
    assert.ok(body.config.statement_descriptor.length <= 13);
    assert.ok(body.config.online);
  });

  it("statement_descriptor sale de MP_STATEMENT_DESCRIPTOR cuando esta definida", () => {
    const previo = process.env.MP_STATEMENT_DESCRIPTOR;
    process.env.MP_STATEMENT_DESCRIPTOR = "WOK NQN";
    try {
      const body = buildOrderBody({ orderNumber: "FW-00001", total: 15000, backUrls: BACK_URLS });
      assert.equal(body.config.statement_descriptor, "WOK NQN");
    } finally {
      if (previo === undefined) delete process.env.MP_STATEMENT_DESCRIPTOR;
      else process.env.MP_STATEMENT_DESCRIPTOR = previo;
    }
  });

  it("las backUrls y el auto_return no cambian", () => {
    const body = buildOrderBody({ orderNumber: "FW-00001", total: 15000, backUrls: BACK_URLS });
    assert.equal(body.config.online.success_url, BACK_URLS.success);
    assert.equal(body.config.online.failure_url, BACK_URLS.failure);
    assert.equal(body.config.online.pending_url, BACK_URLS.pending);
    assert.equal(body.config.online.auto_return, "all");
  });

  it("sin email no manda payer (si viene payer, MP exige payer.email)", () => {
    const body = buildOrderBody({ orderNumber: "FW-00001", total: 15000, backUrls: BACK_URLS });
    assert.equal(body.payer, undefined);
  });

  it("con email manda payer.email al nivel del body", () => {
    const body = buildOrderBody({
      orderNumber: "FW-00001",
      total: 15000,
      backUrls: BACK_URLS,
      payer: { email: "cliente@testuser.com" },
    });
    assert.equal(body.payer.email, "cliente@testuser.com");
  });

  it("sin items manda el item unico de todo el pedido ( comportamiento actual)", () => {
    const body = buildOrderBody({
      orderNumber: "FW-00001",
      total: 15000,
      title: "Pedido Fusión Wok FW-00001",
      backUrls: BACK_URLS,
    });
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].unit_price, "15000");
    assert.equal(body.items[0].quantity, 1);
    assert.equal(body.items[0].title, "Pedido Fusión Wok FW-00001");
  });

  it("description cae al texto de pedido cuando no viene", () => {
    const body = buildOrderBody({ orderNumber: "FW-00007", total: 15000, backUrls: BACK_URLS });
    assert.equal(body.description, "Pedido Fusión Wok FW-00007");
  });
});
