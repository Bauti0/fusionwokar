import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  combineOrders,
  isActiveOrder,
  ACTIVE_STATUSES,
  newClientRequestId,
  orderAttemptSignature,
  clientRequestIdFor,
  isOrderRejected,
} from "../src/utils/orders.js";

const now = new Date("2026-09-29T12:00:00").toISOString();
const fifteenMinAgo = new Date("2026-09-29T11:45:00").toISOString();
const thirtyMinAgo = new Date("2026-09-29T11:30:00").toISOString();

describe("isActiveOrder", () => {
  it("devuelve true para estados activos", () => {
    for (const s of ACTIVE_STATUSES) {
      assert.equal(isActiveOrder({ status: s }), true);
    }
  });

  it("devuelve false para completed y cancelled", () => {
    assert.equal(isActiveOrder({ status: "completed" }), false);
    assert.equal(isActiveOrder({ status: "cancelled" }), false);
  });

  it("devuelve false si no hay status", () => {
    assert.equal(isActiveOrder({}), false);
    assert.equal(isActiveOrder({ status: "unknown" }), false);
  });
});

describe("combineOrders", () => {
  const serverOrders = [
    {
      orderNumber: "FW-00001",
      status: "preparing",
      total: 18900,
      createdAt: now,
      branch: "neco",
      items: [{ name: "Wok pollo", qty: 1, unitPrice: 18900 }],
    },
    {
      orderNumber: "FW-00002",
      status: "completed",
      total: 25000,
      createdAt: fifteenMinAgo,
      branch: "neco",
      items: [],
    },
    {
      orderNumber: "FW-00003",
      status: "pending_payment",
      total: 12000,
      createdAt: thirtyMinAgo,
      branch: "centro",
      items: [],
    },
  ];

  const localHistory = [
    {
      id: "local-1",
      orderNumber: "FW-00001",
      total: 18900,
      date: now,
      branch: "neco",
      items: [{ name: "Wok pollo", qty: 1, unitPrice: 18900 }],
    },
    {
      id: "local-2",
      total: 25000,
      date: fifteenMinAgo,
      branch: "neco",
      items: [{ name: "Wok carne", qty: 1, unitPrice: 25000 }],
    },
    {
      id: "local-3",
      total: 9999,
      date: new Date("2026-09-28T12:00:00").toISOString(),
      branch: "neco",
      items: [{ name: "Arroz", qty: 1, unitPrice: 9999 }],
    },
    {
      id: "local-4",
      orderNumber: "FW-00004",
      total: 15000,
      date: new Date("2026-09-28T12:00:00").toISOString(),
      branch: "centro",
      items: [{ name: "Noodles", qty: 1, unitPrice: 15000 }],
    },
  ];

  it("deduplica por orderNumber exacto (server + local con mismo número)", () => {
    const res = combineOrders(serverOrders, localHistory, "neco");
    const fw00001 = res.filter((r) => r.order.orderNumber === "FW-00001");
    assert.equal(fw00001.length, 1);
    assert.equal(fw00001[0].source, "server");
    assert.equal(fw00001[0].canRepeat, true);
  });

  it("descarta local sin orderNumber si coincide total y fecha ±15min con server", () => {
    const res = combineOrders(serverOrders, localHistory, "neco");
    const fw00002 = res.filter((r) => r.order.orderNumber === "FW-00002");
    assert.equal(fw00002.length, 1);
    assert.equal(fw00002[0].source, "server");
    assert.equal(fw00002[0].canRepeat, true);
  });

  it("mantiene local sin orderNumber si NO coincide total/fecha con server", () => {
    const res = combineOrders(serverOrders, localHistory, "neco");
    const localOnly = res.filter((r) => r.source === "local");
    const local3 = localOnly.find((r) => r.order.id === "local-3");
    assert.ok(local3, "local-3 debe aparecer");
    assert.equal(local3.canRepeat, true);
  });

  it("mantiene local con orderNumber distinto a todos los del server", () => {
    const res = combineOrders(serverOrders, localHistory, "neco");
    const local4 = res.find((r) => r.order.orderNumber === "FW-00004");
    assert.ok(local4, "FW-00004 del local debe aparecer");
    assert.equal(local4.source, "local");
    assert.equal(local4.canRepeat, false); // branch distinta
  });

  it("activos arriba (preparing, pending_payment), históricos abajo (completed)", () => {
    const res = combineOrders(serverOrders, localHistory, "neco");
    assert.equal(res[0].order.orderNumber, "FW-00001");
    assert.equal(res[0].isActive, true);
    assert.equal(res[1].order.orderNumber, "FW-00003");
    assert.equal(res[1].isActive, true);
    assert.equal(res[2].order.orderNumber, "FW-00002");
    assert.equal(res[2].isActive, false);
  });

  it("canRepeat = false si branch del pedido ≠ branch actual", () => {
    const res = combineOrders(serverOrders, localHistory, "neco");
    const fw00003 = res.find((r) => r.order.orderNumber === "FW-00003");
    assert.equal(fw00003.canRepeat, false); // branch "centro" ≠ "neco"
  });

  it("orden descendente por fecha dentro de cada grupo", () => {
    const res = combineOrders(serverOrders, localHistory, "neco");
    const active = res.filter((r) => r.isActive);
    const hist = res.filter((r) => !r.isActive);
    for (let i = 1; i < active.length; i++) {
      const prev = new Date(active[i - 1].order.createdAt).getTime();
      const cur = new Date(active[i].order.createdAt).getTime();
      assert.ok(prev >= cur);
    }
    for (let i = 1; i < hist.length; i++) {
      const prev = new Date(hist[i - 1].order.createdAt || hist[i - 1].order.date).getTime();
      const cur = new Date(hist[i].order.createdAt || hist[i].order.date).getTime();
      assert.ok(prev >= cur);
    }
  });

  it("server order sin local match: canRepeat = false", () => {
    const serverOnly = [
      {
        orderNumber: "FW-99999",
        status: "received",
        total: 5000,
        createdAt: now,
        branch: "neco",
        items: [],
      },
    ];
    const res = combineOrders(serverOnly, [], "neco");
    assert.equal(res[0].canRepeat, false);
  });
});
// ---------------------------------------------------------------------
// Clave de idempotencia del intento (clientRequestId).
//
// El server deduplica los reintentos por esta clave (server/order-idempotency.js):
// si vuelve la misma clave con el mismo contenido devuelve el pedido que ya
// guardó, y si el contenido cambió responde 409. Estas reglas fijan el lado del
// cliente, que es el que decide si un reintento es "el mismo pedido" (reutiliza
// la clave) o "otro pedido" (clave nueva). Si el frontend y la huella del server
// miraran datos distintos, un reintento legítimo caería en el 409.
// ---------------------------------------------------------------------
describe("newClientRequestId", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("devuelve un UUID v4 (el server valida el formato)", () => {
    for (let i = 0; i < 20; i++) {
      assert.match(newClientRequestId(), UUID_RE);
    }
  });

  it("dos claves nunca coinciden", () => {
    const ids = new Set();
    for (let i = 0; i < 200; i++) ids.add(newClientRequestId());
    assert.equal(ids.size, 200);
  });
});

describe("orderAttemptSignature", () => {
  const intento = {
    branch: "necochea",
    items: [{ productId: "wok-pollo", qty: 1, unitPrice: 18900, extras: [{ id: "salsa-fuerte", price: 500 }] }],
    orderMode: "delivery",
    address: "Calle 123",
    phone: "2262 555555",
    couponCode: "VERDE",
    paymentMethod: "efectivo",
  };

  it("es estable para el mismo pedido", () => {
    assert.equal(orderAttemptSignature(intento), orderAttemptSignature({ ...intento }));
  });

  it("cambia si cambia CUALQUIER cosa que define el pedido", () => {
    const base = orderAttemptSignature(intento);
    const cambios = [
      { branch: "tandil" },
      { orderMode: "pickup" },
      { paymentMethod: "mercadopago" },
      { address: "Calle 456" },
      { phone: "2262555556" },
      { couponCode: "OTRO" },
      { couponCode: "" },
      { items: [] },
      { items: [{ productId: "wok-pollo", qty: 2, unitPrice: 18900, extras: [{ id: "salsa-fuerte", price: 500 }] }] },
      { items: [{ productId: "wok-carne", qty: 1, unitPrice: 18900, extras: [{ id: "salsa-fuerte", price: 500 }] }] },
      { items: [{ productId: "wok-pollo", qty: 1, unitPrice: 18900, extras: [] }] },
    ];
    for (const cambio of cambios) {
      assert.notEqual(orderAttemptSignature({ ...intento, ...cambio }), base, JSON.stringify(cambio).slice(0, 70));
    }
  });

  it("normaliza lo que el server normaliza", () => {
    const base = orderAttemptSignature(intento);
    assert.equal(orderAttemptSignature({ ...intento, phone: "2262555555" }), base);
    assert.equal(orderAttemptSignature({ ...intento, couponCode: " verde " }), base);
    assert.equal(orderAttemptSignature({ ...intento, address: "  Calle 123 " }), base);
  });

  it("el mismo carrito en otro orden NO es otro pedido", () => {
    const items = [
      { productId: "wok-pollo", qty: 1, unitPrice: 18900, extras: [] },
      { productId: "arroz", qty: 2, unitPrice: 3000, extras: [] },
    ];
    assert.equal(
      orderAttemptSignature({ ...intento, items }),
      orderAttemptSignature({ ...intento, items: [...items].reverse() })
    );
  });

  it("aguanta un intento vacío o raro", () => {
    assert.equal(typeof orderAttemptSignature(), "string");
    assert.equal(orderAttemptSignature({ items: "no es un array" }), orderAttemptSignature({ items: [] }));
  });
});

describe("clientRequestIdFor", () => {
  const firma = orderAttemptSignature({ branch: "necochea", items: [{ productId: "wok-pollo", qty: 1, unitPrice: 18900 }] });

  it("el mismo intento REUSA la clave (si no, el reintento duplica el pedido)", () => {
    const primero = clientRequestIdFor(null, firma);
    const segundo = clientRequestIdFor(primero, firma);
    assert.equal(segundo.id, primero.id);
  });

  it("un intento con otro contenido arranca una clave nueva", () => {
    const primero = clientRequestIdFor(null, firma);
    const otraFirma = orderAttemptSignature({ branch: "necochea", items: [{ productId: "wok-carne", qty: 1, unitPrice: 21000 }] });
    const segundo = clientRequestIdFor(primero, otraFirma);
    assert.notEqual(segundo.id, primero.id);
    assert.equal(segundo.signature, otraFirma);
    // Y de ahí en adelante sigue siendo estable para ese intento.
    assert.equal(clientRequestIdFor(segundo, otraFirma).id, segundo.id);
  });

  it("descartar el intento (prev = null) genera una clave nueva", () => {
    const primero = clientRequestIdFor(null, firma);
    assert.notEqual(clientRequestIdFor(null, firma).id, primero.id);
  });
});

describe("isOrderRejected", () => {
  it("4xx = el server no creó nada → el próximo intento es un pedido nuevo", () => {
    for (const status of [400, 401, 409, 422, 429]) {
      assert.equal(isOrderRejected({ status }), true, String(status));
    }
  });

  it("red caída (status 0) o 5xx = puede que el pedido SÍ esté guardado → hay que reusar la clave", () => {
    // Si se descartara la clave en estos casos, el "Reintentar el pedido" crearía
    // el segundo pedido que este mecanismo existe para evitar.
    for (const status of [0, 500, 502, 503]) {
      assert.equal(isOrderRejected({ status }), false, String(status));
    }
    assert.equal(isOrderRejected({}), false);
    assert.equal(isOrderRejected(undefined), false);
  });
});
