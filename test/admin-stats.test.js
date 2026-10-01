import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { getStats } from "../server/admin-queries.js";

// ============================================================
// admin-queries.js — getStats con aislamiento por sucursal (T9).
//
// Reglas del dueño que este archivo fija:
//   - superadmin (scope null): shape IDÉNTICO al actual: venta
//     consolidada + desglose por local + analytics + tops.
//   - branch_admin: SOLO su venta (bruta/neta/devuelto/ticket/
//     pedidos/tops); SIN ventaTandil/ventaNecochea/... y SIN
//     analytics (visitas/pageViews/conversion/checkouts/
//     productosVistos), que quedan ocultos para el admin de
//     sucursal (decisión 3).
//
// La neta es bruto − devuelto, y lo devuelto se atribuye por
// sucursal: la devolución de la OTRA sucursal no puede restar.
// ============================================================

// DDL espejo de server/db.js. events.visitor_id en producción
// viene de un ensureColumn (línea 227 de db.js), no del CREATE.
async function makeDb() {
  const client = createClient({ url: "file::memory:" });
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

const FROM = "2026-01-01T00:00:00.000Z";
const TO = "2026-01-31T23:59:59.999Z";
let seq = 0;

async function addOrder(db, o = {}) {
  seq += 1;
  const ts = o.created_at || "2026-01-15T12:00:00.000Z";
  const r = await db
    .prepare(
      `INSERT INTO orders
        (order_number, branch, payment_status, status, items, total, refunded_amount, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
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

async function addEvent(db, type, visitorId = null) {
  await db
    .prepare("INSERT INTO events (type, branch, visitor_id, created_at) VALUES (?, ?, ?, ?)")
    .run(type, "tandil", visitorId, "2026-01-15T12:00:00.000Z");
}

// El mismo set de datos para superadmin y branch_admin: dos pedidos
// de tandil (uno con devolución parcial), uno aprobado y uno
// devuelto por completo de necochea.
async function seedBothBranches(db) {
  await addOrder(db, {
    branch: "tandil",
    total: 10000,
    items: [{ name: "Wok Pollo", unitPrice: 10000, qty: 2, extras: [] }],
  });
  await addOrder(db, { branch: "tandil", total: 20000, refunded: 3000 });
  await addOrder(db, {
    branch: "necochea",
    total: 15000,
    items: [{ name: "Bao", unitPrice: 5000, qty: 1, extras: [{ price: 500 }] }],
  });
  // Devolución TOTAL: pasa a payment_status 'refunded' → sale de la
  // venta (approved) pero su plata devuelta tiene que verse igual.
  await addOrder(db, { branch: "necochea", total: 5000, refunded: 5000, payment_status: "refunded" });
  await addEvent(db, "page_view", "v1");
  await addEvent(db, "page_view", "v2");
  await addEvent(db, "product_view", "v1");
  await addEvent(db, "checkout_started", "v2");
}

describe("getStats", () => {
  it("superadmin (scope null): shape completo, consolidado + por local + analytics", async () => {
    const db = await makeDb();
    await seedBothBranches(db);

    const s = await getStats(db, { fromIso: FROM, toIso: TO, scope: null });
    // Consolidado: 10000 + 20000 + 15000 (el refunded no es venta)
    assert.equal(s.ventaBruta, 45000);
    assert.equal(s.devuelto, 8000, "3000 de tandil + 5000 de necochea");
    assert.equal(s.ventaNeta, 37000);
    assert.equal(s.pedidos, 3);
    assert.equal(s.ticketPromedio, 12333, "round(37000 / 3)");
    // Desglose por local (las claves del otro local SÍ están acá)
    assert.equal(s.ventaTandilBruta, 30000);
    assert.equal(s.ventaTandil, 27000, "30000 − 3000 de SU devolución");
    assert.equal(s.ventaNecocheaBruta, 15000);
    assert.equal(s.ventaNecochea, 10000, "15000 − 5000");
    assert.equal(s.devueltoTandil, 3000);
    assert.equal(s.devueltoNecochea, 5000);
    // Analytics completo
    assert.equal(s.visitas, 2);
    assert.equal(s.pageViews, 2);
    assert.equal(s.productosVistos, 1);
    assert.equal(s.checkouts, 1);
    assert.equal(s.conversion, 150, "3 pedidos / 2 visitantes");
    // Tops con productos de ambas sucursales
    assert.equal(s.topSelling[0].name, "Wok Pollo");
    assert.ok(s.topSelling.some((p) => p.name === "Bao"), "el Bao de necochea también sale");
    assert.equal(s.topRevenue[0].revenue, 20000, "wok: 10000 × 2");
    assert.deepEqual(s.period, { from: FROM, to: TO });
  });

  it("branch_admin: SOLO su sucursal, sin claves del otro local ni analytics", async () => {
    const db = await makeDb();
    await seedBothBranches(db);

    const s = await getStats(db, { fromIso: FROM, toIso: TO, scope: "tandil" });
    assert.equal(s.ventaBruta, 30000, "solo tandil");
    assert.equal(s.devuelto, 3000, "la devolución de necochea no entra");
    assert.equal(s.ventaNeta, 27000, "neto = bruto − SU devuelto");
    assert.equal(s.pedidos, 2);
    assert.equal(s.ticketPromedio, 13500, "el ticket promedio es el de SU sucursal");

    // Tops solo con lo vendido en su sucursal
    assert.deepEqual(s.topSelling.map((p) => p.name), ["Wok Pollo"]);
    assert.deepEqual(s.topRevenue.map((p) => p.name), ["Wok Pollo"]);

    // Ni desglose por local (ya no tiene sentido) ni analytics
    const ausentes = [
      "ventaTandil",
      "ventaNecochea",
      "ventaTandilBruta",
      "ventaNecocheaBruta",
      "devueltoTandil",
      "devueltoNecochea",
      "visitas",
      "pageViews",
      "conversion",
      "checkouts",
      "productosVistos",
    ];
    for (const k of ausentes) {
      assert.ok(!(k in s), `la respuesta del branch_admin no puede tener "${k}"`);
    }
    // Y las que SÍ tienen que estar
    for (const k of ["ventaBruta", "ventaNeta", "devuelto", "ticketPromedio", "pedidos", "topSelling", "topRevenue", "period"]) {
      assert.ok(k in s, `"${k}" tiene que estar`);
    }
  });

  it("la devolución de la otra sucursal no resta de la neta del branch_admin", async () => {
    const db = await makeDb();
    await addOrder(db, { branch: "tandil", total: 12000 });
    await addOrder(db, { branch: "necochea", total: 99999, refunded: 99999, payment_status: "refunded" });

    const s = await getStats(db, { fromIso: FROM, toIso: TO, scope: "tandil" });
    assert.equal(s.ventaBruta, 12000);
    assert.equal(s.devuelto, 0);
    assert.equal(s.ventaNeta, 12000);
  });

  it("respeta el rango fromIso/toIso", async () => {
    const db = await makeDb();
    await addOrder(db, { branch: "tandil", total: 7000 });
    // Fuera de rango (febrero): no puede ni vender ni devolver
    await addOrder(db, { branch: "tandil", total: 9999, refunded: 9999, payment_status: "refunded", created_at: "2026-02-15T12:00:00.000Z" });
    await addOrder(db, { branch: "necochea", total: 8888, created_at: "2026-02-15T12:00:00.000Z" });

    const scoped = await getStats(db, { fromIso: FROM, toIso: TO, scope: "tandil" });
    assert.equal(scoped.ventaBruta, 7000);
    assert.equal(scoped.pedidos, 1);

    const full = await getStats(db, { fromIso: FROM, toIso: TO, scope: null });
    assert.equal(full.ventaBruta, 7000);
    assert.equal(full.pedidos, 1);
    assert.equal(full.devuelto, 0);
  });
});
