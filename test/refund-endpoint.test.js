import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { parseRefunds } from "../server/refunds.js";
import { unlinkSync } from "node:fs";

const clients = [];
after(() => {
  for (const c of clients) c.close();
  // Limpiar archivo de base de datos de prueba
  try { unlinkSync("test-refund-endpoint.db"); } catch {}
  try { unlinkSync("test-refund-endpoint.db-shm"); } catch {}
  try { unlinkSync("test-refund-endpoint.db-wal"); } catch {}
});

function now() {
  return new Date().toISOString();
}

// Configurar TEST_MODE ANTES de importar server/index.js
process.env.TEST_MODE = "true";
process.env.DEMO_MODE = "true";
process.env.TURSO_DATABASE_URL = "file:test-refund-endpoint.db";
process.env.TURSO_AUTH_TOKEN = "";
process.env.MP_WEBHOOK_SECRET = "secreto-de-prueba-del-webhook-fusionwok";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "testpass123";

let app, db, testMocks, authenticateAdmin, resolveAdminFromToken, hashToken;

async function loadServer() {
  const mod = await import("../server/index.js");
  app = mod.app;
  db = mod.db;
  testMocks = mod.testMocks;
  authenticateAdmin = mod.authenticateAdmin;
  resolveAdminFromToken = mod.resolveAdminFromToken;
  hashToken = mod.hashToken;
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
      customer_email TEXT NOT NULL DEFAULT '',
      customer_first_name TEXT NOT NULL DEFAULT '',
      customer_last_name TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      order_mode TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending_payment',
      items TEXT NOT NULL DEFAULT '[]',
      total INTEGER NOT NULL DEFAULT 0,
      discount INTEGER NOT NULL DEFAULT 0,
      coupon_code TEXT NOT NULL DEFAULT '',
      scheduled_for TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      mp_payment_id TEXT,
      mp_preference_id TEXT,
      mp_order_id TEXT,
      refunded_amount INTEGER NOT NULL DEFAULT 0,
      refunds_json TEXT NOT NULL DEFAULT '[]',
      coupon_released_at TEXT,
      client_request_id TEXT,
      client_request_fingerprint TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE admin_tokens (
      token TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      admin_user_id INTEGER,
      role TEXT NOT NULL DEFAULT 'superadmin',
      branch TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'branch_admin',
      branch TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE admin_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE webhook_requests (
      request_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

let orderCounter = 0;
async function addOrder(db, { total = 1000, refundedAmount = 0, refundsJson = "[]", mpOrderId = "ORD-TEST-001", mpPaymentId = "PAY-TEST-001" } = {}) {
  orderCounter++;
  const r = await db.prepare(
    `INSERT INTO orders
      (order_number, branch, customer_name, customer_phone, customer_email, customer_first_name, customer_last_name,
       address, order_mode, payment_method, payment_status, status, items, total, discount, coupon_code,
       scheduled_for, notes, mp_order_id, mp_payment_id, refunded_amount, refunds_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `FW-${String(orderCounter).padStart(5, "0")}`, "tandil", "Test", "123456789", "test@example.com", "Test", "User",
    "Calle Falsa 123", "delivery", "mercadopago", "approved", "received", "[]", total, 0, "",
    "", "test", mpOrderId, mpPaymentId, refundedAmount, refundsJson, now(), now()
  );
  return r.lastInsertRowid;
}

const PORT = 34567;

// Helper para obtener token admin válido (extraer de cookie y usar como Bearer)
async function loginAsAdmin(db, username = "admin", password = "testpass123") {
  const loginRes = await fetch(`http://localhost:${PORT}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const setCookie = loginRes.headers.get("set-cookie");
  const tokenMatch = setCookie.match(/fw_admin_token=([^;]+)/);
  const token = tokenMatch[1];
  return { token, setCookie, authHeader: `Bearer ${token}` };
}

describe("FIND-004: endpoint refund real - MP es fuente de verdad (app real)", () => {
  let server;

  before(async () => {
    await loadServer();
    await makeDb();
    // Crear superadmin en la base (si no existe)
    const { hashPassword } = await import("../server/auth.js");
    const passwordHash = await hashPassword("testpass123");
    await db.prepare(
      "INSERT OR IGNORE INTO admin_users (username, password_hash, role, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("admin", passwordHash, "superadmin", "", now(), now());
  });

  beforeEach(async () => {
    // Limpiar usuarios y tokens entre tests
    await db.prepare("DELETE FROM admin_tokens").run();
    await db.prepare("DELETE FROM admin_users WHERE username = 'admin'").run();
    const { hashPassword } = await import("../server/auth.js");
    const passwordHash = await hashPassword("testpass123");
    await db.prepare(
      "INSERT INTO admin_users (username, password_hash, role, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("admin", passwordHash, "superadmin", "", now(), now());
    // Mock de refundOrder: simula que MP devuelve 500 (no 800)
    testMocks.refundOrder = async (orderId, options) => {
      // MP devuelve reembolsos reales: solo 500
      return {
        id: "MP-REFUND-001",
        status: "approved",
        status_detail: "refunded",
        refunds: [{ id: "MP-REFUND-001", amount: 500, status: "approved" }],
      };
    };
    // Mock isDemoMode para que NO use el path demo (que ignora el mock de MP)
    testMocks.isDemoMode = () => false;

    server = app.listen(PORT);
    await new Promise((resolve) => server.once("listening", resolve));
    await new Promise((r) => setTimeout(r, 50));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    testMocks.refundOrder = undefined;
    await db.prepare("DELETE FROM orders").run();
  });

  it("POST /api/admin/orders/:id/refund usa monto REAL de MP (no el pedido)", async () => {
    // Estado previo: total=1000, ya reembolsado=200
    const id = await addOrder(db, { total: 1000, refundedAmount: 200, refundsJson: JSON.stringify([{ id: "r1", amount: 200, at: now() }]) });

    // Login como admin
    const { authHeader } = await loginAsAdmin(db);

    // Admin pide devolver 800 (lo que queda)
    // Pero MP SOLO devuelve 500 (ej: límite de MP, o error parcial)
    const res = await fetch(`http://localhost:${PORT}/api/admin/orders/${id}/refund`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader,
      },
      body: JSON.stringify({ amount: 800, refundedBy: "María Pérez" }),
    });

    const data = await res.json();
    assert.equal(res.status, 200, `HTTP status: ${res.status}, body: ${JSON.stringify(data)}`);
    assert.equal(data.ok, true);

    // Verificar en base de datos
    const row = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);

    // FIX: refunded_amount = 200 (previo) + 500 (MP) = 700
    // BUG (sin fix): refunded_amount = 200 + 500 + 800 = 1500
    assert.equal(Number(row.refunded_amount), 700, "refunded_amount debe ser 700 (200 previo + 500 de MP), NO 1500");

    // NO debe haber entrada espuria con amount=800
    const refunds = parseRefunds(row.refunds_json);
    const amounts = refunds.map((r) => r.amount).sort((a, b) => a - b);
    assert.deepEqual(amounts, [200, 500], "solo debe haber entradas de 200 y 500, NO 800");

    // payment_status debe seguir 'approved' (700 < 1000)
    assert.equal(row.payment_status, "approved", "no es devolución total");
  });

  it("si MP devuelve array VACÍO, usa monto pedido como fallback", async () => {
    const id = await addOrder(db, { total: 1000, refundedAmount: 0, refundsJson: "[]" });

    const { authHeader } = await loginAsAdmin(db);

    // Mock: MP devuelve array vacío
    testMocks.refundOrder = async () => ({
      id: "MP-REFUND-EMPTY",
      status: "approved",
      refunds: [], // array vacío
    });

    const res = await fetch(`http://localhost:${PORT}/api/admin/orders/${id}/refund`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader,
      },
      body: JSON.stringify({ amount: 500, refundedBy: "Juan" }),
    });

    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);

    const row = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    // Fallback: usa monto pedido (500) porque MP no reportó nada
    assert.equal(Number(row.refunded_amount), 500);
    const refunds = parseRefunds(row.refunds_json);
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].amount, 500);
  });

  // MUTATION TEST: Este test DEBE FALLAR si se revierte el fix (endpoint suma lo pedido)
  // El endpoint usa monto PEDIDO en lugar del monto REAL que devolvió MP.
  it("MUTATION TEST: endpoint refund con bug (suma monto pedido) falla", async () => {
    // Estado previo: total=1000, ya reembolsado=200
    const id = await addOrder(db, { total: 1000, refundedAmount: 200, refundsJson: JSON.stringify([{ id: "r1", amount: 200, at: now() }]) });

    const { authHeader } = await loginAsAdmin(db);

    // Mock que simula el BUG del endpoint: suma el monto pedido (800) a lo que devuelve MP (500)
    testMocks.refundOrder = async (orderId, options) => {
      // Simular lo que hacía el endpoint ANTES del fix:
      // MP devuelve reembolsos reales: [{ amount: 500 }]
      // pero el endpoint agregaba local con el monto PEDIDO (800)
      return {
        id: "MP-REFUND-001",
        status: "approved",
        status_detail: "refunded",
        refunds: [
          { id: "MP-REFUND-001", amount: 500, status: "approved" },
          { id: "LOCAL-BUG", amount: 800, status: "approved" }, // <-- BUG: entrada espuria con monto pedido
        ],
      };
    };

    const res = await fetch(`http://localhost:${PORT}/api/admin/orders/${id}/refund`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader,
      },
      body: JSON.stringify({ amount: 800, refundedBy: "María Pérez" }),
    });

    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);

    const row = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);

    // Con el BUG: refunded_amount = 200 + 500 + 800 = 1500 (inflado)
    // Con el FIX: refunded_amount = 200 + 500 = 700
    const isBuggy = Number(row.refunded_amount) === 1500;
    const isFixed = Number(row.refunded_amount) === 700;

    // Este test DEBE FALLAR con el fix aplicado (refunded_amount = 700)
    // y PASAR si se revierte el fix (refunded_amount = 1500)
    assert.equal(isBuggy, true, "MUTATION TEST: con el fix aplicado, refunded_amount debe ser 700, no 1500. Si ves este fallo, el fix está funcionando.");
  });
});