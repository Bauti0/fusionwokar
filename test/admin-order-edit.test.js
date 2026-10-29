import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { getOrderScoped, effectiveBranch } from "../server/admin-queries.js";

// ============================================================
// Editar pedido (admin) — tests contra SQLite en memoria (file::memory:).
// La lógica real (computeOrderEdits / getAuditLogs, en server/order-edit.js)
// se ejecuta de punta a punta: se calcula el resultado, se aplica el SQL
// devuelto sobre la memoria y se verifica la fila y la auditoría.
//
// shipping.js captura sus constantes AL IMPORTAR (franquicia, tarifa,
// ORS_API_KEY), igual que en shipping.test.js: por eso las env vars se fijan
// ANTES del import dinámico de abajo, para que la suite no dependa del
// entorno ni de ningún .env.
// ============================================================
process.env.ORS_API_KEY = "";
process.env.SHIPPING_FLAT_BLOCKS = "20";
process.env.SHIPPING_BASE_COST = "4000";
process.env.SHIPPING_PER_BLOCK = "100";
process.env.SHIPPING_BLOCK_METERS = "130";
process.env.SHIPPING_MAX_BLOCKS = "0"; // sin tope: ningún caso queda "fuera de zona"

const { computeOrderEdits, getAuditLogs } = await import("../server/order-edit.js");
const { computeShipping } = await import("../server/shipping.js");

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
      address TEXT NOT NULL DEFAULT '',
      order_mode TEXT NOT NULL DEFAULT 'pickup',
      payment_method TEXT NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending_payment',
      items TEXT NOT NULL DEFAULT '[]',
      total INTEGER NOT NULL DEFAULT 0,
      discount INTEGER NOT NULL DEFAULT 0,
      coupon_code TEXT NOT NULL DEFAULT '',
      shipping INTEGER NOT NULL DEFAULT 0,
      shipping_km INTEGER NOT NULL DEFAULT 0,
      shipping_pending INTEGER NOT NULL DEFAULT 0,
      mp_order_id TEXT,
      mp_payment_id TEXT,
      refunded_amount INTEGER NOT NULL DEFAULT 0,
      refunds_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE order_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      admin_user_id INTEGER,
      admin_username TEXT NOT NULL,
      admin_role TEXT NOT NULL,
      admin_branch TEXT NOT NULL DEFAULT '',
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      old_total INTEGER NOT NULL,
      new_total INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_order_audit_order ON order_audit_log(order_id);
    CREATE INDEX idx_order_audit_created ON order_audit_log(created_at);
  `);
  return db;
}

let seq = 0;
function iso(offsetMin = 0) {
  return new Date(Date.now() + offsetMin * 60000).toISOString();
}

async function addOrder(db, o = {}) {
  seq += 1;
  const ts = o.created_at || iso();
  const r = await db
    .prepare(
      `INSERT INTO orders
        (order_number, branch, customer_name, customer_phone, order_mode, payment_method, payment_status, status, total, shipping, shipping_km, shipping_pending, address, mp_order_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `FW-${String(seq).padStart(5, "0")}`,
      o.branch || "tandil",
      o.customer_name || "Cliente",
      o.customer_phone || "2262480511",
      o.order_mode || "pickup",
      o.payment_method || "efectivo",
      o.payment_status || "approved",
      o.status || "received",
      o.total ?? 10000,
      o.shipping ?? 0,
      o.shipping_km ?? 0,
      o.shipping_pending ?? 0,
      o.address || "",
      o.mp_order_id || null,
      ts,
      ts
    );
  return Number(r.lastInsertRowid);
}

async function getOrder(db, id) {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
}

// Aplica la auditoría igual que el endpoint (mismo INSERT).
async function insertarAuditoria(db, entries) {
  const st = db.prepare(`
    INSERT INTO order_audit_log
      (order_id, admin_user_id, admin_username, admin_role, admin_branch, field, old_value, new_value, old_total, new_total, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const a of entries) {
    await st.run(
      a.order_id,
      a.admin_user_id,
      a.admin_username,
      a.admin_role,
      a.admin_branch,
      a.field,
      a.old_value,
      a.new_value,
      a.old_total,
      a.new_total,
      a.created_at
    );
  }
}

const superadmin = { role: "superadmin", branch: "", userId: null, username: null };
const adminTandil = { role: "branch_admin", branch: "tandil", userId: 1, username: "tandil1" };

describe("getOrderScoped — aislamiento por sucursal (permiso de edición)", () => {
  it("branch_admin de tandil NO ve pedido de necochea (404)", async () => {
    const db = await makeDb();
    const idTandil = await addOrder(db, { branch: "tandil" });
    const idNecochea = await addOrder(db, { branch: "necochea" });

    assert.equal((await getOrderScoped(db, idTandil, "tandil"))?.id, idTandil);
    assert.equal(await getOrderScoped(db, idNecochea, "tandil"), null, "ajeno → null (404 sin confirmar existencia)");
    assert.equal((await getOrderScoped(db, idNecochea, null))?.id, idNecochea, "superadmin ve ambos");
  });

  it("branch_admin de necochea edita SU pedido", async () => {
    const db = await makeDb();
    const idNecochea = await addOrder(db, { branch: "necochea" });
    const row = await getOrderScoped(db, idNecochea, "necochea");
    assert.equal(row?.id, idNecochea);
  });

  it("superadmin edita pedido de cualquier sucursal", async () => {
    const db = await makeDb();
    const idT = await addOrder(db, { branch: "tandil" });
    const idN = await addOrder(db, { branch: "necochea" });
    assert.equal((await getOrderScoped(db, idT, null))?.id, idT);
    assert.equal((await getOrderScoped(db, idN, null))?.id, idN);
  });
});

describe("effectiveBranch — sucursal efectiva para edición", () => {
  it("branch_admin: SIEMPRE su sucursal, ignora body", () => {
    const admin = { role: "branch_admin", branch: "tandil" };
    assert.deepEqual(effectiveBranch(admin, "necochea"), { branch: "tandil" });
  });
  it("superadmin: elige sucursal válida", () => {
    const admin = { role: "superadmin", branch: "" };
    assert.deepEqual(effectiveBranch(admin, "necochea"), { branch: "necochea" });
    assert.deepEqual(effectiveBranch(admin, "tandil"), { branch: "tandil" });
    assert.ok(effectiveBranch(admin, "inventada").error);
  });
});

describe("computeOrderEdits — delivery → pickup", () => {
  it("resta el envío guardado y deja shipping, shipping_km y address en 0/vacío", async () => {
    const db = await makeDb();
    const id = await addOrder(db, {
      branch: "tandil",
      order_mode: "delivery",
      address: "Calle 123 456",
      shipping: 4000,
      shipping_km: 20,
      shipping_pending: 1,
      total: 14000,
    });
    const row = await getOrder(db, id);

    const result = await computeOrderEdits(row, { orderMode: "pickup" }, adminTandil, iso);
    assert.ok(!result.error, result.error?.message);
    await db.prepare(result.sql).run(...result.values);
    await insertarAuditoria(db, result.auditEntries);

    const upd = await getOrder(db, id);
    assert.equal(upd.order_mode, "pickup");
    assert.equal(upd.shipping, 0, "el envío guardado queda en 0");
    assert.equal(upd.shipping_km, 0, "las cuadras quedan en 0");
    assert.equal(upd.shipping_pending, 0, "ya no hay envío pendiente de cálculo");
    assert.equal(upd.address, "", "la dirección se vacía (queda registrada en auditoría)");
    assert.equal(upd.total, 10000, "14000 - 4000 de envío");

    // Auditoría: un registro por campo, con totales viejo y nuevo.
    assert.equal(result.auditEntries.length, 3);
    const audit = await db.prepare("SELECT * FROM order_audit_log WHERE order_id = ? ORDER BY id").all(id);
    assert.deepEqual(audit.map((a) => a.field), ["orderMode", "address", "shipping"]);
    assert.equal(audit[0].old_value, "delivery");
    assert.equal(audit[0].new_value, "pickup");
    assert.equal(audit[1].old_value, "Calle 123 456");
    assert.equal(audit[1].new_value, "");
    assert.equal(audit[2].old_value, "4000");
    assert.equal(audit[2].new_value, "0");
    assert.equal(audit[0].old_total, 14000);
    assert.equal(audit[0].new_total, 10000);
    assert.equal(audit[0].admin_username, "tandil1");
    assert.equal(audit[0].admin_role, "branch_admin");
    assert.equal(audit[0].admin_branch, "tandil");
  });
});

describe("computeOrderEdits — pickup → delivery", () => {
  it("con envío manual en Tandil: usa el costo, lo suma al total y estima cuadras", async () => {
    const db = await makeDb();
    const id = await addOrder(db, { branch: "tandil", order_mode: "pickup", total: 10000 });
    const row = await getOrder(db, id);

    const result = await computeOrderEdits(
      row,
      { orderMode: "delivery", address: "Av. 12 345", shippingCost: 5000 },
      superadmin,
      iso
    );
    assert.ok(!result.error, result.error?.message);
    await db.prepare(result.sql).run(...result.values);
    await insertarAuditoria(db, result.auditEntries);

    const upd = await getOrder(db, id);
    assert.equal(upd.order_mode, "delivery");
    assert.equal(upd.address, "Av. 12 345");
    assert.equal(upd.shipping, 5000, "prevalece el costo manual");
    // 5000 > base 4000 → 20 cuadras de franquicia + ceil(1000/100) = 30
    assert.equal(upd.shipping_km, 30);
    assert.equal(upd.total, 15000, "10000 + 5000 de envío");

    const audit = await db.prepare("SELECT field FROM order_audit_log WHERE order_id = ? ORDER BY id").all(id);
    assert.deepEqual(audit.map((a) => a.field), ["orderMode", "address", "shipping"]);
  });

  it("con envío manual en Necochea (sin cálculo automático): funciona con el costo a mano", async () => {
    const db = await makeDb();
    const id = await addOrder(db, { branch: "necochea", order_mode: "pickup", total: 8000 });
    const row = await getOrder(db, id);

    const result = await computeOrderEdits(
      row,
      { orderMode: "delivery", address: "Calle 5 678", shippingCost: 3000 },
      superadmin,
      iso
    );
    assert.ok(!result.error, result.error?.message);
    await db.prepare(result.sql).run(...result.values);

    const upd = await getOrder(db, id);
    assert.equal(upd.order_mode, "delivery");
    assert.equal(upd.shipping, 3000);
    assert.equal(upd.shipping_km, 0, "Necochea no estima cuadras");
    assert.equal(upd.total, 11000, "8000 + 3000 de envío");
  });

  it("en Tandil con envío calculado (red mockeada): $4.000 fijos, 10 cuadras", async (t) => {
    // La red se mockea POR COMPLETO: ningún test sale a internet. OJO: este
    // caso tarda ~2,4 s reales porque shipping.js espacia las llamadas
    // externas con un throttle de 1,2 s (geocoder destino + origen + router).
    t.mock.method(globalThis, "fetch", async (url) => {
      const u = String(url);
      const json = (obj) => ({ ok: true, status: 200, json: async () => obj });
      if (u.includes("nominatim")) return json([{ lat: "-37.32154", lon: "-59.13024" }]);
      if (u.includes("project-osrm")) return json({ routes: [{ distance: 1300 }] }); // 1,3 km = 10 cuadras
      throw new Error(`El mock no sabe responder esta URL: ${u}`);
    });

    const db = await makeDb();
    const id = await addOrder(db, { branch: "tandil", order_mode: "pickup", total: 10000 });
    const row = await getOrder(db, id);

    const result = await computeOrderEdits(row, { orderMode: "delivery", address: "Alvear 1000" }, superadmin, iso);
    assert.ok(!result.error, result.error?.message);
    assert.equal(result.newValues.shipping, 4000, "10 cuadras ≤ 20 → tarifa fija");
    assert.equal(result.newValues.shippingKm, 10);
    assert.equal(result.newValues.total, 14000);

    await db.prepare(result.sql).run(...result.values);
    const upd = await getOrder(db, id);
    assert.equal(upd.order_mode, "delivery");
    assert.equal(upd.shipping, 4000);
    assert.equal(upd.total, 14000);
    assert.equal(upd.address, "Alvear 1000");
  });

  it("sin dirección → 400 con mensaje claro (no 500)", async () => {
    const db = await makeDb();
    const id = await addOrder(db, { branch: "tandil", order_mode: "pickup", total: 10000 });
    const row = await getOrder(db, id);

    const result = await computeOrderEdits(row, { orderMode: "delivery" }, superadmin, iso);
    assert.equal(result.error?.status, 400);
    assert.match(result.error.message, /dirección/i);
    assert.equal((await getOrder(db, id)).order_mode, "pickup", "no se tocó la fila");
  });

  it("Necochea sin envío manual → 400 pidiendo shippingCost", async () => {
    const db = await makeDb();
    const id = await addOrder(db, { branch: "necochea", order_mode: "pickup", total: 8000 });
    const row = await getOrder(db, id);

    const result = await computeOrderEdits(
      row,
      { orderMode: "delivery", address: "Calle 5 678" },
      superadmin,
      iso
    );
    assert.equal(result.error?.status, 400);
    assert.match(result.error.message, /shippingCost/);
    assert.equal((await getOrder(db, id)).order_mode, "pickup", "no se tocó la fila");
  });
});

describe("computeOrderEdits — shippingCost inválido", () => {
  it("negativo → 400", async () => {
    const db = await makeDb();
    const id = await addOrder(db, { branch: "tandil", order_mode: "delivery", shipping: 4000, shipping_km: 20, total: 14000 });
    const row = await getOrder(db, id);

    const result = await computeOrderEdits(row, { shippingCost: -500 }, superadmin, iso);
    assert.equal(result.error?.status, 400);
    assert.match(result.error.message, /shippingCost/);
    assert.equal((await getOrder(db, id)).total, 14000, "no se tocó la fila");
  });

  it("no numérico (string) → 400", async () => {
    const db = await makeDb();
    const id = await addOrder(db, { branch: "tandil", order_mode: "delivery", shipping: 4000, total: 14000 });
    const row = await getOrder(db, id);

    const result = await computeOrderEdits(row, { shippingCost: "3000" }, superadmin, iso);
    assert.equal(result.error?.status, 400);
    assert.match(result.error.message, /shippingCost/);
  });

  it("override manual en delivery: ajusta envío, cuadras y total", async () => {
    const db = await makeDb();
    const id = await addOrder(db, { branch: "tandil", order_mode: "delivery", shipping: 4000, shipping_km: 20, total: 14000 });
    const row = await getOrder(db, id);

    const result = await computeOrderEdits(row, { shippingCost: 5000 }, superadmin, iso);
    assert.ok(!result.error, result.error?.message);
    await db.prepare(result.sql).run(...result.values);
    await insertarAuditoria(db, result.auditEntries);

    const upd = await getOrder(db, id);
    assert.equal(upd.shipping, 5000);
    assert.equal(upd.shipping_km, 30, "20 de franquicia + 10 extra");
    assert.equal(upd.total, 15000, "14000 - 4000 + 5000");

    const audit = await db.prepare("SELECT * FROM order_audit_log WHERE order_id = ?").all(id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].field, "shipping");
    assert.equal(audit[0].old_total, 14000);
    assert.equal(audit[0].new_total, 15000);
  });
});

describe("computeOrderEdits — no-op", () => {
  it("valor igual al guardado: noop, sin SQL y sin auditoría", async () => {
    const db = await makeDb();
    const id = await addOrder(db, { branch: "tandil", order_mode: "delivery", payment_method: "efectivo", total: 10000 });
    const row = await getOrder(db, id);
    const antes = await getOrder(db, id);

    const result = await computeOrderEdits(row, { paymentMethod: "efectivo", shippingCost: 0 }, superadmin, iso);
    assert.equal(result.noop, true, "debe devolver noop");
    assert.equal(result.sql, undefined, "no debe construir UPDATE");
    assert.ok(!result.auditEntries?.length, "no debe generar auditoría");

    // El endpoint responde 200 antes de tocar la BD: nada cambia y no se
    // inserta ninguna fila en order_audit_log.
    const audit = await db.prepare("SELECT COUNT(*) AS c FROM order_audit_log").get();
    assert.equal(audit.c, 0);
    const despues = await getOrder(db, id);
    assert.deepEqual(despues, antes, "la fila queda idéntica");
  });
});

describe("computeOrderEdits — medio de pago", () => {
  it("MP pendiente → efectivo en pedido pendiente: approved + received", async () => {
    const db = await makeDb();
    const id = await addOrder(db, {
      branch: "tandil",
      payment_method: "mercadopago",
      payment_status: "pending",
      status: "pending_payment",
      mp_order_id: "mp-123",
      total: 10000,
    });
    const row = await getOrder(db, id);

    const result = await computeOrderEdits(row, { paymentMethod: "efectivo" }, superadmin, iso);
    assert.ok(!result.error, result.error?.message);
    await db.prepare(result.sql).run(...result.values);
    await insertarAuditoria(db, result.auditEntries);

    const upd = await getOrder(db, id);
    assert.equal(upd.payment_method, "efectivo");
    assert.equal(upd.payment_status, "approved");
    assert.equal(upd.status, "received", "pending_payment pasa a received");
    assert.equal(upd.mp_order_id, "mp-123", "el id de MP queda para trazabilidad");
    const audit = await db.prepare("SELECT * FROM order_audit_log WHERE order_id = ?").all(id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].field, "paymentMethod");
    assert.equal(audit[0].old_value, "mercadopago");
    assert.equal(audit[0].new_value, "efectivo");
  });

  it("cambiar el pago de un pedido YA ENTREGADO no lo reabre", async () => {
    const db = await makeDb();
    const id = await addOrder(db, {
      branch: "tandil",
      payment_method: "mercadopago",
      payment_status: "pending",
      status: "completed",
      total: 10000,
    });
    const row = await getOrder(db, id);

    const result = await computeOrderEdits(row, { paymentMethod: "efectivo" }, superadmin, iso);
    assert.ok(!result.error, result.error?.message);
    await db.prepare(result.sql).run(...result.values);

    const upd = await getOrder(db, id);
    assert.equal(upd.payment_method, "efectivo");
    assert.equal(upd.payment_status, "approved");
    assert.equal(upd.status, "completed", "el status NO vuelve a received: el pedido sigue entregado");
  });

  it("efectivo → transferencia: cambia solo el medio, el status no se mueve", async () => {
    const db = await makeDb();
    const id = await addOrder(db, { branch: "tandil", payment_method: "efectivo", payment_status: "approved", status: "received", total: 10000 });
    const row = await getOrder(db, id);

    const result = await computeOrderEdits(row, { paymentMethod: "transferencia" }, superadmin, iso);
    assert.ok(!result.error, result.error?.message);
    await db.prepare(result.sql).run(...result.values);

    const upd = await getOrder(db, id);
    assert.equal(upd.payment_method, "transferencia");
    assert.equal(upd.payment_status, "approved");
    assert.equal(upd.status, "received");
  });

  it("cambio A mercadopago → 400 con mensaje claro", async () => {
    const db = await makeDb();
    const id = await addOrder(db, { branch: "tandil", payment_method: "efectivo", payment_status: "approved", status: "received", total: 10000 });
    const row = await getOrder(db, id);

    const result = await computeOrderEdits(row, { paymentMethod: "mercadopago" }, superadmin, iso);
    assert.equal(result.error?.status, 400);
    assert.match(result.error.message, /No se puede cambiar a MercadoPago/);
    assert.equal((await getOrder(db, id)).payment_method, "efectivo", "no se tocó la fila");
  });
});

describe("computeOrderEdits — bloqueos", () => {
  it("MP aprobado: cualquier edición se bloquea con 400", async () => {
    const db = await makeDb();
    const id = await addOrder(db, {
      branch: "tandil",
      payment_method: "mercadopago",
      payment_status: "approved",
      status: "received",
      mp_order_id: "mp-123",
      total: 10000,
    });
    const row = await getOrder(db, id);

    const result = await computeOrderEdits(row, { paymentMethod: "efectivo" }, superadmin, iso);
    assert.equal(result.error?.status, 400);
    assert.match(result.error.message, /pagó online con MercadoPago/);
    assert.equal((await getOrder(db, id)).payment_method, "mercadopago");
  });

  it("pedido cancelado: no se edita", async () => {
    const db = await makeDb();
    const id = await addOrder(db, { branch: "tandil", status: "cancelled", total: 10000 });
    const row = await getOrder(db, id);

    const result = await computeOrderEdits(row, { orderMode: "pickup" }, superadmin, iso);
    assert.equal(result.error?.status, 400);
    assert.match(result.error.message, /cancelado/i);
  });
});

describe("getAuditLogs — permisos de lectura", () => {
  it("branch_admin recibe 403 aunque el pedido sea de SU sucursal", async () => {
    const db = await makeDb();
    const id = await addOrder(db, { branch: "tandil" });
    const result = await getAuditLogs(db, adminTandil, id);
    assert.equal(result.error?.status, 403);
    assert.match(result.error.message, /auditoría/);
    assert.equal(result.logs, undefined);
  });

  it("superadmin lee la auditoría de cualquier sucursal", async () => {
    const db = await makeDb();
    const id = await addOrder(db, { branch: "necochea" });
    await insertarAuditoria(db, [
      {
        order_id: id,
        admin_user_id: null,
        admin_username: "superadmin",
        admin_role: "superadmin",
        admin_branch: "",
        field: "orderMode",
        old_value: "delivery",
        new_value: "pickup",
        old_total: 14000,
        new_total: 10000,
        created_at: iso(-5),
      },
      {
        order_id: id,
        admin_user_id: 2,
        admin_username: "neco1",
        admin_role: "branch_admin",
        admin_branch: "necochea",
        field: "shipping",
        old_value: "4000",
        new_value: "0",
        old_total: 14000,
        new_total: 10000,
        created_at: iso(0),
      },
    ]);

    const result = await getAuditLogs(db, superadmin, id);
    assert.ok(!result.error, result.error?.message);
    assert.equal(result.logs.length, 2);
    assert.equal(result.logs[0].field, "shipping", "más reciente primero");
    assert.equal(result.logs[1].field, "orderMode");
    assert.equal(result.logs[1].admin_username, "superadmin");
  });

  it("pedido inexistente → 404", async () => {
    const db = await makeDb();
    const result = await getAuditLogs(db, superadmin, 999);
    assert.equal(result.error?.status, 404);
  });
});

describe("order_audit_log — tabla", () => {
  it("se crea la tabla y los índices", async () => {
    const db = await makeDb();
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='order_audit_log'").all();
    assert.equal(tables.length, 1);
    const idx = await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_order_audit%'").all();
    assert.ok(idx.some((i) => i.name === "idx_order_audit_order"));
    assert.ok(idx.some((i) => i.name === "idx_order_audit_created"));
  });

  it("admin_user_id acepta NULL (superadmin del .env)", async () => {
    const db = await makeDb();
    const id = await addOrder(db, { branch: "tandil" });
    await insertarAuditoria(db, [
      {
        order_id: id,
        admin_user_id: null,
        admin_username: "superadmin",
        admin_role: "superadmin",
        admin_branch: "",
        field: "paymentMethod",
        old_value: "mercadopago",
        new_value: "efectivo",
        old_total: 10000,
        new_total: 10000,
        created_at: iso(),
      },
    ]);
    const row = await db.prepare("SELECT * FROM order_audit_log WHERE order_id = ?").get(id);
    assert.equal(row.admin_user_id, null);
    assert.equal(row.admin_username, "superadmin");
  });
});

describe("computeShipping — Tandil vs Necochea", () => {
  it("Tandil sin dirección: costo 0, soportado", async () => {
    const result = await computeShipping("tandil", "");
    assert.equal(result.cost, 0);
    assert.equal(result.blocks, 0);
    assert.equal(result.supported, true);
  });

  it("Necochea: supported=false, costo 0", async () => {
    const result = await computeShipping("necochea", "Cualquier dirección");
    assert.equal(result.cost, 0);
    assert.equal(result.blocks, 0);
    assert.equal(result.supported, false);
  });

  it("branch vacía: supported=false, costo 0", async () => {
    const result = await computeShipping("", "Cualquier dirección");
    assert.equal(result.cost, 0);
    assert.equal(result.blocks, 0);
    assert.equal(result.supported, false);
  });
});
