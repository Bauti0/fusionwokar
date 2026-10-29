import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Mock sessionStorage
const sessionStorageMock = (() => {
  let store = {};
  return {
    getItem: (key) => store[key] || null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: (key) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

// Mock localStorage
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: (key) => store[key] || null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: (key) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

global.sessionStorage = sessionStorageMock;
global.localStorage = localStorageMock;

// Copia de las funciones de caché (para testear sin React)
const CACHE_KEY = "fw.myOrdersCache";
const CACHE_TTL_MS = 2 * 60 * 1000;

function readCache(phone) {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { phone: cachedPhone, orders, timestamp } = JSON.parse(raw);
    if (cachedPhone !== phone) return null;
    if (Date.now() - timestamp > CACHE_TTL_MS) return null;
    return orders;
  } catch {
    return null;
  }
}

function writeCache(phone, orders) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ phone, orders, timestamp: Date.now() }));
  } catch { /* ignore */ }
}

function getStoredPhone() {
  try {
    const customer = JSON.parse(localStorage.getItem("fw.customer") || "null");
    if (customer?.phone) return { phone: customer.phone, source: "customer" };
  } catch { /* ignore */ }
  try {
    const lookup = localStorage.getItem("fw.lookupPhone");
    if (lookup) return { phone: lookup, source: "lookup" };
  } catch { /* ignore */ }
  return null;
}

describe("MyOrders cache utilities", () => {
  beforeEach(() => {
    sessionStorageMock.clear();
    localStorageMock.clear();
  });

  afterEach(() => {
    sessionStorageMock.clear();
    localStorageMock.clear();
  });

  describe("readCache / writeCache", () => {
    it("escribe y lee órdenes del caché", () => {
      const orders = [{ orderNumber: "FW-00001", total: 100 }];
      writeCache("2262555555", orders);
      const cached = readCache("2262555555");
      assert.deepEqual(cached, orders);
    });

    it("devuelve null si no hay caché", () => {
      assert.equal(readCache("2262555555"), null);
    });

    it("devuelve null si el teléfono no coincide", () => {
      writeCache("2262555555", [{ orderNumber: "FW-00001" }]);
      assert.equal(readCache("2262666666"), null);
    });

    it("devuelve null si expiró el TTL", () => {
      const orders = [{ orderNumber: "FW-00001" }];
      writeCache("2262555555", orders);
      // Manipular timestamp para que sea viejo
      const raw = sessionStorage.getItem(CACHE_KEY);
      const data = JSON.parse(raw);
      data.timestamp = Date.now() - CACHE_TTL_MS - 1000;
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
      assert.equal(readCache("2262555555"), null);
    });

    it("devuelve las órdenes si NO expiró el TTL", () => {
      const orders = [{ orderNumber: "FW-00001" }];
      writeCache("2262555555", orders);
      // Timestamp reciente
      const raw = sessionStorage.getItem(CACHE_KEY);
      const data = JSON.parse(raw);
      data.timestamp = Date.now() - 1000;
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
      assert.deepEqual(readCache("2262555555"), orders);
    });

    it("tolera JSON corrupto", () => {
      sessionStorage.setItem(CACHE_KEY, "no-es-json");
      assert.equal(readCache("2262555555"), null);
    });
  });

  describe("getStoredPhone", () => {
    it("devuelve teléfono de fw.customer si existe", () => {
      localStorage.setItem("fw.customer", JSON.stringify({ phone: "2262555555", name: "Juan" }));
      const result = getStoredPhone();
      assert.deepEqual(result, { phone: "2262555555", source: "customer" });
    });

    it("devuelve teléfono de fw.lookupPhone si no hay customer", () => {
      localStorage.setItem("fw.lookupPhone", "2262666666");
      const result = getStoredPhone();
      assert.deepEqual(result, { phone: "2262666666", source: "lookup" });
    });

    it("fw.customer tiene prioridad sobre fw.lookupPhone", () => {
      localStorage.setItem("fw.customer", JSON.stringify({ phone: "2262555555" }));
      localStorage.setItem("fw.lookupPhone", "2262666666");
      const result = getStoredPhone();
      assert.deepEqual(result, { phone: "2262555555", source: "customer" });
    });

    it("devuelve null si no hay ninguno", () => {
      assert.equal(getStoredPhone(), null);
    });

    it("tolera JSON corrupto en fw.customer", () => {
      localStorage.setItem("fw.customer", "no-es-json");
      localStorage.setItem("fw.lookupPhone", "2262666666");
      const result = getStoredPhone();
      assert.deepEqual(result, { phone: "2262666666", source: "lookup" });
    });
  });
});