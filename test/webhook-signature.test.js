import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "../server/mp.js";

// ---------------------------------------------------------------------
// FASE A (PAY-01): tests de caracterización de verifyWebhookSignature.
//
// Esta función es la ÚNICA barrera del webhook de Mercado Pago: si
// devuelve true, un pedido queda confirmado como pagado. Si devuelve
// false para una notificación genuina, un pago real nunca se confirma
// solo. Estos tests clavan el comportamiento de la firma para poder
// endurecer la comparación (timingSafeEqual reutilizando safeEqual de
// auth.js) sin romper las notificaciones genuinas.
//
// NOTA sobre el ts: NO se valida la antigüedad del ts (decisión
// explícita del equipo, fijada por el test de "ts viejo" de abajo).
// Los casos positivos usan un ts del momento simplemente por realismo:
// MP firma con el ts en el que generó la notificación.
// ---------------------------------------------------------------------

// Secreto de PRUEBA inventado para los tests: no sale de ningún .env.
const SECRET = "secreto-de-prueba-del-webhook-fusionwok";

// Setea MP_WEBHOOK_SECRET mientras corre fn y lo restaura después
// (mismo patrón try/finally que test/mp-order.test.js). La función
// lee el secret en cada llamada, así que se puede fijar por caso y
// ningún test queda a merced de una variable suelta del entorno.
async function conSecret(valor, fn) {
  const previo = process.env.MP_WEBHOOK_SECRET;
  if (valor === undefined) delete process.env.MP_WEBHOOK_SECRET;
  else process.env.MP_WEBHOOK_SECRET = valor;
  try {
    return await fn();
  } finally {
    if (previo === undefined) delete process.env.MP_WEBHOOK_SECRET;
    else process.env.MP_WEBHOOK_SECRET = previo;
  }
}

// Computa la firma igual que Mercado Pago: HMAC-SHA256 (hex) del
// manifest "id:<id>;request-id:<request-id>;ts:<ts>;" con el secret
// del webhook. El formato se duplica acá A PROPÓSITO: es el contrato
// con MP; si producción cambia el manifest (campos, orden, ";"), la
// firma "válida" deja de validar y estos tests lo detectan.
function firmar({ secret = SECRET, dataId = "", requestId = "", ts, v1, enMayusculas = false } = {}) {
  const manifest =
    (dataId ? `id:${dataId};` : "") +
    (requestId ? `request-id:${requestId};` : "") +
    `ts:${ts};`;
  const hmac = createHmac("sha256", secret).update(manifest).digest("hex");
  return `ts=${ts},v1=${v1 ?? (enMayusculas ? hmac.toUpperCase() : hmac)}`;
}

// Pedido de webhook con la forma mínima que lee la función: headers ya
// en minúsculas (así los normaliza Express), originalUrl para el
// query ?data.id= y body para las notificaciones viejas de
// Preferences (que no traían el id en el query).
function reqWebhook({ dataId, requestId, signature, body = {} } = {}) {
  const headers = {};
  if (signature !== undefined) headers["x-signature"] = signature;
  if (requestId !== undefined) headers["x-request-id"] = requestId;
  const query = dataId ? `?data.id=${encodeURIComponent(dataId)}` : "";
  return { headers, originalUrl: `/api/webhook${query}`, body };
}

describe("verifyWebhookSignature (firma del webhook de Mercado Pago)", () => {
  it("acepta una firma genuina de Orders (data.id en el query + request-id + ts)", async () => {
    // Regresión que cubre: si se rompe el armado del manifest o del
    // HMAC, TODAS las notificaciones reales de Orders se rechazan y
    // ningún pago confirmaría solo. El data.id va en mayúsculas (como
    // lo manda MP en Orders) y la firma se computa sobre el id en
    // minúsculas, que es lo que exige el manifest.
    const ts = String(Date.now());
    const resultado = await conSecret(SECRET, () => {
      const firma = firmar({
        dataId: "ord01abc-def456-ghi789",
        requestId: "req-webhook-0001",
        ts,
      });
      const req = reqWebhook({
        dataId: "ORD01ABC-DEF456-GHI789",
        requestId: "req-webhook-0001",
        signature: firma,
      });
      return verifyWebhookSignature(req);
    });
    assert.equal(resultado, true);
  });

  it("acepta notificaciones viejas de Preferences: el data.id viaja en el body", async () => {
    // Regresión que cubre: los pedidos creados con la integración de
    // Preferencias notifican con data.id en el body. Si el armado del
    // manifest dejara de mirar el body, esos webhooks se rechazarían
    // y un pago de un pedido viejo quedaría colgado.
    const ts = String(Date.now());
    const resultado = await conSecret(SECRET, () => {
      const firma = firmar({ dataId: "1234567890", requestId: "req-webhook-0002", ts });
      const req = reqWebhook({
        requestId: "req-webhook-0002",
        signature: firma,
        body: { data: { id: "1234567890" } },
      });
      return verifyWebhookSignature(req);
    });
    assert.equal(resultado, true);
  });

  it("acepta la v1 en MAYÚSCULAS: el hex se compara case-insensitive", async () => {
    // Regresión que cubre: la comparación actual hace toLowerCase de
    // la v1 antes de comparar. Si alguien la compara en crudo (p. ej.
    // al migrar a timingSafeEqual en la fase B), una firma genuina en
    // mayúsculas se rechazaría sin razón.
    const ts = String(Date.now());
    const resultado = await conSecret(SECRET, () => {
      const firma = firmar({ dataId: "ord01abc-def456-ghi789", requestId: "req-webhook-0003", ts, enMayusculas: true });
      const req = reqWebhook({ dataId: "ORD01ABC-DEF456-GHI789", requestId: "req-webhook-0003", signature: firma });
      return verifyWebhookSignature(req);
    });
    assert.equal(resultado, true);
  });

  it("acepta una firma genuina con ts VIEJO (hace una hora): no hay ventana de antigüedad a propósito", async () => {
    // Este test FIJA una decisión del equipo (fase B): no se valida la
    // antigüedad del ts. No podemos confirmar que Mercado Pago re-firme
    // con un ts nuevo cuando reintenta una notificación que recibió un
    // error nuestro (p. ej. un 500 durante un deploy anterior); si ese
    // reintento legítimo llegara con el ts original y lo rechazáramos,
    // un pago real quedaría sin confirmar, que es peor que el riesgo
    // del replay. Y un replay tampoco puede aprobar nada falso: el
    // webhook siempre re-lee el estado del pago contra la API de MP
    // antes de tocar el pedido, así que una firma vieja solo puede
    // reconfirmar algo que ya es verdad. Si alguien agrega una ventana
    // de antigüedad sin darse cuenta, este test lo rompe.
    const ts = String(Date.now() - 60 * 60 * 1000); // hace una hora
    const resultado = await conSecret(SECRET, () => {
      const firma = firmar({ dataId: "ord01abc-def456-ghi789", requestId: "req-webhook-0012", ts });
      const req = reqWebhook({ dataId: "ORD01ABC-DEF456-GHI789", requestId: "req-webhook-0012", signature: firma });
      return verifyWebhookSignature(req);
    });
    assert.equal(resultado, true);
  });

  it("rechaza una firma manipulada (un solo carácter del hex cambiado)", async () => {
    // Regresión que cubre: el caso de seguridad básico. Si la
    // comparación se relaja (o se "arregla" un bug aceptando firmas
    // aproximadas), cualquiera podría forjar una confirmación de pago.
    const ts = String(Date.now());
    const resultado = await conSecret(SECRET, () => {
      const firma = firmar({ dataId: "ord01abc-def456-ghi789", requestId: "req-webhook-0004", ts });
      const manipulada = firma.slice(0, -1) + (firma.endsWith("0") ? "1" : "0");
      const req = reqWebhook({ dataId: "ORD01ABC-DEF456-GHI789", requestId: "req-webhook-0004", signature: manipulada });
      return verifyWebhookSignature(req);
    });
    assert.equal(resultado, false);
  });

  it("rechaza si el data.id del request no es el que se firmó", async () => {
    // Regresión que cubre: ataque de firma reciclada, la firma de un
    // pedido presentada contra el id de OTRO pedido. Como el id entra
    // al manifest, cualquier cambio tiene que invalidar la firma.
    const ts = String(Date.now());
    const resultado = await conSecret(SECRET, () => {
      const firma = firmar({ dataId: "ord-pedido-original", requestId: "req-webhook-0005", ts });
      const req = reqWebhook({ dataId: "ORD-OTRO-PEDIDO", requestId: "req-webhook-0005", signature: firma });
      return verifyWebhookSignature(req);
    });
    assert.equal(resultado, false);
  });

  it("rechaza si el request-id del request no es el que se firmó", async () => {
    // Regresión que cubre: mismo ataque pero por el request-id, el
    // otro campo del manifest que viaja en headers. Si dejara de
    // entrar al manifest, esta firma trucha pasaría.
    const ts = String(Date.now());
    const resultado = await conSecret(SECRET, () => {
      const firma = firmar({ dataId: "ord01abc-def456-ghi789", requestId: "req-firmado", ts });
      const req = reqWebhook({ dataId: "ORD01ABC-DEF456-GHI789", requestId: "req-reallen", signature: firma });
      return verifyWebhookSignature(req);
    });
    assert.equal(resultado, false);
  });

  it("rechaza si falta el header x-signature", async () => {
    // Regresión que cubre: un request sin header de firma (curl a
    // mano, un bot) tiene que rebotar; "|| ''" del campo ausente
    // debería dejar el regex sin matchear.
    const resultado = await conSecret(SECRET, () => {
      const req = reqWebhook({ dataId: "ORD01ABC-DEF456-GHI789", requestId: "req-webhook-0007" });
      return verifyWebhookSignature(req);
    });
    assert.equal(resultado, false);
  });

  it("rechaza un x-signature sin ts", async () => {
    // Regresión que cubre: sin ts no hay manifest posible; si el
    // parsing aceptara firmas sin ts, se podría omitir la parte del
    // manifest que más fácil se puede ajustar a gusto del atacante.
    const resultado = await conSecret(SECRET, () => {
      const req = reqWebhook({
        dataId: "ORD01ABC-DEF456-GHI789",
        requestId: "req-webhook-0008",
        signature: "v1=e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1",
      });
      return verifyWebhookSignature(req);
    });
    assert.equal(resultado, false);
  });

  it("rechaza un x-signature sin v1", async () => {
    // Regresión que cubre: la v1 ES la firma; un header con ts pero
    // sin v1 no verifica nada.
    const resultado = await conSecret(SECRET, () => {
      const req = reqWebhook({
        dataId: "ORD01ABC-DEF456-GHI789",
        requestId: "req-webhook-0009",
        signature: `ts=${Date.now()}`,
      });
      return verifyWebhookSignature(req);
    });
    assert.equal(resultado, false);
  });

  it("rechaza un x-signature que es cualquier otra cosa (malformado)", async () => {
    // Regresión que cubre: basura directa en el header. El parsing
    // tiene que rechazar lo que no sean los pares ts/v1 de MP.
    const resultado = await conSecret(SECRET, () => {
      const req = reqWebhook({
        dataId: "ORD01ABC-DEF456-GHI789",
        requestId: "req-webhook-0010",
        signature: "esto no es una firma",
      });
      return verifyWebhookSignature(req);
    });
    assert.equal(resultado, false);
  });

  it("sin MP_WEBHOOK_SECRET rechaza TODO, incluso la firma correcta para ese secret", async () => {
    // Regresión que cubre: antes de la corrección, sin secret la
    // función devolvía true "por comodidad en demo", lo que dejaba el
    // webhook abierto a que cualquiera marcara pagos como aprobados.
    // Acá se computa la firma "correcta" con el secret vacío y aún así
    // tiene que rechazar: sin secret la firma NO es verificable.
    const ts = String(Date.now());
    const firma = firmar({ secret: "", dataId: "ord01abc-def456-ghi789", requestId: "req-webhook-0011", ts });
    const req = reqWebhook({ dataId: "ORD01ABC-DEF456-GHI789", requestId: "req-webhook-0011", signature: firma });

    assert.equal(await conSecret("", () => verifyWebhookSignature(req)), false);
    assert.equal(await conSecret(undefined, () => verifyWebhookSignature(req)), false);
  });
});
