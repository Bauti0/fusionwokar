import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { listCoupons, getScopedCoupon, isCouponCodeTaken } from "../server/admin-queries.js";

// ============================================================
// admin-queries.js — cupones del panel con aislamiento por
// sucursal (T14 del plan de roles).
//
// Lo que este test fija:
//   - el branch_admin (scope "tandil") ve SOLO los cupones de su
//     sucursal en el listado: ni los globales (branch '', son del
//     dueño) ni los de la otra;
//   - por id, una fila ajena o global → null (el endpoint responde
//     404 sin confirmar su existencia, el mismo convenio de pedidos
//     y productos);
//   - el superadmin (scope null) sigue viendo y tocando todo;
//   - el chequeo de duplicado es por código GLOBAL (opción 2 del
//     dueño): un código existente en OTRA sucursal también está
//     tomado, y el endpoint responde el error genérico sin revelar
//     de cuál ("Ese código ya está en uso" vive en index.js).
// ============================================================

async function makeDb() {
  const client = createClient({ url: "file::memory:" });
  const db = createDb(client);
  // Espejo del esquema real de db.js (coupons) + ensureColumn de T14.
  await db.exec(`
    CREATE TABLE coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL DEFAULT 'percent',
      value INTEGER NOT NULL,
      min_total INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      max_uses INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

async function addCoupon(db, { code, branch = "" }) {
  const ts = new Date().toISOString();
  const r = await db
    .prepare("INSERT INTO coupons (code, branch, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(code, branch, 10, ts, ts);
  return Number(r.lastInsertRowid);
}

describe("listCoupons — scoping del panel", () => {
  let db;

  beforeEach(async () => {
    db = await makeDb();
    await addCoupon(db, { code: "GLOBAL" });
    await addCoupon(db, { code: "TANDIL10", branch: "tandil" });
    await addCoupon(db, { code: "NECO10", branch: "necochea" });
  });

  it("el branch_admin ve SOLO los cupones de su sucursal (ni globales ni de la otra)", async () => {
    const rows = await listCoupons(db, { scope: "tandil" });
    assert.deepEqual(rows.map((r) => r.code), ["TANDIL10"]);
  });

  it("el superadmin (scope null) sigue viendo todo", async () => {
    const rows = await listCoupons(db, { scope: null });
    assert.equal(rows.length, 3);
  });
});

describe("getScopedCoupon — fila ajena o global → null", () => {
  let db;
  let globalId, tandilId, necocheaId;

  beforeEach(async () => {
    db = await makeDb();
    globalId = await addCoupon(db, { code: "GLOBAL" });
    tandilId = await addCoupon(db, { code: "TANDIL10", branch: "tandil" });
    necocheaId = await addCoupon(db, { code: "NECO10", branch: "necochea" });
  });

  it("el branch_admin carga SU cupón por id", async () => {
    const row = await getScopedCoupon(db, tandilId, "tandil");
    assert.ok(row);
    assert.equal(row.code, "TANDIL10");
  });

  it("el cupón de la otra sucursal es 404 (null) para el branch_admin", async () => {
    assert.equal(await getScopedCoupon(db, necocheaId, "tandil"), null);
  });

  it("el cupón GLOBAL también es ajeno para el branch_admin (es del dueño)", async () => {
    assert.equal(await getScopedCoupon(db, globalId, "tandil"), null);
  });

  it("el superadmin (scope null) carga cualquier cupón por id", async () => {
    for (const id of [globalId, tandilId, necocheaId]) {
      assert.ok(await getScopedCoupon(db, id, null), `debe cargar el cupón ${id}`);
    }
  });
});

describe("isCouponCodeTaken — unicidad GLOBAL del código (opción 2)", () => {
  let db;

  beforeEach(async () => {
    db = await makeDb();
  });

  it("un código existente en OTRA sucursal también está tomado", async () => {
    // La regla que fija la Review Focus del plan: no puede haber un local
    // y otro local (ni un global) con el mismo código. El chequeo del
    // endpoint NO mira la sucursal: es por código global, y el error que
    // devuelve es genérico (sin revelar en cuál está en uso).
    await addCoupon(db, { code: "VERDE", branch: "tandil" });
    assert.equal(await isCouponCodeTaken(db, "VERDE"), true);
  });

  it("un código global existente también está tomado", async () => {
    await addCoupon(db, { code: "GLOBAL", branch: "" });
    assert.equal(await isCouponCodeTaken(db, "GLOBAL"), true);
  });

  it("un código libre está libre", async () => {
    await addCoupon(db, { code: "VERDE", branch: "tandil" });
    assert.equal(await isCouponCodeTaken(db, "OTRO"), false);
  });

  it("excludeId ignora la propia fila (edición sin cambiar el código)", async () => {
    // Caso PUT /api/admin/coupons/:id: editar un cupón sin tocar su
    // código no puede chocar consigo mismo.
    const id = await addCoupon(db, { code: "VERDE", branch: "tandil" });
    assert.equal(await isCouponCodeTaken(db, "VERDE", { excludeId: id }), false);
    assert.equal(await isCouponCodeTaken(db, "VERDE"), true, "sin excludeId sí está tomado");
  });
});
