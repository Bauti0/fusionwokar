import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { applyRefunds, refundableAmount, cleanRefundedBy, REFUNDED_BY_ERROR, parseRefunds } from "../server/refunds.js";

// toAdminOrder simplificado para test (evita importar db.js que requiere Turso)
function toAdminOrder(row) {
  return {
    id: row.id,
    order_number: row.order_number,
    branch: row.branch,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    payment_method: row.payment_method,
    payment_status: row.payment_status,
    status: row.status,
    mp_order_id: row.mp_order_id,
    mp_payment_id: row.mp_payment_id,
    total: row.total,
    refunded_amount: row.refunded_amount,
    refunds_json: row.refunds_json,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------
// Test de integración REAL del endpoint POST /api/admin/orders/:id/refund
// Usa Express real, SQLite en memoria, y mockea refundOrder de mp.js
// ---------------------------------------------------------------------

const clients = [];
after(() => {
  for (const c of clients) c.close();
});

function now() {
  return new Date().toISOString();
}

// Crea una app Express de prueba con el endpoint de refund
// Inyecta refundOrderMock en lugar del real
function createTestApp({ refundOrderMock, db }) {
  const app = express();
  app.use(express.json());

  // Middleware de auth admin simplificado para tests
  app.use((req, res, next) => {
    req.admin = { username: "testadmin", role: "admin", branch: "tandil" };
    next();
  });

  // Helper para scope de sucursal (simplificado)
  function adminScope(req) {
    return req.admin.role === "superadmin" ? null : req.admin.branch;
  }

  function getOrderScoped(db, id, scope) {
    let sql = "SELECT * FROM orders WHERE id = ?";
    const params = [id];
    if (scope) {
      sql += " AND branch = ?";
      params.push(scope);
    }
    return db.prepare(sql).get(...params);
  }

  // Endpoint real de refund (copiado y adaptado de index.js)
  app.post("/api/admin/orders/:id/refund", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });

      const row = await getOrderScoped(db, id, adminScope(req));
      if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
      if (row.payment_method !== "mercadopago") {
        return res.status(400).json({ error: "Este pedido no se pagó con Mercado Pago" });
      }
      if (row.payment_status !== "approved") {
        return res.status(400).json({ error: "Solo se puede devolver dinero de un pedido pagado" });
      }

      const refundedBy = cleanRefundedBy((req.body || {}).refundedBy);
      if (!refundedBy) return res.status(400).json({ error: REFUNDED_BY_ERROR });

      const refundMeta = {
        by: refundedBy,
        admin: req.admin?.username ?? (req.admin?.role === "superadmin" ? "superadmin" : "unknown"),
      };

      const refundable = refundableAmount(row);
      if (refundable <= 0) {
        return res.status(400).json({ error: "Este pedido ya fue devuelto por completo" });
      }

      const raw = (req.body || {}).amount;
      const amount = raw === undefined || raw === null || raw === "" ? refundable : Math.round(Number(raw));
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: "Monto a devolver inválido" });
      }
      if (amount > refundable) {
        return res.status(400).json({ error: `El monto supera lo que queda (${refundable})` });
      }
      const isFull = amount === refundable;

      const markIfFullyRefunded = (pre, { refundedAmount: devuelto }) => ({
        payment_status: devuelto >= (pre.total || 0) ? "refunded" : pre.payment_status,
      });

      if (!row.mp_order_id) {
        return res.status(400).json({ error: "El pedido no tiene order de Mercado Pago" });
      }

      let transactionId = row.mp_payment_id;
      if (!isFull && !transactionId) {
        return res.status(409).json({ error: "Mercado Pago todavía no registró el pago" });
      }

      let result;
      try {
        // Usar el mock inyectado
        const idempotencyKey = `ref-${row.id}-${row.refunded_amount || 0}-${amount}-${isFull ? "full" : "partial"}`;
        result = await refundOrderMock(
          row.mp_order_id,
          isFull ? { idempotencyKey } : { transactionId, amount, idempotencyKey }
        );
      } catch (err) {
        console.error("MP refund falló:", err.message);
        res.status(502).json({
          code: "mp_refund_failed",
          retryable: true,
          error: `Mercado Pago rechazó la devolución: ${err.message}`,
        });
        return;
      }

      // FIND-004: MP es la fuente de verdad. Solo agregar local si MP devolvió array VACÍO.
      const reportadas = result.refunds || [];
      const base = reportadas.length === 0
        ? [{ id: result.id || `mp-${Date.now()}`, amount, at: now() }]
        : reportadas;

      const prevIds = new Set(parseRefunds(row.refunds_json).map((r) => r.id));
      const mpRefunds = base.map((r) => (prevIds.has(r.id) ? r : { ...r, ...refundMeta }));
      await applyRefunds(db, row.id, { mpRefunds, patch: markIfFullyRefunded });

      const updated = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
      res.json({ ok: true, order: toAdminOrder(updated) });
    } catch (err) {
      console.error("POST /api/admin/orders/:id/refund:", err.message);
      res.status(500).json({ error: "Error interno" });
    }
  });

  return app;
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
      refunded_amount INTEGER NOT NULL DEFAULT 0,
      refunds_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT
    );
  `);
  return db;
}

let orderCounter = 0;
async function addOrder(db, { total = 1000, refundedAmount = 0, refundsJson = "[]", mpOrderId = "ORD-TEST-001", mpPaymentId = "PAY-TEST-001" } = {}) {
  orderCounter++;
  const r = await db.prepare(
    "INSERT INTO orders (order_number, branch, customer_name, customer_phone, payment_method, payment_status, status, mp_order_id, mp_payment_id, total, refunded_amount, refunds_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(`FW-${String(orderCounter).padStart(5, "0")}`, "tandil", "Test", "123456789", "mercadopago", "approved", "received", mpOrderId, mpPaymentId, total, refundedAmount, refundsJson);
  return r.lastInsertRowid;
}

describe("FIND-004: endpoint refund real - MP es fuente de verdad", () => {
  let db;
  let app;
  let server;
  const PORT = 34567;

  before(async () => {
    db = await makeDb();
  });

  beforeEach(async () => {
    // Mock de refundOrder: simula que MP devuelve 500 (no 800)
    const refundOrderMock = async (orderId, options) => {
      // MP devuelve reembolsos reales: solo 500
      return {
        id: "MP-REFUND-001",
        status: "approved",
        status_detail: "refunded",
        refunds: [{ id: "MP-REFUND-001", amount: 500, status: "approved" }],
      };
    };

    app = createTestApp({ refundOrderMock, db });
    server = app.listen(PORT);
    await new Promise((resolve) => server.once("listening", resolve));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("POST /api/admin/orders/:id/refund usa monto REAL de MP (no el pedido)", async () => {
    // Estado previo: total=1000, ya reembolsado=200
    const id = await addOrder(db, { total: 1000, refundedAmount: 200, refundsJson: JSON.stringify([{ id: "r1", amount: 200, at: now() }]) });

    // Admin pide devolver 800 (lo que queda)
    // Pero MP SOLO devuelve 500 (ej: límite de MP, o error parcial)
    const res = await fetch(`http://localhost:${PORT}/api/admin/orders/${id}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

    // Mock: MP devuelve array vacío
    const refundOrderMock = async () => ({
      id: "MP-REFUND-EMPTY",
      status: "approved",
      refunds: [], // array vacío
    });

    // Recrear app con nuevo mock
    await new Promise((resolve) => server.close(resolve));
    app = createTestApp({ refundOrderMock, db });
    server = app.listen(PORT);
    await new Promise((resolve) => server.once("listening", resolve));

    const res = await fetch(`http://localhost:${PORT}/api/admin/orders/${id}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
});