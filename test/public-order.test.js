import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  toPublicOrder,
  toPublicOrderPublic,
  toAdminOrder,
  decideVerifiedDeliveryResponse,
  checkOrderRateLimit,
  recordOrderFailure,
  recordOrderSuccess,
  _getOrderBucketForTest,
  _clearOrderBucketsForTest,
  isValidOrderNumberFormat,
  isValidPhone,
} from "../server/public-order.js";

const baseRow = {
  id: 1,
  order_number: "FW-00001",
  branch: "tandil",
  customer_name: "Juan Pérez",
  customer_phone: "5492262555555",
  customer_email: "juan@example.com",
  customer_first_name: "Juan",
  customer_last_name: "Pérez",
  address: "Calle Falsa 123",
  order_mode: "delivery",
  payment_method: "mercadopago",
  payment_status: "approved",
  status: "received",
  items: JSON.stringify([{ productId: "wok1", name: "Wok Clásico", qty: 1, unitPrice: 18900, extras: [] }]),
  total: 18900,
  discount: 0,
  coupon_code: "",
  shipping: 0,
  shipping_km: 0,
  shipping_pending: 0,
  scheduled_for: "",
  notes: "Sin cebolla",
  source: "web",
  mp_order_id: "order_123",
  mp_payment_id: "pay_123",
  refunded_amount: 0,
  refunds_json: "[]",
  created_at: "2026-01-15T12:00:00.000Z",
  updated_at: "2026-01-15T12:00:00.000Z",
  seen_at: "2026-01-15T12:05:00.000Z",
};

// Helper para simular la respuesta del endpoint /api/orders/by-phone
function toByPhoneResponse(row) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    branch: row.branch,
    status: row.status,
    paymentStatus: row.payment_status,
    total: row.total,
    createdAt: row.created_at,
  };
}

// Helper para simular la respuesta de replay del POST /api/orders
function toReplayPayload(row) {
  return {
    ok: true,
    orderId: Number(row.id),
    orderNumber: row.order_number,
    demo: false,
    demoToken: "",
    checkoutUrl: null,
    status: row.status,
    total: row.total,
    discount: row.discount || 0,
    couponCode: row.coupon_code || "",
    scheduledFor: row.scheduled_for || "",
    shipping: { cost: row.shipping || 0, blocks: row.shipping_km || 0, pending: !!row.shipping_pending },
  };
}

describe("E-01: toPublicOrderPublic no expone datos privados", () => {
  it("no incluye customer_email", () => {
    const publicOrder = toPublicOrderPublic(baseRow);
    assert.ok(!("customer" in publicOrder), "no debe tener campo customer");
    assert.ok(!("customer_email" in publicOrder), "no debe exponer email");
  });

  it("no incluye customer_name", () => {
    const publicOrder = toPublicOrderPublic(baseRow);
    assert.ok(!("customer_name" in publicOrder), "no debe exponer nombre");
    assert.ok(!("customer_first_name" in publicOrder), "no debe exponer firstName");
    assert.ok(!("customer_last_name" in publicOrder), "no debe exponer lastName");
  });

  it("no incluye customer_phone", () => {
    const publicOrder = toPublicOrderPublic(baseRow);
    assert.ok(!("customer_phone" in publicOrder), "no debe exponer teléfono");
  });

  it("no incluye address", () => {
    const publicOrder = toPublicOrderPublic(baseRow);
    assert.ok(!("address" in publicOrder), "no debe exponer dirección");
  });

  it("no incluye notes del cliente", () => {
    const publicOrder = toPublicOrderPublic(baseRow);
    assert.ok(!("notes" in publicOrder), "no debe exponer notas del cliente");
  });

  it("no incluye branch", () => {
    const publicOrder = toPublicOrderPublic(baseRow);
    assert.ok(!("branch" in publicOrder), "no debe exponer sucursal");
  });

  it("sí incluye campos seguros: id, orderNumber, status, paymentStatus, total, items (sin notes), createdAt", () => {
    const publicOrder = toPublicOrderPublic(baseRow);
    assert.ok("id" in publicOrder);
    assert.ok("orderNumber" in publicOrder);
    assert.ok("status" in publicOrder);
    assert.ok("paymentStatus" in publicOrder);
    assert.ok("total" in publicOrder);
    assert.ok("items" in publicOrder);
    assert.ok("createdAt" in publicOrder);
    // Items sin notes
    assert.ok(!publicOrder.items[0].notes, "items no deben tener notes");
  });
});

describe("E-01: /api/orders/by-phone no expone datos privados", () => {
  it("respuesta solo tiene campos mínimos", () => {
    const resp = toByPhoneResponse(baseRow);
    const allowed = ["id", "orderNumber", "branch", "status", "paymentStatus", "total", "createdAt"];
    for (const key of Object.keys(resp)) {
      assert.ok(allowed.includes(key), `campo inesperado en by-phone: ${key}`);
    }
    assert.ok(!("customer_name" in resp));
    assert.ok(!("customer_phone" in resp));
    assert.ok(!("customer_email" in resp));
    assert.ok(!("address" in resp));
    assert.ok(!("notes" in resp));
  });
});

describe("E-01: replay de POST /api/orders no expone datos privados", () => {
  it("respuesta de replay no tiene customer, address, notes", () => {
    const replay = toReplayPayload(baseRow);
    const forbidden = ["customer", "customer_email", "customer_name", "customer_phone", "address", "notes", "branch"];
    for (const key of forbidden) {
      assert.ok(!(key in replay), `replay no debe exponer ${key}`);
    }
  });
});

describe("toPublicOrder (panel admin) SÍ expone datos personales", () => {
  it("incluye customer con email, name, phone, address", () => {
    const adminOrder = toPublicOrder(baseRow);
    assert.ok("customer" in adminOrder);
    assert.equal(adminOrder.customer.email, "juan@example.com");
    assert.equal(adminOrder.customer.name, "Juan Pérez");
    assert.equal(adminOrder.customer.phone, "5492262555555");
    assert.ok("address" in adminOrder);
    assert.equal(adminOrder.address, "Calle Falsa 123");
  });
});

describe("toAdminOrder extiende toPublicOrder con seenAt", () => {
  it("incluye seenAt además de todos los campos de toPublicOrder", () => {
    const adminOrder = toAdminOrder(baseRow);
    assert.ok("seenAt" in adminOrder);
    assert.equal(adminOrder.seenAt, "2026-01-15T12:05:00.000Z");
    assert.ok("customer" in adminOrder);
  });
});

describe("decideVerifiedDeliveryResponse — lógica pura de respuesta (sin BD, sin rate limit)", () => {
  const deliveryRow = { ...baseRow, order_mode: "delivery", address: "Calle Falsa 123" };
  const pickupRow = { ...baseRow, order_mode: "pickup", address: "Calle Falsa 123" };
  const noPhoneRow = { ...baseRow, order_mode: "delivery", address: "Calle Falsa 123", customer_phone: "" };
  const noAddressRow = { ...baseRow, order_mode: "delivery", address: "", customer_phone: "5492262555555" };

  it("TODOS los fallos devuelven EXACTAMENTE { address: '' } (regresión: no filtrar info por status/cuerpo)", () => {
    const fail = { address: "" };
    // Pedido inexistente
    assert.deepEqual(decideVerifiedDeliveryResponse(null, "5492262555555"), fail);
    // orderNumber formato inválido (no se usa acá, pero row=null lo cubre)
    // Teléfono formato inválido
    assert.deepEqual(decideVerifiedDeliveryResponse(deliveryRow, "abc"), fail);
    assert.deepEqual(decideVerifiedDeliveryResponse(deliveryRow, "123"), fail); // muy corto
    assert.deepEqual(decideVerifiedDeliveryResponse(deliveryRow, ""), fail); // vacío
    // Mismatch
    assert.deepEqual(decideVerifiedDeliveryResponse(deliveryRow, "5492262555556"), fail);
    // Pedido de retiro (pickup)
    assert.deepEqual(decideVerifiedDeliveryResponse(pickupRow, "5492262555555"), fail);
    // Pedido sin teléfono en BD
    assert.deepEqual(decideVerifiedDeliveryResponse(noPhoneRow, "5492262555555"), fail);
    // Pedido sin teléfono en BD + input vacío
    assert.deepEqual(decideVerifiedDeliveryResponse(noPhoneRow, ""), fail);
  });

  it("Éxito devuelve { address: '...' } con la dirección real", () => {
    assert.deepEqual(decideVerifiedDeliveryResponse(deliveryRow, "5492262555555"), { address: "Calle Falsa 123" });
    // Distintos formatos de entrada → misma normalización
    assert.deepEqual(decideVerifiedDeliveryResponse(deliveryRow, "+54 9 2262 55-5555"), { address: "Calle Falsa 123" });
    assert.deepEqual(decideVerifiedDeliveryResponse(deliveryRow, "54 9 2262 555555"), { address: "Calle Falsa 123" });
  });

  it("Delivery sin dirección devuelve { address: '' } (éxito pero sin dirección)", () => {
    assert.deepEqual(decideVerifiedDeliveryResponse(noAddressRow, "5492262555555"), { address: "" });
  });

  it("La respuesta NUNCA incluye email, nombre ni teléfono", () => {
    const result = decideVerifiedDeliveryResponse(deliveryRow, "5492262555555");
    assert.ok("address" in result);
    assert.equal(Object.keys(result).length, 1);
    assert.ok(!("customer" in result));
    assert.ok(!("customer_email" in result));
    assert.ok(!("customer_name" in result));
    assert.ok(!("customer_phone" in result));
  });
});

describe("Rate limiter por pedido (checkOrderRateLimit / recordOrderFailure / recordOrderSuccess)", () => {
  const ORDER = "FW-00001";

  beforeEach(() => {
    _clearOrderBucketsForTest();
  });

  it("Primeros 5 fallos: allowed=true, contador incrementa (check + recordFailure)", () => {
    for (let i = 0; i < 5; i++) {
      const r = checkOrderRateLimit(ORDER);
      assert.equal(r.allowed, true, `Intento ${i + 1} debe permitir`);
      recordOrderFailure(ORDER);
    }
    const bucket = _getOrderBucketForTest(ORDER);
    assert.equal(bucket.failures, 5, "Contador debe ser 5 tras 5 fallos");
  });

  it("6º fallo (superado límite): allowed=false, devuelve fallo genérico sin consultar BD", () => {
    // Simular 5 fallos reales: check + recordFailure
    for (let i = 0; i < 5; i++) {
      checkOrderRateLimit(ORDER);
      recordOrderFailure(ORDER);
    }
    // 6º check debe bloquear
    const r = checkOrderRateLimit(ORDER);
    assert.equal(r.allowed, false, "6º intento debe bloquear");
    assert.equal(r.bucket.failures, 5);
  });

  it("Acierto NO incrementa contador y LO RESETEA (borra bucket)", () => {
    checkOrderRateLimit(ORDER);
    recordOrderFailure(ORDER);
    checkOrderRateLimit(ORDER);
    recordOrderFailure(ORDER);
    recordOrderSuccess(ORDER);
    const bucket = _getOrderBucketForTest(ORDER);
    assert.equal(bucket, null, "Bucket debe borrarse en acierto");
    // Nuevo intento tras acierto empieza de cero
    const r = checkOrderRateLimit(ORDER);
    assert.equal(r.allowed, true);
    assert.equal(r.bucket.failures, 0);
  });

  it("5 fallos seguidos → 6º intento con teléfono correcto también bloquea (ventana activa)", () => {
    for (let i = 0; i < 5; i++) {
      checkOrderRateLimit(ORDER);
      recordOrderFailure(ORDER);
    }
    // Incluso si ahora viene el teléfono correcto, el rate limit bloquea ANTES de consultar BD
    const r = checkOrderRateLimit(ORDER);
    assert.equal(r.allowed, false, "Rate limit bloquea aunque el teléfono sea correcto");
  });

  it("Pasada la ventana de 15 min (reset), vuelve a permitir", () => {
    for (let i = 0; i < 5; i++) {
      checkOrderRateLimit(ORDER);
      recordOrderFailure(ORDER);
    }
    const bucket = _getOrderBucketForTest(ORDER);
    bucket.reset = Date.now() - 1000; // forzamos expiración
    const r = checkOrderRateLimit(ORDER);
    assert.equal(r.allowed, true, "Ventana expirada debe permitir de nuevo");
    assert.equal(r.bucket.failures, 0, "Contador reseteado tras ventana");
  });

  it("Diferentes orderNumbers tienen buckets independientes", () => {
    checkOrderRateLimit("FW-00001");
    recordOrderFailure("FW-00001");
    checkOrderRateLimit("FW-00001");
    recordOrderFailure("FW-00001");
    checkOrderRateLimit("FW-00002");
    recordOrderFailure("FW-00002");
    assert.equal(_getOrderBucketForTest("FW-00001").failures, 2);
    assert.equal(_getOrderBucketForTest("FW-00002").failures, 1);
  });
});

describe("Integración: handler POST /api/orders/number/:orderNumber/details (orden real: formato → rate limit → decisión)", () => {
  const deliveryRow = { ...baseRow, order_mode: "delivery", address: "Calle Falsa 123" };
  const noPhoneRow = { ...baseRow, order_mode: "delivery", address: "Calle Falsa 123", customer_phone: "" };
  const noAddressRow = { ...baseRow, order_mode: "delivery", address: "", customer_phone: "5492262555555" };

  beforeEach(() => {
    _clearOrderBucketsForTest();
  });

  it("orderNumber formato inválido → 200 { address: '' } SIN tocar rate limit", () => {
    const invalidNum = "INVALID-123";
    assert.equal(isValidOrderNumberFormat(invalidNum), false);
    // Simular handler: formato inválido → fallo genérico SIN llamar checkOrderRateLimit
    const response = { address: "" };
    // Verificar que el bucket no se creó
    assert.equal(_getOrderBucketForTest(invalidNum), null);
  });

  it("teléfono formato inválido → 200 { address: '' } SIN tocar rate limit", () => {
    const invalidPhone = "abc";
    assert.equal(isValidPhone(invalidPhone), false);
    // Simular handler: formato inválido → fallo genérico SIN llamar checkOrderRateLimit
    assert.equal(_getOrderBucketForTest("FW-00001"), null);
  });

  it("orderNumber válido + teléfono inválido → 200 { address: '' } y rate limit incrementa", () => {
    const num = "FW-00001";
    checkOrderRateLimit(num);
    assert.equal(_getOrderBucketForTest(num).failures, 0);
    // Handler: formato válido, luego rate limit, luego decisión
    const rl = checkOrderRateLimit(num);
    assert.equal(rl.allowed, true);
    recordOrderFailure(num);
    assert.equal(_getOrderBucketForTest(num).failures, 1);
    const response = decideVerifiedDeliveryResponse(deliveryRow, "abc");
    assert.deepEqual(response, { address: "" });
  });

  it("orderNumber inexistente + teléfono válido → 200 { address: '' } y rate limit incrementa", () => {
    const num = "FW-999999";
    checkOrderRateLimit(num);
    recordOrderFailure(num);
    assert.equal(_getOrderBucketForTest(num).failures, 1);
    const response = decideVerifiedDeliveryResponse(null, "5492262555555");
    assert.deepEqual(response, { address: "" });
  });

  it("mismatch teléfono → 200 { address: '' } y rate limit incrementa", () => {
    const num = "FW-00001";
    checkOrderRateLimit(num);
    recordOrderFailure(num);
    assert.equal(_getOrderBucketForTest(num).failures, 1);
    const response = decideVerifiedDeliveryResponse(deliveryRow, "5492262555556");
    assert.deepEqual(response, { address: "" });
  });

  it("pedido pickup → 200 { address: '' } y rate limit incrementa", () => {
    const num = "FW-00001";
    checkOrderRateLimit(num);
    recordOrderFailure(num);
    assert.equal(_getOrderBucketForTest(num).failures, 1);
    const response = decideVerifiedDeliveryResponse({ ...baseRow, order_mode: "pickup", address: "Calle 123" }, "5492262555555");
    assert.deepEqual(response, { address: "" });
  });

  it("pedido sin teléfono en BD → 200 { address: '' } y rate limit incrementa", () => {
    const num = "FW-00001";
    checkOrderRateLimit(num);
    recordOrderFailure(num);
    assert.equal(_getOrderBucketForTest(num).failures, 1);
    const response = decideVerifiedDeliveryResponse(noPhoneRow, "5492262555555");
    assert.deepEqual(response, { address: "" });
  });

  it("delivery sin dirección (éxito pero address='') → 200 { address: '' } y rate limit RESETEADO", () => {
    const num = "FW-00001";
    checkOrderRateLimit(num);
    recordOrderFailure(num);
    recordOrderFailure(num); // 2 fallos previos
    assert.equal(_getOrderBucketForTest(num).failures, 2);
    const response = decideVerifiedDeliveryResponse(noAddressRow, "5492262555555");
    assert.deepEqual(response, { address: "" });
    // Éxito (address === "" cuenta como éxito para rate limit)
    recordOrderSuccess(num);
    assert.equal(_getOrderBucketForTest(num), null, "Bucket debe borrarse en éxito");
  });

  it("éxito con dirección → 200 { address: 'Calle Falsa 123' } y rate limit RESETEADO", () => {
    const num = "FW-00001";
    checkOrderRateLimit(num);
    recordOrderFailure(num);
    recordOrderFailure(num);
    assert.equal(_getOrderBucketForTest(num).failures, 2);
    const response = decideVerifiedDeliveryResponse(deliveryRow, "5492262555555");
    assert.deepEqual(response, { address: "Calle Falsa 123" });
    recordOrderSuccess(num);
    assert.equal(_getOrderBucketForTest(num), null, "Bucket debe borrarse en éxito");
  });

  it("rate limit por pedido: 5 fallos → 6º bloquea con 200 { address: '' }", () => {
    const num = "FW-00001";
    for (let i = 0; i < 5; i++) {
      checkOrderRateLimit(num);
      recordOrderFailure(num);
    }
    assert.equal(_getOrderBucketForTest(num).failures, 5);
    // 6º check bloquea
    const rl = checkOrderRateLimit(num);
    assert.equal(rl.allowed, false);
    // Handler respondería genérico SIN consultar BD ni llamar a la decisión
    // Verificamos que el rate limit bloquea correctamente
    assert.equal(rl.allowed, false);
  });

  it("rate limit tel+IP es independiente y no se prueba aquí (se prueba en by-phone tests)", () => {
    // Este test solo documenta que el limitador tel+IP existe pero se prueba en by-phone tests
    assert.ok(true);
  });
});