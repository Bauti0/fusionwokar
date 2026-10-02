import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeStatementDescriptor, buildOrderBody, toRegistrationDate, buildOrderItems } from "../server/mp.js";

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

// ============================================================
// buildOrderItems: mapea los ítems REALES del carrito (los cleanItems que
// guarda validateOrderBody) al array items de la order de MP.
//
// La regla dura de la API (probada y documentada): total_amount TIENE que
// ser igual a la suma de unit_price × quantity de TODOS los ítems. Si el
// total trae envío o descuento, la suma se cuadra con el ítem "Envío" y
// repartiendo el descuento en los unit_price (MP RECHAZA precios
// negativos: probado contra la API de prueba → 400 invalid_items).
// Si la suma exacta no se puede construir, devuelve null y el caller manda
// el ítem único de siempre: nunca sale una order inconsistente.
// ============================================================
describe("buildOrderItems", () => {
  const PRODUCTO = (nombre, precio, qty = 1, extras = []) => ({
    key: `${nombre}-1`,
    productId: "wok-pollo",
    name: nombre,
    unitPrice: precio,
    extras,
    notes: "",
    qty,
  });

  it("sin descuento ni envio: manda los items reales con su precio y cantidad", () => {
    const items = buildOrderItems({
      items: [PRODUCTO("Wok de pollo", 8000, 1), PRODUCTO("Spring rolls", 4000, 2)],
      total: 16000,
      discount: 0,
      shippingCost: 0,
    });
    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map((i) => [i.title, i.unit_price, i.quantity]),
      [
        ["Wok de pollo", "8000", 1],
        ["Spring rolls", "4000", 2],
      ]
    );
    const suma = items.reduce((s, i) => s + Number(i.unit_price) * i.quantity, 0);
    assert.equal(suma, 16000);
  });

  it("todos los items llevan category_id food (verificado contra la API de prueba)", () => {
    const items = buildOrderItems({ items: [PRODUCTO("Wok de pollo", 8000)], total: 8000, discount: 0, shippingCost: 0 });
    assert.ok(items.every((i) => i.category_id === "food"));
  });

  it("los extras se suman al unit_price y se ven en title y description", () => {
    const items = buildOrderItems({
      items: [PRODUCTO("Wok de pollo", 8000, 1, [{ id: "e1", label: "Pollo extra", price: 1500 }])],
      total: 9500,
      discount: 0,
      shippingCost: 0,
    });
    assert.equal(items[0].unit_price, "9500");
    assert.match(items[0].title, /Wok de pollo/);
    assert.match(items[0].title, /Pollo extra/);
    assert.match(items[0].description, /Pollo extra/);
  });

  it("el envio va como item propio de quantity 1", () => {
    const items = buildOrderItems({
      items: [PRODUCTO("Wok de pollo", 8000)],
      total: 8800,
      discount: 0,
      shippingCost: 800,
    });
    assert.equal(items.length, 2);
    const envio = items.find((i) => i.title === "Envío");
    assert.equal(envio.unit_price, "800");
    assert.equal(envio.quantity, 1);
    assert.equal(items.reduce((s, i) => s + Number(i.unit_price) * i.quantity, 0), 8800);
  });

  it("el descuento se reparte en los unit_prices y la suma sigue dando EXACTO el total", () => {
    // 8000 + 4000 = 12000 de productos, cupón de 2000, envío 800 → total 10800.
    // El reparto es por línea de mayor subtotal: la primera absorbe lo que
    // pueda manteniendo su unit_price entero, el resto sigue en las otras.
    const items = buildOrderItems({
      items: [PRODUCTO("Wok de pollo", 8000), PRODUCTO("Spring rolls", 4000)],
      total: 10800,
      discount: 2000,
      shippingCost: 800,
    });
    const suma = items.reduce((s, i) => s + Number(i.unit_price) * i.quantity, 0);
    assert.equal(suma, 10800);
    assert.equal(items[0].unit_price, "6000"); // 8000 - 2000 (la línea mayor absorbe)
    assert.equal(items[1].unit_price, "4000"); // sin descuento
    assert.equal(items[2].title, "Envío");
    assert.equal(items[2].unit_price, "800");
  });

  it("con descuento y cantidad > 1 el unit_price queda ENTERO", () => {
    // 2× 5000 = 10000, cupón de 1000 → subtotal ajustado 9000 → 4500 por unidad.
    const items = buildOrderItems({
      items: [PRODUCTO("Wok de pollo", 5000, 2)],
      total: 9000,
      discount: 1000,
      shippingCost: 0,
    });
    assert.equal(items[0].unit_price, "4500");
    assert.equal(items[0].quantity, 2);
    assert.equal(items.reduce((s, i) => s + Number(i.unit_price) * i.quantity, 0), 9000);
  });

  it("descuento que no se puede expresar con unit_prices enteros: devuelve null (fallback al item unico)", () => {
    // 1 línea de 2× 5000 = 10000, cupón de 333: el subtotal ajustado tiene que
    // seguir divisible por 2, y 9667 no lo es. No hay otra línea que absorba
    // el resto → la suma exacta es imposible → ítem único.
    const items = buildOrderItems({
      items: [PRODUCTO("Wok de pollo", 5000, 2)],
      total: 9667,
      discount: 333,
      shippingCost: 0,
    });
    assert.equal(items, null);
  });

  it("greedy de mayor subtotal pierde repartos alcanzables: hay que reintentar en el otro orden", () => {
    // Caso real encontrado en la review: 3× 10000 + 2× 5000, cupón de 4000
    // (total 36000). Recorriendo de la línea mayor a la menor, la grande
    // absorbe 3999 (máximo múltiplo de 3) y el resto de $1 no es par para la
    // chica → null. La solución exacta EXISTE: 10000×3 + 3000×2 = 36000
    // (la chica absorbe el cupón entero).
    const items = buildOrderItems({
      items: [PRODUCTO("Combo familiar", 10000, 3), PRODUCTO("Wok chico", 5000, 2)],
      total: 36000,
      discount: 4000,
      shippingCost: 0,
    });
    assert.notEqual(items, null);
    const suma = items.reduce((s, i) => s + Number(i.unit_price) * i.quantity, 0);
    assert.equal(suma, 36000);
  });

  it("descuento que deja una linea en cero: devuelve null (MP no acepta precios en 0)", () => {
    const items = buildOrderItems({
      items: [PRODUCTO("Wok de pollo", 1000)],
      total: 0,
      discount: 1000,
      shippingCost: 0,
    });
    assert.equal(items, null);
  });

  it("descuento mayor al subtotal de productos: devuelve null", () => {
    const items = buildOrderItems({
      items: [PRODUCTO("Wok de pollo", 1000)],
      total: 500,
      discount: 1500,
      shippingCost: 1000,
    });
    assert.equal(items, null);
  });

  it("asercion final: si la suma no coincide con el total, devuelve null", () => {
    // El total no respeta la aritmética de los items → Order inconsistente.
    const items = buildOrderItems({
      items: [PRODUCTO("Wok de pollo", 8000)],
      total: 7000, // ≠ 8000 - 0 + 0
      discount: 0,
      shippingCost: 0,
    });
    assert.equal(items, null);
  });

  it("carrito vacio o total invalido: devuelve null", () => {
    assert.equal(buildOrderItems({ items: [], total: 100, discount: 0, shippingCost: 0 }), null);
    assert.equal(buildOrderItems({ items: [PRODUCTO("Wok", 100)], total: 0, discount: 0, shippingCost: 0 }), null);
    assert.equal(buildOrderItems({ items: [PRODUCTO("Wok", 100)], total: -5, discount: 0, shippingCost: 0 }), null);
  });
});

describe("buildOrderBody con items reales", () => {
  const BACK_URLS2 = {
    success: "https://fusionwok.ar/?pago=aprobado",
    failure: "https://fusionwok.ar/?pago=rechazado",
    pending: "https://fusionwok.ar/?pago=pendiente",
  };

  it("si le pasan items validos, los usa tal cual", () => {
    const mpItems = [
      { title: "Wok de pollo", unit_price: "8000", quantity: 1, category_id: "food" },
      { title: "Envío", unit_price: "800", quantity: 1, category_id: "food" },
    ];
    const body = buildOrderBody({ orderNumber: "FW-900010", total: 8800, backUrls: BACK_URLS2, items: mpItems });
    assert.equal(body.items.length, 2);
    assert.equal(body.total_amount, "8800");
  });

  it("si los items no cuadran con el total, cae al item unico (asercion del server)", () => {
    const mpItems = [{ title: "Wok de pollo", unit_price: "8000", quantity: 1, category_id: "food" }];
    const body = buildOrderBody({ orderNumber: "FW-900011", total: 7000, backUrls: BACK_URLS2, items: mpItems });
    // Fallback: un solo item con el total completo, como se mandaba siempre.
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].unit_price, "7000");
    assert.equal(body.items[0].title, "Pedido Fusión Wok FW-900011");
  });

  it("items en null deja el item unico de siempre", () => {
    const body = buildOrderBody({ orderNumber: "FW-900012", total: 1500, backUrls: BACK_URLS2, items: null });
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].unit_price, "1500");
  });
});
