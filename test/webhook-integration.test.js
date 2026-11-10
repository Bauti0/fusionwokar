import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { createHmac } from "node:crypto";

// Configurar TEST_MODE ANTES de importar server/index.js
// IMPORTANTE: En ESM los imports estáticos se ejecutan antes que el código,
// así que usamos import dinámico para que TEST_MODE surta efecto.
process.env.TEST_MODE = "true";
process.env.DEMO_MODE = "true";
// Usar SQLite local para tests (libSQL soporta file: protocol)
process.env.TURSO_DATABASE_URL = "file:test-webhook.db";
process.env.TURSO_AUTH_TOKEN = "";
process.env.MP_WEBHOOK_SECRET = "secreto-de-prueba-del-webhook-fusionwok";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "testpass123";

let app, db, testMocks, verifyWebhookSignature;

import { unlinkSync } from "node:fs";

const clients = [];
after(() => {
  for (const c of clients) c.close();
  // Limpiar archivo de base de datos de prueba
  try { unlinkSync("test-webhook.db"); } catch {}
  try { unlinkSync("test-webhook.db-shm"); } catch {}
  try { unlinkSync("test-webhook.db-wal"); } catch {}
});

async function loadServer() {
  const mod = await import("../server/index.js");
  app = mod.app;
  db = mod.db;
  testMocks = mod.testMocks;
  verifyWebhookSignature = mod.verifyWebhookSignature;
}

function now() {
  return new Date().toISOString();
}

const SECRET = "secreto-de-prueba-del-webhook-fusionwok";

function firmar({ secret = SECRET, dataId = "", requestId = "", ts } = {}) {
  const manifestDataId = dataId ? dataId.toLowerCase() : "";
  const manifest =
    (manifestDataId ? `id:${manifestDataId};` : "") +
    (requestId ? `request-id:${requestId};` : "") +
    `ts:${ts};`;
  const hmac = createHmac("sha256", secret).update(manifest).digest("hex");
  return `ts=${ts},v1=${hmac}`;
}

async function makeDb() {
  const client = createClient({ url: "file::memory:" });
  clients.push(client);
  const db = createDb(client);
  await db.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      branch TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending_payment',
      mp_order_id TEXT,
      mp_payment_id TEXT,
      items TEXT NOT NULL DEFAULT '[]',
      total INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );
    CREATE TABLE webhook_requests (
      request_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

async function addOrder(db, { mpOrderId = "ORD-TEST-001", mpPaymentId = "PAY-TEST-001", total = 1000, paymentStatus = "pending", status = "pending_payment" } = {}) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    `INSERT INTO orders
      (order_number, branch, customer_name, customer_phone, customer_email, customer_first_name, customer_last_name,
       address, order_mode, payment_method, payment_status, status, items, total, discount, coupon_code,
       scheduled_for, notes, source, shipping, shipping_km, shipping_pending,
       mp_order_id, mp_payment_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `FW-${Date.now()}`, "tandil", "Test", "123456789", "test@example.com", "Test", "User",
    "Calle Falsa 123", "delivery", "mercadopago", paymentStatus, status, "[]", total, 0, "",
    "", "test", "web", 0, 0, 0,
    mpOrderId, mpPaymentId, now, now
  );
  return r.lastInsertRowid;
}

describe("FIND-001: webhook request-id deduplication - HTTP integration (app real)", () => {
  let server;
  const PORT = 34569;

  before(async () => {
    await loadServer();
    // Crear tabla webhook_requests que no está en las migraciones del server
    await db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_requests (
        request_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
    `);
  });

  beforeEach(async () => {
    // Mock de getOrder que devuelve un order de MP con payment approved
    testMocks.getOrder = async (orderId) => ({
      id: orderId,
      externalReference: "FW-00001",
      payments: [{ id: "PAY-001", status: "approved", status_detail: "accredited" }],
      refunds: [],
      status: "processed",
      statusDetail: "accredited",
    });

    // Mock de applyMpOrderState por defecto (función real)
    testMocks.applyMpOrderState = undefined;

    server = app.listen(PORT);
    await new Promise((resolve) => server.once("listening", resolve));
    await new Promise((r) => setTimeout(r, 50));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    // Limpiar mocks
    testMocks.getOrder = undefined;
    testMocks.applyMpOrderState = undefined;
    // Limpiar tablas entre tests
    await db.prepare("DELETE FROM webhook_requests").run();
    await db.prepare("DELETE FROM orders").run();
  });

  it("POST /api/webhooks/mercadopago procesa webhook nuevo y registra request-id", async () => {
    const requestId = "req-webhook-0001";
    const mpOrderId = "ORD-TEST-001";
    const ts = String(Date.now());
    const signature = firmar({ dataId: mpOrderId, requestId, ts });

    await addOrder(db, { mpOrderId, paymentStatus: "pending", status: "pending_payment" });

    const res = await fetch(`http://localhost:${PORT}/api/webhooks/mercadopago?data.id=${encodeURIComponent(mpOrderId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": signature,
        "x-request-id": requestId,
      },
      body: JSON.stringify({ type: "order", data: { id: mpOrderId } }),
    });

    assert.equal(res.status, 200);

    // Verificar que se insertó el request-id
    const row = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").get(requestId);
    assert.ok(row, "request-id debe existir tras procesar OK");
  });

  it("POST /api/webhooks/mercadopago que FALLA (500) NO registra el request-id, permitiendo reintento", async () => {
    const requestId = "req-webhook-fail";
    const mpOrderId = "ORD-TEST-FAIL";
    const ts = String(Date.now());
    const signature = firmar({ dataId: mpOrderId, requestId, ts });

    await addOrder(db, { mpOrderId, paymentStatus: "pending", status: "pending_payment" });

    // Mock que falla en applyMpOrderState (lanza error)
    testMocks.applyMpOrderState = async () => {
      throw new Error("MP order processing failed");
    };

    // Primer intento: debe fallar (500)
    const res1 = await fetch(`http://localhost:${PORT}/api/webhooks/mercadopago?data.id=${encodeURIComponent(mpOrderId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": signature,
        "x-request-id": requestId,
      },
      body: JSON.stringify({ type: "order", data: { id: mpOrderId } }),
    });

    assert.equal(res1.status, 500, `Primer intento debe fallar con 500, got ${res1.status}`);

    // Verificar que NO se insertó el request-id (clave del fix FIND-001)
    let row = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").get(requestId);
    assert.equal(row, undefined, "request-id NO debe existir tras fallo (fix: INSERT después de OK)");
  });

  it("POST /api/webhooks/mercadopago duplicado con mismo request-id se descarta con 200", async () => {
    const requestId = "req-webhook-dup";
    const mpOrderId = "ORD-TEST-DUP";
    const ts = String(Date.now());
    const signature = firmar({ dataId: mpOrderId, requestId, ts });

    await addOrder(db, { mpOrderId, paymentStatus: "pending", status: "pending_payment" });

    // Primer procesamiento exitoso
    const res1 = await fetch(`http://localhost:${PORT}/api/webhooks/mercadopago?data.id=${encodeURIComponent(mpOrderId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": signature,
        "x-request-id": requestId,
      },
      body: JSON.stringify({ type: "order", data: { id: mpOrderId } }),
    });
    assert.equal(res1.status, 200);

    // Reenvío con mismo request-id
    const res2 = await fetch(`http://localhost:${PORT}/api/webhooks/mercadopago?data.id=${encodeURIComponent(mpOrderId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": signature,
        "x-request-id": requestId,
      },
      body: JSON.stringify({ type: "order", data: { id: mpOrderId } }),
    });
    assert.equal(res2.status, 200);

    // Verificar que solo hay un registro
    const rows = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").all(requestId);
    assert.equal(rows.length, 1, "solo debe haber un registro para el request-id duplicado");
  });

  // MUTATION TEST: Este test DEBE FALLAR si se revierte el fix (INSERT antes de procesar)
  // El test hace un POST HTTP real que falla, luego reintenta - con el fix correcto
  // el reintento debe procesarse; con el bug (INSERT antes) el reintento sería descartado.
  it("MUTATION TEST: POST HTTP que falla NO registra request-id, reintento procesa OK", async () => {
    const requestId = "req-mutation-http";
    const mpOrderId = "ORD-MUTATION";
    const ts = String(Date.now());
    const signature = firmar({ dataId: mpOrderId, requestId, ts });

    await addOrder(db, { mpOrderId, paymentStatus: "pending", status: "pending_payment" });

    // Mock que FALLA en el primer intento (simula error de MP)
    let attempt = 0;
    const originalApplyMpOrderState = testMocks.applyMpOrderState;
    testMocks.applyMpOrderState = async (row, mpOrder) => {
      attempt++;
      if (attempt === 1) {
        throw new Error("MP temporal failure");
      }
      // En el segundo intento, usar la implementación real (que está disponible en index.js)
      // Como no tenemos acceso directo, simulamos el éxito
      return { success: true };
    };

    // Primer intento: debe fallar (500)
    const res1 = await fetch(`http://localhost:${PORT}/api/webhooks/mercadopago?data.id=${encodeURIComponent(mpOrderId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": signature,
        "x-request-id": requestId,
      },
      body: JSON.stringify({ type: "order", data: { id: mpOrderId } }),
    });

    assert.equal(res1.status, 500, `Primer intento debe fallar con 500, got ${res1.status}`);

    // Verificar que NO se insertó el request-id (clave del fix)
    let row = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").get(requestId);
    assert.equal(row, undefined, "request-id NO debe existir tras fallo (fix: INSERT después de OK)");

    // Reintento con mismo request-id: debe procesarse OK (200)
    const res2 = await fetch(`http://localhost:${PORT}/api/webhooks/mercadopago?data.id=${encodeURIComponent(mpOrderId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": signature,
        "x-request-id": requestId,
      },
      body: JSON.stringify({ type: "order", data: { id: mpOrderId } }),
    });
    assert.equal(res2.status, 200, "Reintento debe procesarse OK");

    // Ahora sí debe existir el request-id
    row = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").get(requestId);
    assert.ok(row, "request-id debe existir tras reintento exitoso");
  });
});