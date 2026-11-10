// test/admin-unseen.test.js — Tests para GET /api/admin/orders/unseen
// Verifica el aislamiento por sucursal y el filtro del superadmin.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { getUnseenOrderIds } from "../server/admin-queries.js";
import { resolveAdminFromToken, hashPassword, hashToken } from "../server/auth.js";

// Copia local de adminScope (no exportado desde index.js)
function adminScope(req) {
  return req.admin?.role === "branch_admin" ? req.admin.branch : null;
}

// ============================================================
// Helper: crear server de prueba con BD aislada por test
// ============================================================
async function createTestServer() {
  const client = createClient({ url: "file::memory:" });
  const db = createDb(client);

  // DDL espejo de server/db.js (columnas necesarias para unseen)
  await db.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      branch TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      order_mode TEXT NOT NULL DEFAULT 'pickup',
      payment_method TEXT NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending_payment',
      items TEXT NOT NULL DEFAULT '[]',
      total INTEGER NOT NULL DEFAULT 0,
      coupon_code TEXT NOT NULL DEFAULT '',
      refunded_amount INTEGER NOT NULL DEFAULT 0,
      seen_at TEXT,
      scheduled_for TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      branch TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE admin_tokens (
      token TEXT PRIMARY KEY,
      admin_user_id INTEGER,
      created_at TEXT NOT NULL
    );
  `);

  // Insertar usuarios de prueba
  const hash = hashPassword("testpass123");
  await db.prepare(
    "INSERT INTO admin_users (username, password_hash, role, branch, active, created_at) VALUES (?, ?, ?, ?, 1, ?)"
  ).run("tandil_admin", hash, "branch_admin", "tandil", new Date().toISOString());
  await db.prepare(
    "INSERT INTO admin_users (username, password_hash, role, branch, active, created_at) VALUES (?, ?, ?, ?, 1, ?)"
  ).run("necochea_admin", hash, "branch_admin", "necochea", new Date().toISOString());

  // Superadmin token (admin_user_id = NULL) - FIND-008: guardado como hash
  await db.prepare(
    "INSERT INTO admin_tokens (token, admin_user_id, created_at) VALUES (?, NULL, ?)"
  ).run(hashToken("superadmin-token"), new Date().toISOString());

  // Branch admin tokens - FIND-008: guardados como hash
  const tandilUser = await db.prepare("SELECT id FROM admin_users WHERE username = ?").get("tandil_admin");
  const necocheaUser = await db.prepare("SELECT id FROM admin_users WHERE username = ?").get("necochea_admin");
  await db.prepare(
    "INSERT INTO admin_tokens (token, admin_user_id, created_at) VALUES (?, ?, ?)"
  ).run(hashToken("tandil-token"), tandilUser.id, new Date().toISOString());
  await db.prepare(
    "INSERT INTO admin_tokens (token, admin_user_id, created_at) VALUES (?, ?, ?)"
  ).run(hashToken("necochea-token"), necocheaUser.id, new Date().toISOString());

  // Crear app Express con las rutas necesarias
  const app = express();
  app.use(express.json());

  // Simular requireAdmin middleware
  const requireAdmin = async (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No autorizado" });
    }
    const token = auth.slice(7);
    const admin = await resolveAdminFromToken(db, token, { maxAgeMs: 1000 * 60 * 60 * 24 * 30 });
    if (admin.invalid || admin.expired) {
      return res.status(401).json({ error: "No autorizado" });
    }
    req.admin = admin;
    next();
  };

  // Endpoint /unseen
  app.get("/api/admin/orders/unseen", requireAdmin, async (req, res) => {
    try {
      const scope = adminScope(req); // string (branch) para branch_admin, null para superadmin
      if (scope) {
        // branch_admin: scope es su sucursal (string), ignora query param
        const ids = await getUnseenOrderIds(db, scope);
        return res.json({ ids });
      }
      // superadmin (scope === null): valida y usa ?branch=
      const rawBranch = typeof req.query.branch === "string" ? req.query.branch.trim().toLowerCase() : "";
      const validBranches = ["tandil", "necochea", "all", ""];
      if (!validBranches.includes(rawBranch)) {
        return res.status(400).json({ error: "Sucursal inválida" });
      }
      const branch = rawBranch === "all" || rawBranch === "" ? null : rawBranch;
      const ids = await getUnseenOrderIds(db, branch);
      res.json({ ids });
    } catch (err) {
      console.error("GET /api/admin/orders/unseen:", err.message);
      res.status(500).json({ error: "Error interno" });
    }
  });

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  async function addOrder(o = {}) {
    const ts = o.created_at || new Date().toISOString();
    const r = await db
      .prepare(
        `INSERT INTO orders
          (order_number, branch, customer_name, customer_phone, payment_method, payment_status, status, total, seen_at, scheduled_for, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `FW-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        o.branch || "tandil",
        o.customer_name || "Cliente",
        o.customer_phone ?? "2262480511",
        o.payment_method || "mercadopago",
        o.payment_status || "approved",
        o.status || "received",
        o.total ?? 10000,
        o.seen_at || null,
        o.scheduled_for || null,
        ts,
        ts
      );
    return Number(r.lastInsertRowid);
  }

  async function request(path, options = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    const data = await res.json();
    return { status: res.status, data };
  }

  return { baseUrl, db, client, server, addOrder, request };
}

describe("GET /api/admin/orders/unseen — aislamiento por sucursal", () => {
  it("branch_admin de tandil SOLO ve pedidos sin ver de tandil", async () => {
    const { client, server, addOrder, request } = await createTestServer();
    try {
      await addOrder({ branch: "tandil", status: "received", payment_status: "approved" });
      await addOrder({ branch: "tandil", status: "preparing", payment_status: "approved" });
      await addOrder({ branch: "necochea", status: "received", payment_status: "approved" });

      const { status, data } = await request("/api/admin/orders/unseen", {
        headers: { Authorization: "Bearer tandil-token" },
      });
      assert.equal(status, 200);
      assert.equal(data.ids.length, 2, "solo 2 pedidos de tandil");
    } finally {
      server.close();
      client.close();
    }
  });

  it("branch_admin de necochea NO ve pedidos de tandil", async () => {
    const { client, server, db, addOrder, request } = await createTestServer();
    try {
      await addOrder({ branch: "tandil", status: "received", payment_status: "approved" });
      await addOrder({ branch: "necochea", status: "received", payment_status: "approved" });

      const { status, data } = await request("/api/admin/orders/unseen", {
        headers: { Authorization: "Bearer necochea-token" },
      });
      assert.equal(status, 200);
      assert.equal(data.ids.length, 1, "solo ve el pedido de necochea");
      // Verificar que el ID corresponde a necochea
      const order = await db.prepare("SELECT branch FROM orders WHERE id = ?").get(data.ids[0]);
      assert.equal(order.branch, "necochea");
    } finally {
      server.close();
      client.close();
    }
  });

  it("superadmin SIN filtro ve TODOS los pedidos sin ver", async () => {
    const { client, server, addOrder, request } = await createTestServer();
    try {
      await addOrder({ branch: "tandil", status: "received", payment_status: "approved" });
      await addOrder({ branch: "necochea", status: "received", payment_status: "approved" });

      const { status, data } = await request("/api/admin/orders/unseen", {
        headers: { Authorization: "Bearer superadmin-token" },
      });
      assert.equal(status, 200);
      assert.equal(data.ids.length, 2, "superadmin ve ambos");
    } finally {
      server.close();
      client.close();
    }
  });

  it("superadmin con ?branch=tandil ve solo tandil", async () => {
    const { client, server, addOrder, request } = await createTestServer();
    try {
      await addOrder({ branch: "tandil", status: "received", payment_status: "approved" });
      await addOrder({ branch: "tandil", status: "preparing", payment_status: "approved" });
      await addOrder({ branch: "necochea", status: "received", payment_status: "approved" });

      const { status, data } = await request("/api/admin/orders/unseen?branch=tandil", {
        headers: { Authorization: "Bearer superadmin-token" },
      });
      assert.equal(status, 200);
      assert.equal(data.ids.length, 2, "solo tandil");
    } finally {
      server.close();
      client.close();
    }
  });

  it("superadmin con ?branch=necochea ve solo necochea", async () => {
    const { client, server, addOrder, request } = await createTestServer();
    try {
      await addOrder({ branch: "tandil", status: "received", payment_status: "approved" });
      await addOrder({ branch: "necochea", status: "received", payment_status: "approved" });
      await addOrder({ branch: "necochea", status: "preparing", payment_status: "approved" });

      const { status, data } = await request("/api/admin/orders/unseen?branch=necochea", {
        headers: { Authorization: "Bearer superadmin-token" },
      });
      assert.equal(status, 200);
      assert.equal(data.ids.length, 2, "solo necochea");
    } finally {
      server.close();
      client.close();
    }
  });

  it("superadmin con ?branch=all ve todos", async () => {
    const { client, server, addOrder, request } = await createTestServer();
    try {
      await addOrder({ branch: "tandil", status: "received", payment_status: "approved" });
      await addOrder({ branch: "necochea", status: "received", payment_status: "approved" });

      const { status, data } = await request("/api/admin/orders/unseen?branch=all", {
        headers: { Authorization: "Bearer superadmin-token" },
      });
      assert.equal(status, 200);
      assert.equal(data.ids.length, 2, "todos con branch=all");
    } finally {
      server.close();
      client.close();
    }
  });

  it("superadmin con branch inválido devuelve 400", async () => {
    const { client, server, request } = await createTestServer();
    try {
      const { status, data } = await request("/api/admin/orders/unseen?branch=invalida", {
        headers: { Authorization: "Bearer superadmin-token" },
      });
      assert.equal(status, 400);
      assert.equal(data.error, "Sucursal inválida");
    } finally {
      server.close();
      client.close();
    }
  });

  it("branch_admin ignora ?branch= del query (no puede filtrar la otra sucursal)", async () => {
    const { client, server, addOrder, request } = await createTestServer();
    try {
      await addOrder({ branch: "tandil", status: "received", payment_status: "approved" });
      await addOrder({ branch: "necochea", status: "received", payment_status: "approved" });

      // branch_admin de tandil intenta filtrar necochea
      const { status, data } = await request("/api/admin/orders/unseen?branch=necochea", {
        headers: { Authorization: "Bearer tandil-token" },
      });
      assert.equal(status, 200);
      assert.equal(data.ids.length, 1, "ignora el filtro y ve solo tandil");
    } finally {
      server.close();
      client.close();
    }
  });
});