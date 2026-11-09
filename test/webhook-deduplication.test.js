import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { verifyWebhookSignature } from "../server/mp.js";
import { createHmac } from "node:crypto";

// ============================================================
// FIND-001: Webhook request-id deduplication
//
// El webhook de Mercado Pago NO verificaba si un x-request-id
// ya había sido procesado. Un atacante podía reenviar la misma
// notificación (replay) y el server la procesaría de nuevo,
// potencialmente confirmando un pedido ya confirmado o
// aplicando una devolución dos veces.
//
// FLUJO CORREGIDO:
// 1. SELECT al entrar: si request_id existe → 200 (duplicado)
// 2. Procesar webhook
// 3. SOLO si procesa OK → INSERT OR IGNORE request_id
// 4. Si falla (500) → NO se inserta, reintento se procesará
// 5. Limpieza de >24h en intervalo aparte (no en cada request)
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

// Simula el flujo del handler: check duplicado → procesar → insert si OK
async function simularHandler(db, requestId, procesarOk) {
  // 1. Check duplicado (SELECT)
  const existing = await db.prepare("SELECT 1 FROM webhook_requests WHERE request_id = ?").get(requestId);
  if (existing) {
    return { status: 200, processed: false, reason: "duplicate" };
  }

  // 2. Procesar (simulado)
  if (!procesarOk) {
    return { status: 500, processed: false, reason: "error" };
  }

  // 3. INSERT OR IGNORE solo si OK
  await db.prepare("INSERT OR IGNORE INTO webhook_requests (request_id, created_at) VALUES (?, ?)").run(requestId, new Date().toISOString());
  return { status: 200, processed: true, reason: "ok" };
}

describe("FIND-001: webhook request-id deduplication (flujo corregido)", () => {
  let db;
  beforeEach(async () => {
    db = await makeDb();
    process.env.MP_WEBHOOK_SECRET = SECRET;
  });

  it("un webhook nuevo se procesa y registra el request-id", async () => {
    const requestId = "req-webhook-0001";

    // Verificar que no existe
    let row = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").get(requestId);
    assert.equal(row, undefined);

    // Simular procesamiento exitoso
    const result = await simularHandler(db, requestId, true);
    assert.equal(result.status, 200);
    assert.equal(result.processed, true);

    // Verificar que se insertó
    row = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").get(requestId);
    assert.ok(row, "request-id debe existir tras procesar OK");
  });

  it("un webhook que FALLA (500) NO registra el request-id, permitiendo reintento", async () => {
    const requestId = "req-webhook-fail";

    // Primer intento: falla
    const result1 = await simularHandler(db, requestId, false);
    assert.equal(result1.status, 500);
    assert.equal(result1.processed, false);

    // Verificar que NO se insertó
    let row = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").get(requestId);
    assert.equal(row, undefined, "request-id NO debe existir tras fallo");

    // Reintento con mismo request-id: debe procesarse
    const result2 = await simularHandler(db, requestId, true);
    assert.equal(result2.status, 200);
    assert.equal(result2.processed, true, "reintento debe procesarse");

    // Ahora sí debe existir
    row = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").get(requestId);
    assert.ok(row, "request-id debe existir tras reintento exitoso");
  });

  it("un webhook que procesó OK y se reenvía se descarta con 200 (duplicado)", async () => {
    const requestId = "req-webhook-dup";

    // Primer procesamiento exitoso
    const result1 = await simularHandler(db, requestId, true);
    assert.equal(result1.processed, true);

    // Reenvío con mismo request-id
    const result2 = await simularHandler(db, requestId, true);
    assert.equal(result2.status, 200);
    assert.equal(result2.processed, false, "no debe reprocesarse");
    assert.equal(result2.reason, "duplicate");
  });

  it("request-ids antiguos (más de 24h) se limpian y permiten reprocesar", async () => {
    const oldTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 horas atrás
    const requestId = "req-webhook-old";

    // Insertar request-id viejo
    await db.prepare("INSERT INTO webhook_requests (request_id, created_at) VALUES (?, ?)").run(requestId, oldTs);

    // Verificar que existe
    let row = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").get(requestId);
    assert.ok(row);

    // Limpiar request-ids antiguos (simula el intervalo de limpieza)
    const deleted = await db.prepare("DELETE FROM webhook_requests WHERE created_at < ?").run(
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    );
    assert.equal(deleted.changes, 1, "se borró el request-id viejo");

    // Ahora el request-id no existe, nuevo procesamiento debe funcionar
    row = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").get(requestId);
    assert.equal(row, undefined);

    const result = await simularHandler(db, requestId, true);
    assert.equal(result.processed, true, "debe procesarse tras limpieza");
  });

  it("sin request-id en el header la firma falla (request-id es parte del manifest)", async () => {
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

  it("INSERT OR IGNORE es idempotente: dos inserts seguidos no fallan", async () => {
    const requestId = "req-idempotent";

    // Primer insert
    await db.prepare("INSERT OR IGNORE INTO webhook_requests (request_id, created_at) VALUES (?, ?)").run(requestId, new Date().toISOString());
    // Segundo insert (mismo PK) → no falla, no duplica
    await db.prepare("INSERT OR IGNORE INTO webhook_requests (request_id, created_at) VALUES (?, ?)").run(requestId, new Date().toISOString());

    const rows = await db.prepare("SELECT * FROM webhook_requests WHERE request_id = ?").all(requestId);
    assert.equal(rows.length, 1, "solo debe haber una fila");
  });
});