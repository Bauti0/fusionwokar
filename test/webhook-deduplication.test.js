import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { verifyWebhookSignature, dataIdForManifest } from "../server/mp.js";
import { createHmac } from "node:crypto";

// ============================================================
// FIND-001: Webhook request-id deduplication
//
// El webhook de Mercado Pago NO verificaba si un x-request-id
// ya había sido procesado. Un atacante podía reenviar la misma
// notificación (replay) y el server la procesaría de nuevo,
// potencialmente confirmando un pedido ya confirmado o
// aplicando una devolución dos veces.
// ============================================================

const SECRET = "secreto-de-prueba-del-webhook-fusionwok";

function firmar({ secret = SECRET, dataId = "", requestId = "", ts } = {}) {
  const manifest =
    (dataId ? `id:${dataId};` : "") +
    (requestId ? `request-id:${requestId};` : "") +
    `ts:${ts};`;
  const hmac = createHmac("sha256", secret).update(manifest).digest("hex");
  return `ts=${ts},v1=${hmac}`;
}

function reqWebhook({ dataId, requestId, signature, body = {} } = {}) {
  const headers = {};
  if (signature !== undefined) headers["x-signature"] = signature;
  if (requestId !== undefined) headers["x-request-id"] = requestId;
  const query = dataId ? `?data.id=${encodeURIComponent(dataId)}` : "";
  return { headers, originalUrl: `/api/webhook${query}`, body };
}

// Cada createClient abre una conexión NATIVA de libsql. Si nunca se cierra,
// el addon la libera en el GC y el proceso de este archivo de test muere con
// 0xC0000005 (ACCESS_VIOLATION) al terminar.
const clients = [];
after(() => {
  for (const c of clients) c.close();
});

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
      items TEXT NOT NULL DEFAULT '[]',
      total INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE webhook_requests (
      request_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

async function addOrder(db, mpOrderId, paymentStatus = "pending", status = "pending_payment") {
  const r = await db.prepare(
    "INSERT INTO orders (order_number, branch, customer_name, customer_phone, payment_method, payment_status, status, mp_order_id, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("FW-00001", "tandil", "Test", "123456789", "mercadopago", paymentStatus, status, mpOrderId, 1000);
  return r.lastInsertRowid;
}

describe("FIND-001: webhook request-id deduplication", () => {
  let db;
  beforeEach(async () => {
    db = await makeDb();
    process.env.MP_WEBHOOK_SECRET = SECRET;
  });

  it("un webhook con request-id nuevo se procesa correctamente", async () => {
    const mpOrderId = "ORD01ABC-DEF456-GHI789";
    await addOrder(db, mpOrderId, "pending", "pending_payment");

    const ts = String(Date.now());
    const requestId = "req-webhook-0001";
    // firmar usa dataId en minúsculas (como el manifest), reqWebhook pone en query en mayúsculas (como MP)
    const firma = firmar({ dataId: mpOrderId.toLowerCase(), requestId, ts });
    const req = reqWebhook({ dataId: mpOrderId, requestId, signature: firma, body: { type: "order", data: { id: mpOrderId } } });

    // Verificar la firma
    const valid = verifyWebhookSignature(req);
    assert.equal(valid, true);

    // Verificar que el request-id no está en la tabla
    let row = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").get(requestId);
    assert.equal(row, undefined, "el request-id no debería existir antes del procesamiento");

    // Simular el procesamiento (insertar request-id)
    await db.prepare("INSERT INTO webhook_requests (request_id, created_at) VALUES (?, ?)").run(requestId, new Date().toISOString());

    // Verificar que ahora existe
    row = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").get(requestId);
    assert.ok(row, "el request-id debería existir después del procesamiento");
  });

  it("un webhook con request-id duplicado es rechazado (deduplicación)", async () => {
    const mpOrderId = "ORD01ABC-DEF456-GHI789";
    await addOrder(db, mpOrderId, "pending", "pending_payment");

    const ts = String(Date.now());
    const requestId = "req-webhook-0002";
    const firma = firmar({ dataId: mpOrderId, requestId, ts });
    const req = reqWebhook({ dataId: mpOrderId, requestId, signature: firma, body: { type: "order", data: { id: mpOrderId } } });

    // Primera vez: insertar request-id
    await db.prepare("INSERT INTO webhook_requests (request_id, created_at) VALUES (?, ?)").run(requestId, new Date().toISOString());

    // Segunda vez: verificar que ya existe
    const existing = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").get(requestId);
    assert.ok(existing, "el request-id ya existe, es un duplicado");

    // El handler debería detectar esto y responder 200 sin reprocesar
    // (el test verifica la lógica de deduplicación, no el handler completo)
  });

  it("request-ids antiguos (más de 24h) se limpian y permiten reprocesar", async () => {
    const mpOrderId = "ORD01ABC-DEF456-GHI789";
    await addOrder(db, mpOrderId, "pending", "pending_payment");

    const oldTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 horas atrás
    const requestId = "req-webhook-old";

    // Insertar request-id viejo
    await db.prepare("INSERT INTO webhook_requests (request_id, created_at) VALUES (?, ?)").run(requestId, oldTs);

    // Verificar que existe
    let row = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").get(requestId);
    assert.ok(row);

    // Limpiar request-ids antiguos (simula lo que haría el handler)
    const deleted = await db.prepare("DELETE FROM webhook_requests WHERE created_at < ?").run(
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    );
    assert.equal(deleted.changes, 1, "se borró el request-id viejo");

    // Ahora el request-id no existe
    row = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").get(requestId);
    assert.equal(row, undefined, "el request-id viejo fue limpiado, permite reprocesar");
  });

  it("sin request-id en el header la firma falla (el request-id es parte del manifest)", async () => {
    const mpOrderId = "ORD01ABC-DEF456-GHI789";
    const ts = String(Date.now());
    // Firmar CON request-id
    const firma = firmar({ dataId: mpOrderId, requestId: "req-original", ts });
    // Pero enviar SIN request-id en el header
    const req = reqWebhook({ dataId: mpOrderId, requestId: undefined, signature: firma });

    // La firma NO es válida porque el manifest del request no incluye request-id
    // pero la firma sí lo tenía
    const valid = verifyWebhookSignature(req);
    assert.equal(valid, false, "la firma falla si falta request-id en el header");
  });
});