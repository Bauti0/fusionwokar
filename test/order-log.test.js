import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { orderLogLine, ORDER_LOG_FIELDS } from "../server/order-log.js";

// Estos tests fijan DOS cosas del log de checkout:
//
//  1. Que la línea sirva para diagnosticar ("¿por qué el local ve
//     'Producto no disponible'?"). Antes no había ningún rastro en Render.
//  2. Que NO pueda filtrar datos personales. Es la parte que más importa:
//     los logs de Render se leen, se descargan y a veces se pegan en
//     tickets. Si el log del checkout pudiera contener nombre, teléfono,
//     email, dirección o DNI, estaríamos filtrando PII en texto plano.
//     La defensa NO es "no pases esos campos" (el caller es código, y el
//     código se cambia sin querer): es que orderLogLine es una WHITELIST
//     que ignora cualquier clave que no sea de la lista, más un saneo de
//     los valores para que un dato del cliente no rompa la línea.

const PII = {
  name: "Juana Pérez",
  firstName: "Juana",
  lastName: "Pérez",
  phone: "2262555555",
  email: "juana.perez@example.com",
  address: "Calle 12 345, Tandil",
  dni: "30111222",
  notes: "Sin sal, tocar el timbre del 3",
  identification: { type: "dni", number: "30111222" },
};

// Un body de pedido entero: el caller más tentador para pasarle todo.
const orderBody = {
  branch: "tandil",
  orderMode: "delivery",
  paymentMethod: "mercadopago",
  address: "Calle 12 345",
  couponCode: "VERANO10",
  notes: "Sin sal",
  customer: PII,
  items: [{ productId: "fw-00006", name: "Wok de pollo", qty: 2, notes: "poco picante" }],
  ...PII,
};

describe("orderLogLine: formato", () => {
  it("arma la línea de un rechazo con todos los campos de contexto", () => {
    const line = orderLogLine("POST /api/orders", 400, {
      branch: "tandil",
      orderMode: "delivery",
      paymentMethod: "mercadopago",
      message: "Producto no disponible",
    });
    assert.equal(
      line,
      '[orders] POST /api/orders status=400 branch=tandil mode=delivery payment=mercadopago msg="Producto no disponible"'
    );
  });

  it("incluye el código de falla de envío y el código de la respuesta", () => {
    const line = orderLogLine("POST /api/orders", 400, {
      branch: "tandil",
      orderMode: "delivery",
      paymentMethod: "mercadopago",
      shippingCode: "zone",
      code: "shipping_unavailable",
      message: "No pudimos calcular el envío. Escribinos por WhatsApp.",
    });
    assert.match(line, /shippingCode=zone/);
    assert.match(line, /code=shipping_unavailable/);
    assert.match(line, /status=400/);
  });

  it("arma la línea de éxito con número de pedido, sucursal y método de pago", () => {
    const line = orderLogLine("POST /api/orders", 200, {
      orderNumber: "FW-00006",
      branch: "necochea",
      orderMode: "pickup",
      paymentMethod: "efectivo",
    });
    assert.equal(
      line,
      "[orders] POST /api/orders status=200 branch=necochea mode=pickup payment=efectivo order=FW-00006"
    );
    assert.doesNotMatch(line, /msg=/, "el éxito no lleva msg");
  });

  it("omite los campos opcionales que el caller no conoce", () => {
    const line = orderLogLine("POST /api/orders/:id/payment-link", 429, {});
    assert.equal(
      line,
      "[orders] POST /api/orders/:id/payment-link status=429 branch=- mode=- payment=-"
    );
    assert.doesNotMatch(line, /shippingCode|code=|order=|msg=/);
  });

  it("siempre es una sola línea", () => {
    const line = orderLogLine("POST /api/orders", 400, {
      branch: "tandil",
      message: "linea 1\nlinea 2\r\n[orders] POST /api/orders status=200 order=FW-99999",
    });
    assert.equal(line.includes("\n"), false);
    assert.equal(line.includes("\r"), false);
    // La línea inyectada queda como texto plano del msg, no como otra línea.
    assert.equal(line.split("\n").length, 1);
    assert.match(line, /msg="linea 1 linea 2 \[orders\] POST \/api\/orders status=200 order=FW-99999"/);
  });

  it("recorta el mensaje largo y cierra comillas (una línea, siempre)", () => {
    const line = orderLogLine("POST /api/orders", 400, { message: "x".repeat(500) });
    assert.equal(line.endsWith('"'), true);
    assert.equal(line.length < 260, true);
  });

  it("sustituye comillas y barras del mensaje para no romper el formato", () => {
    const line = orderLogLine("POST /api/orders", 400, { message: 'digamos "sí" \\ tal cual' });
    assert.match(line, /msg="digamos 'sí' ' tal cual"/);
  });

  it("un branch con basura del cliente no puede inyectar campos al log", () => {
    const line = orderLogLine("POST /api/orders", 400, {
      branch: "tandil order=FW-99999 status=200",
      orderMode: "delivery\nadmin",
      paymentMethod: "efectivo",
      message: "Sucursal inválida",
    });
    assert.match(line, /branch=-/);
    assert.match(line, /mode=-/);
    assert.doesNotMatch(line, /order=FW-99999/);
  });

  it("tolera ctx ausente, nulo o con tipos raros sin romperse", () => {
    assert.equal(typeof orderLogLine("POST /api/orders", 400), "string");
    assert.equal(typeof orderLogLine("POST /api/orders", 400, null), "string");
    assert.match(orderLogLine("POST /api/orders", "nope", { branch: 42 }), /status=-/);
    assert.match(orderLogLine("POST /api/orders", 400, { branch: 42 }), /branch=42/);
  });
});

describe("orderLogLine: nunca filtra datos personales", () => {
  it("ignora cualquier clave fuera de la whitelist, incluso con el body entero", () => {
    const line = orderLogLine("POST /api/orders", 400, { ...orderBody, message: "Faltan datos del cliente" });
    for (const value of Object.values(PII)) {
      if (typeof value === "object") continue;
      assert.equal(line.includes(String(value)), false, `filtró ${value}`);
    }
    assert.equal(line.includes("Calle 12 345"), false, "filtró la dirección");
    assert.equal(line.includes("example.com"), false, "filtró el email");
    assert.equal(line.includes("2262555555"), false, "filtró el teléfono");
    assert.equal(line.includes("30111222"), false, "filtró el DNI");
    assert.equal(line.includes("Sin sal"), false, "filtró las notas");
    assert.equal(line.includes("VERANO10"), false, "filtró el cupón");
    assert.equal(line.includes("fw-00006"), false, "filtró el id de producto");
  });

  it("solo lee las claves de ORDER_LOG_FIELDS", () => {
    assert.deepEqual(ORDER_LOG_FIELDS, [
      "branch",
      "orderMode",
      "paymentMethod",
      "shippingCode",
      "code",
      "orderNumber",
      "message",
    ]);
  });

  it("no filtra PII cuando el caller pasa la fila de orders de la base", () => {
    // Así se llama desde POST /api/orders/:id/payment-link.
    const row = {
      id: 6,
      order_number: "FW-00006",
      branch: "tandil",
      order_mode: "delivery",
      payment_method: "mercadopago",
      customer_name: PII.name,
      customer_phone: PII.phone,
      customer_email: PII.email,
      customer_first_name: PII.firstName,
      customer_last_name: PII.lastName,
      address: PII.address,
      notes: PII.notes,
      items: JSON.stringify([{ name: "Wok de pollo", notes: PII.notes }]),
      total: 18900,
    };
    const line = orderLogLine("POST /api/orders/:id/payment-link", 409, {
      branch: row.branch,
      orderMode: row.order_mode,
      paymentMethod: row.payment_method,
      orderNumber: row.order_number,
      code: "not_retryable",
      message: "Este pedido ya tiene un link de pago",
      // Si el caller se pasa y manda la fila entera, la whitelist la ignora.
      ...row,
    });
    assert.equal(line.includes(PII.name), false);
    assert.equal(line.includes(PII.phone), false);
    assert.equal(line.includes(PII.email), false);
    assert.equal(line.includes(PII.address), false);
    assert.equal(line.includes(PII.notes), false);
    assert.match(line, /order=FW-00006/);
  });
});

// Contrato con el resto del server: el `msg` que se loguea es el MISMO texto
// que se le respondió al cliente. Si alguno de esos textos dejara de ser un
// literal y empezara a interpolar un dato del cliente, esta línea del log
// pasaría a filtrar PII y el test tiene que cortarlo.
describe("los mensajes de error que llegan al log no llevan datos del cliente", () => {
  // Lo que un `error:` puede interpolar es lo que está DENTRO de un
  // `${...}` o fuera de los literales. Se descartan los textos entre comillas
  // (que son prosa en castellano: "Falta un teléfono válido" menciona el
  // teléfono, no lo filtra) y solo queda lo que se evalúa en runtime.
  function expresionesEvaluadas(linea) {
    const desde = linea.indexOf("error:");
    if (desde < 0) return null;
    let resto = linea.slice(desde);
    // Template literals: se queda solo con las interpolaciones.
    resto = resto.replace(/`([^`]*)`/g, (_, inner) => (inner.match(/\$\{[^{}]*\}/g) || []).join(" "));
    // Literales simples y apostillas: prosa, no datos.
    resto = resto.replace(/"[^"]*"|'[^']*'/g, " ");
    return resto;
  }

  const prohibido = [
    /customer/i,
    /address/i,
    /phone/i,
    /email/i,
    /identification/i,
    /notes/i,
    /firstName/i,
    /lastName/i,
    /dni/i,
  ];

  function escanear(src, etiqueta) {
    const offenses = [];
    for (const linea of src.split("\n")) {
      const evaluadas = expresionesEvaluadas(linea);
      if (evaluadas === null) continue;
      for (const re of prohibido) {
        if (re.test(evaluadas)) offenses.push(`${etiqueta}: ${linea.trim()}  <-- ${re}`);
      }
    }
    return offenses;
  }

  const index = readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const start = index.indexOf("async function validateOrderBody");
  const end = index.indexOf("// Registra un evento de analytics");
  const coupons = readFileSync(new URL("../server/coupons.js", import.meta.url), "utf8");
  const shipping = readFileSync(new URL("../server/shipping.js", import.meta.url), "utf8");

  it("se pudo recortar validateOrderBody de index.js", () => {
    assert.ok(start > 0 && end > start, "no se pudo recortar validateOrderBody de index.js");
  });

  it("validateOrderBody no interpola datos del cliente en sus errores", () => {
    assert.deepEqual(escanear(index.slice(start, end), "validateOrderBody"), []);
  });

  it("coupons.js (cupones) no interpola datos del cliente en sus errores", () => {
    assert.deepEqual(escanear(coupons, "coupons.js"), []);
  });

  it("shipping.js (envío) no interpola la dirección en sus mensajes", () => {
    // Los mensajes de envío (zone / unknown / transient) llegan al log vía
    // err.message: solo pueden traer números (cuadradas/km), nunca la
    // dirección que los dispara.
    const offenses = [];
    for (const linea of shipping.split("\n")) {
      if (!/throw (transient|unknown|new ShippingError)/.test(linea)) continue;
      const evaluadas = linea
        .replace(/`([^`]*)`/g, (_, inner) => (inner.match(/\$\{[^{}]*\}/g) || []).join(" "))
        .replace(/"[^"]*"|'[^']*'/g, " ");
      for (const re of prohibido) {
        if (re.test(evaluadas)) offenses.push(`shipping.js: ${linea.trim()}  <-- ${re}`);
      }
    }
    assert.deepEqual(offenses, []);
  });

  it("el error de precio solo interpola el nombre del producto y el precio del catálogo", () => {
    assert.match(index.slice(start, end), /El precio de "\$\{name\}" cambió a \$\$\{product\.price\}/);
  });
});

