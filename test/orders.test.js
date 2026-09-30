import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  combineOrders,
  isActiveOrder,
  ACTIVE_STATUSES,
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