import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { listCoupons, getScopedCoupon, isCouponCodeTaken } from "../server/admin-queries.js";

// ============================================================
// admin-queries.js — cupones del panel con aislamiento por
// sucursal (T14 del plan de roles + E-11).
//
// Lo que este test fija (nuevo contrato E-11):
//   - el branch_admin (scope "tandil") ve los cupones de SU
//     sucursal + los GLOBALES (branch ''), y NUNCA los de la
//     otra sucursal;
//   - por id, una fila de la otra sucursal O GLOBAL → null
//     (el endpoint responde 404 sin confirmar existencia: un
//     branch_admin NO edita/borra globales; el convenio es igual
//     que para pedidos y productos);
//   - el superadmin (scope null) sigue viendo y tocando todo;
//   - el chequeo de duplicado es por código GLOBAL (opción 2 del
//     dueño): un código existente en OTRA sucursal también está
//     tomado, y el endpoint responde error genérico sin revelar
//     de cuál ("Ese código ya está en uso" vive en index.js).
// Regresión cubierta: E-11 (branch_admin no veía globales).
// ============================================================

// Cada createClient abre una conexión NATIVA de libsql. Si nunca se cierra,
// el addon la libera en el GC y el proceso de este archivo de test muere con
// 0xC0000005 (ACCESS_VIOLATION) al terminar: node --test lo reporta como
// "'test failed'" sobre el ARCHIVO entero, con todos los subtests en verde.
// Por eso los clientes se registran y se cierran todos en el after.
const clients = [];
after(() => {
  for (const c of clients) c.close();
});

async function makeDb() {
  const client = createClient({ url: "file::memory:" });
  clients.push(client);
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

  it("el branch_admin ve SU sucursal + globales, y NUNCA la otra", async () => {
    const rows = await listCoupons(db, { scope: "tandil" });
    const codes = rows.map((r) => r.code).sort();
    // Debe ver tandil + global
    assert.ok(codes.includes("TANDIL10"), "ve su sucursal");
    assert.ok(codes.includes("GLOBAL"), "ve globales");
    // NUNCA ve necochea
    assert.ok(!codes.includes("NECO10"), "NO ve la otra sucursal");
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

  it("el cupón GLOBAL es ajeno para el branch_admin en PUT/PATCH/DELETE (no lo edita/borra)", async () => {
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

  it("cupones globales tienen branch = '' (cadena vacía, no null)", async () => {
    // Regresión E-11: los cupones globales se guardan con branch = '',
    // no con NULL. El listado del panel (couponRowToAdmin) usa este
    // campo para marcar isGlobal = true y mostrar badge "Global".
    await addCoupon(db, { code: "GLOBAL", branch: "" });
    const rows = await listCoupons(db, { scope: "tandil" });
    const global = rows.find((r) => r.code === "GLOBAL");
    assert.ok(global, "el cupón global debe aparecer en el listado");
    assert.equal(global.branch, "", "branch debe ser cadena vacía, no null");
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
