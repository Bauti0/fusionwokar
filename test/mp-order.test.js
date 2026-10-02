import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeStatementDescriptor, buildOrderBody, toRegistrationDate } from "../server/mp.js";

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

  it("con firstName y lastName manda first_name/last_name en payer", () => {
    const body = buildOrderBody({
      orderNumber: "FW-00001",
      total: 15000,
      backUrls: BACK_URLS,
      payer: { email: "cliente@testuser.com", firstName: "Juan", lastName: "Perez" },
    });
    assert.equal(body.payer.first_name, "Juan");
    assert.equal(body.payer.last_name, "Perez");
    assert.equal(body.payer.email, "cliente@testuser.com");
  });

  it("sin firstName/lastName no manda esas claves (no manda vacios)", () => {
    const body = buildOrderBody({
      orderNumber: "FW-00001",
      total: 15000,
      backUrls: BACK_URLS,
      payer: { email: "cliente@testuser.com" },
    });
    assert.equal(body.payer.first_name, undefined);
    assert.equal(body.payer.last_name, undefined);
  });

  it("con identification manda {type, number} dentro de payer", () => {
    const body = buildOrderBody({
      orderNumber: "FW-00001",
      total: 15000,
      backUrls: BACK_URLS,
      payer: { email: "cliente@testuser.com", identification: { type: "DNI", number: "12345678" } },
    });
    assert.deepEqual(body.payer.identification, { type: "DNI", number: "12345678" });
  });

  it("identification a medias no viaja: si falta tipo o numero, no se manda", () => {
    const body = buildOrderBody({
      orderNumber: "FW-00001",
      total: 15000,
      backUrls: BACK_URLS,
      payer: { email: "cliente@testuser.com", identification: { type: "DNI" } },
    });
    assert.equal(body.payer.identification, undefined);
  });

  it("registrationDate viaja como additional_info con la clave plana de la doc", () => {
    // El ejemplo oficial de Create order usa claves planas:
    // "additional_info": { "payer.registration_date": "2020-01-15T00:00:00.000-03:00" }
    const body = buildOrderBody({
      orderNumber: "FW-00001",
      total: 15000,
      backUrls: BACK_URLS,
      additionalInfo: { registrationDate: "2025-12-01T00:00:00.000-03:00" },
    });
    assert.deepEqual(body.additional_info, { "payer.registration_date": "2025-12-01T00:00:00.000-03:00" });
  });

  it("sin additionalInfo no manda la clave", () => {
    const body = buildOrderBody({ orderNumber: "FW-00001", total: 15000, backUrls: BACK_URLS });
    assert.equal(body.additional_info, undefined);
  });
});

describe("toRegistrationDate", () => {
  it("formatea un instante UTC con offset -03:00 (Argentina no tiene DST)", () => {
    // 13:06:51.045Z en UTC → 10:06:51.045-03:00 en Buenos Aires.
    const iso = toRegistrationDate(new Date("2026-01-15T13:06:51.045Z"));
    assert.equal(iso, "2026-01-15T10:06:51.045-03:00");
  });

  it("el formato es el del ejemplo de la doc: milisegundos de 3 y offset", () => {
    const iso = toRegistrationDate(new Date("2020-01-15T03:00:00.000Z"));
    assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}-03:00$/);
  });

  it("acepta un string ISO (como sale de la base) sin redondear", () => {
    const iso = toRegistrationDate("2026-01-15T13:06:51.045Z");
    assert.equal(iso, "2026-01-15T10:06:51.045-03:00");
  });

  it("fecha invalida devuelve cadena vacia (se omite el campo)", () => {
    assert.equal(toRegistrationDate("no-una-fecha"), "");
    assert.equal(toRegistrationDate(null), "");
  });

  it("la medianoche UTC no se corre de dia", () => {
    // 00:00Z del 15 → 21:00 del 14 en Buenos Aires.
    assert.equal(toRegistrationDate("2026-01-15T00:00:00.000Z"), "2026-01-14T21:00:00.000-03:00");
  });
});
