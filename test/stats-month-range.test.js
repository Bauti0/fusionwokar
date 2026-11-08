import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { getStats } from "../server/admin-queries.js";
import { periodRange } from "../src/utils/dates.js";

// ============================================================
// "Este mes" del panel admin contra la estadística real.
//
// La definición del rango vive en periodRange() del cliente y el
// server SOLO filtra por created_at entre from/to (ISO). El test
// siembra pedidos en SQLite en memoria y compara el resultado de
// getStats() usando el from/to de "Este mes":
//   - un pedido creado después de medianoche UTC (31/10 23:00 ARG =
//     1/11 en UTC) SI es parte de "Este mes" de octubre en Argentina;
//   - un pedido pendiente de pago no cuenta aunque esté en el rango;
//   - el borde del día 1 con rango corto no rompe ni divide por cero.
// ============================================================

// Cada createClient abre una conexión NATIVA de libsql: si no se cierra,
// el addon muere con 0xC0000005 al terminar el archivo (ver
// admin-stats.test.js). Se cierran todos en el after.
const clients = [];
after(() => {
  for (const c of clients) c.close();
});

// DDL espejo de server/db.js (mismas columnas que getStats consulta).
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

let seq = 0;
async function addOrder(db, { ts, total = 100, payment_status = "approved" } = {}) {
  seq += 1;
  await db
    .prepare(
      `INSERT INTO orders
        (order_number, branch, payment_status, status, items, total, refunded_amount, created_at, updated_at)
       VALUES (?, ?, ?, 'completed', '[]', ?, 0, ?, ?)`
    )
    .run(`FW-${String(seq).padStart(5, "0")}`, "necochea", payment_status, total, ts, ts);
}

describe('periodRange("month") → getStats: el total de "Este mes" son los pedidos de ese mes', () => {
  it('el total de "Este mes" de octubre 2026 cuenta solo los pedidos AR de octubre', async () => {
    // 15/10 12:00 ARG. "Este mes" arranca el 1/10 00:00 ARG = 03:00 UTC.
    const now = new Date("2026-10-15T15:00:00Z");
    const { from, to } = periodRange("month", null, null, now);

    const db = await makeDb();
    // Dentro del mes de octubre AR.
    await addOrder(db, { ts: "2026-10-05T12:00:00.000Z", total: 200 });
    await addOrder(db, { ts: "2026-10-10T00:30:00-03:00", total: 300 }); // 10/10 00:30 ARG
    // 30/09 23:59:59 ARG sale del rango aunque en UTC también sea septiembre.
    await addOrder(db, { ts: "2026-09-30T23:59:59-03:00", total: 999 });
    // Límite inferior exacto (1/10 00:00 ARG = 03:00Z): incluido.
    await addOrder(db, { ts: "2026-10-01T03:00:00.000Z", total: 1 });

    // Un pendiente dentro del rango no suma (getStats solo cuenta approved).
    await addOrder(db, { ts: "2026-10-07T12:00:00.000Z", payment_status: "pending", total: 500 });

    const stats = await getStats(db, {
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
      scope: null,
    });
    // 200 + 300 + 1: el 999 de septiembre y el pendiente quedan fuera.
    assert.equal(stats.pedidos, 3);
    assert.equal(stats.ventaBruta, 501);
    assert.equal(stats.ventaNeta, 501);
    // Con pedidos > 0 el ticket no toca división por cero.
    assert.equal(stats.ticketPromedio, Math.round(501 / 3));
  });

  it('el pedido de 31/10 23:00 ARG (ya 1/11 en UTC) entra en "Este mes" de octubre; uno posterior a ahora no', async () => {
    // now = 31/10 23:30 ARG = 2026-11-01T02:30Z.
    const now = new Date("2026-10-31T23:30:00-03:00");
    const { from, to } = periodRange("month", null, null, now);

    const db = await makeDb();
    // En UTC este pedido es "1 de noviembre", pero en Argentina son 31/10:
    // si el rango se calculara con UTC (from = 1/11), quedaría afuera acá.
    await addOrder(db, { ts: "2026-11-01T02:00:00.000Z", total: 777 }); // 31/10 23:00 ARG
    await addOrder(db, { ts: "2026-10-15T12:00:00.000Z", total: 100 });
    // Un minuto después de now: futuro, fuera del rango.
    await addOrder(db, { ts: "2026-11-01T02:31:00.000Z", total: 555 });

    const stats = await getStats(db, {
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
      scope: null,
    });
    // Solo el 777 del borde AR y el 100: el 555 es futuro.
    assert.equal(stats.pedidos, 2);
    assert.equal(stats.ventaBruta, 877);
  });

  it("día 1 con media hora de rango: sin pedidos no hay división por cero y no rompe", async () => {
    // 1/11 00:30 ARG: "Este mes" lleva media hora y está vacío.
    const now = new Date("2026-11-01T03:30:00Z");
    const { from } = periodRange("month", null, null, now);
    assert.ok(from.getTime() <= now.getTime());

    const db = await makeDb(); // sin pedidos
    const stats = await getStats(db, {
      fromIso: from.toISOString(),
      toIso: now.toISOString(),
      scope: null,
    });
    assert.equal(stats.pedidos, 0);
    assert.equal(stats.ventaBruta, 0);
    assert.equal(stats.ticketPromedio, 0); // pedidos > 0 evita el /0
  });
});
