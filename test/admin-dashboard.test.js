import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { getDashboard } from "../server/admin-queries.js";

// ============================================================
// admin-queries.js — getDashboard (resumen del día)
//
// Reglas del dueño que este archivo fija:
//   - neto = bruto − devuelto; cancelados y rechazados excluidos
//   - "hoy" = día calendario en America/Argentina/Buenos_Aires (UTC-3 fijo)
//   - branch_admin ve SOLO su sucursal (sin claves de la otra)
//   - superadmin recibe desglose porSucursal (tandil + necochea)
// ============================================================

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
      customer_name TEXT NOT NULL DEFAULT '',
      customer_phone TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending_payment',
      payment_method TEXT NOT NULL DEFAULT 'mercadopago',
      payment_status TEXT NOT NULL DEFAULT 'pending',
      items TEXT NOT NULL DEFAULT '[]',
      total INTEGER NOT NULL DEFAULT 0,
      refunded_amount INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      visitor_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

// Helper: ISO timestamp en zona Argentina para "hoy" a una hora dada (HH:mm)
// Usa una hora temprana (00:30) para garantizar que esté dentro del rango
// [medianoche ARG, now] sin importar cuándo corra el test.
function arTodayAt(hour = 0, minute = 30) {
  const now = new Date();
  const todayAr = now.toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
  return new Date(`${todayAr}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00-03:00`).toISOString();
}



// Helper: ayer a las 23:30 ARG (NO cuenta para "hoy")
function arYesterdayAt2330() {
  const now = new Date();
  const yesterdayAr = new Date(now.getTime() - 86400000).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
  return new Date(`${yesterdayAr}T23:30:00-03:00`).toISOString();
}

// Helper: hoy a las 00:30 ARG (SÍ cuenta para "hoy")
function arTodayAt0030() {
  return arTodayAt(0, 30);
}

let seq = 0;
async function addOrder(db, o = {}) {
  seq += 1;
  const ts = o.created_at || arTodayAt(12, 0);
  const r = await db.prepare(
    `INSERT INTO orders
      (order_number, branch, payment_status, status, items, total, refunded_amount, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `FW-${String(seq).padStart(5, "0")}`,
    o.branch || "tandil",
    o.payment_status || "approved",
    o.status || "completed",
    JSON.stringify(o.items || []),
    o.total ?? 10000,
    o.refunded ?? 0,
    ts,
    ts
  );
  return Number(r.lastInsertRowid);
}

describe("getDashboard — resumen del día", () => {
  it("neto = bruto − devuelto; cancelados y rechazados NO cuentan", async () => {
    const db = await makeDb();
    // Pedido aprobado hoy
    await addOrder(db, { branch: "tandil", total: 10000, created_at: arTodayAt() });
    // Pedido con devolución parcial hoy
    await addOrder(db, { branch: "tandil", total: 20000, refunded: 3000, created_at: arTodayAt() });
    // Cancelado hoy → NO cuenta
    await addOrder(db, { branch: "tandil", total: 5000, status: "cancelled", created_at: arTodayAt() });
    // Rechazado hoy → NO cuenta
    await addOrder(db, { branch: "tandil", total: 7000, payment_status: "rejected", created_at: arTodayAt() });
    // Devolución total (payment_status=refunded) → sale de venta, su plata se ve en devuelto
    await addOrder(db, { branch: "tandil", total: 9000, refunded: 9000, payment_status: "refunded", created_at: arTodayAt() });

    const d = await getDashboard(db, { scope: "tandil" });
    // Bruto: 10000 + 20000 = 30000 (solo approved + no cancelled)
    assert.equal(d.ventaBruta, 30000);
    // Devuelto: 3000 + 9000 = 12000
    assert.equal(d.devuelto, 12000);
    // Neto: 30000 - 12000 = 18000
    assert.equal(d.ventaNeta, 18000);
    // Pedidos: 2 (aprobados no cancelados)
    assert.equal(d.pedidos, 2);
    // Ticket: 18000 / 2 = 9000
    assert.equal(d.ticketPromedio, 9000);
  });

  it("borde medianoche ARG: 23:30 de ayer NO cuenta; 00:30 de hoy SÍ cuenta", async () => {
    const db = await makeDb();
    // Ayer 23:30 ARG → NO entra en "hoy"
    await addOrder(db, { branch: "tandil", total: 15000, created_at: arYesterdayAt2330() });
    // Hoy 00:30 ARG → SÍ entra
    await addOrder(db, { branch: "tandil", total: 20000, created_at: arTodayAt0030() });
    // Hoy 01:00 ARG → SÍ entra (temprano, seguro dentro del rango)
    await addOrder(db, { branch: "tandil", total: 10000, created_at: arTodayAt(1, 0) });

    const d = await getDashboard(db, { scope: "tandil" });
    // Solo los dos de hoy
    assert.equal(d.ventaBruta, 30000);
    assert.equal(d.pedidos, 2);
    assert.equal(d.ventaNeta, 30000);
  });

  it("branch_admin ve SOLO su sucursal (sin claves de la otra)", async () => {
    const db = await makeDb();
    await addOrder(db, {
      branch: "tandil", total: 12000, created_at: arTodayAt(),
      items: [{ name: "Wok Pollo", unitPrice: 12000, qty: 1, extras: [] }]
    });
    await addOrder(db, { branch: "necochea", total: 8000, created_at: arTodayAt() });
    await addOrder(db, { branch: "necochea", total: 5000, refunded: 5000, payment_status: "refunded", created_at: arTodayAt() });

    const d = await getDashboard(db, { scope: "tandil" });
    assert.equal(d.ventaBruta, 12000);
    assert.equal(d.pedidos, 1);
    assert.equal(d.ventaNeta, 12000);
    assert.equal(d.devuelto, 0);
    // No debe tener porSucursal
    assert.equal(d.porSucursal, null);
    // Producto más vendido solo de tandil
    assert.ok(d.productoMasVendido);
  });

  it("superadmin recibe desglose porSucursal (tandil + necochea)", async () => {
    const db = await makeDb();
    await addOrder(db, { branch: "tandil", total: 20000, refunded: 2000, created_at: arTodayAt() });
    await addOrder(db, { branch: "necochea", total: 15000, created_at: arTodayAt() });
    // Devolución total: payment_status='refunded' → NO entra en venta bruta (solo en devuelto)
    await addOrder(db, { branch: "necochea", total: 5000, refunded: 5000, payment_status: "refunded", created_at: arTodayAt() });

    const d = await getDashboard(db, { scope: null });
    // Consolidado: bruto = 20000 + 15000 = 35000 (el refunded no es 'approved')
    assert.equal(d.ventaBruta, 35000);
    assert.equal(d.devuelto, 7000);    // 2000 + 5000
    assert.equal(d.ventaNeta, 28000);
    assert.equal(d.pedidos, 2);

    // Por sucursal
    assert.ok(d.porSucursal);
    assert.equal(d.porSucursal.tandil.ventaBruta, 20000);
    assert.equal(d.porSucursal.tandil.devuelto, 2000);
    assert.equal(d.porSucursal.tandil.ventaNeta, 18000);
    assert.equal(d.porSucursal.tandil.pedidos, 1);

    assert.equal(d.porSucursal.necochea.ventaBruta, 15000);
    assert.equal(d.porSucursal.necochea.devuelto, 5000);
    assert.equal(d.porSucursal.necochea.ventaNeta, 10000);
    assert.equal(d.porSucursal.necochea.pedidos, 1);
  });

  it("pedidosPorEstado incluye todos los estados del día", async () => {
    const db = await makeDb();
    await addOrder(db, { branch: "tandil", total: 10000, status: "received", created_at: arTodayAt() });
    await addOrder(db, { branch: "tandil", total: 10000, status: "preparing", created_at: arTodayAt() });
    await addOrder(db, { branch: "tandil", total: 10000, status: "completed", created_at: arTodayAt() });
    await addOrder(db, { branch: "tandil", total: 10000, status: "cancelled", created_at: arTodayAt() });
    await addOrder(db, { branch: "tandil", total: 10000, status: "pending_payment", payment_status: "pending", created_at: arTodayAt() });

    const d = await getDashboard(db, { scope: "tandil" });
    assert.equal(d.pedidosPorEstado.received, 1);
    assert.equal(d.pedidosPorEstado.preparing, 1);
    assert.equal(d.pedidosPorEstado.completed, 1);
    assert.equal(d.pedidosPorEstado.cancelled, 1);
    assert.equal(d.pedidosPorEstado.pending_payment, 1);
    // Total 5 estados, pero pedidos confirmados = 3 (excluye cancelled y pending_payment con payment_status!=approved)
    assert.equal(d.pedidos, 3);
  });

  

  it("productoMasVendido es el de mayor cantidad del día", async () => {
    const db = await makeDb();
    // Wok Pollo x3
    await addOrder(db, {
      branch: "tandil", total: 30000, created_at: arTodayAt(),
      items: [{ name: "Wok Pollo", unitPrice: 10000, qty: 3, extras: [] }]
    });
    // Bao x1
    await addOrder(db, {
      branch: "tandil", total: 5000, created_at: arTodayAt(),
      items: [{ name: "Bao", unitPrice: 5000, qty: 1, extras: [] }]
    });

    const d = await getDashboard(db, { scope: "tandil" });
    assert.equal(d.productoMasVendido.name, "Wok Pollo");
    assert.equal(d.productoMasVendido.qty, 3);
    assert.equal(d.productoMasVendido.revenue, 30000);
  });
});