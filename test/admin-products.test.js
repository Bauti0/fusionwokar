import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { listMenuForAdmin, getScopedProduct, getScopedCategory } from "../server/admin-queries.js";

// ============================================================
// admin-queries.js — menú para el panel con aislamiento por
// sucursal (T12 del plan de roles).
//
// Ruling del pre-flight aplicado acá: el módulo devuelve las ROWS
// CRUDAS del SELECT (con el scope aplicado); el agrupado por
// sucursal/categoría (la forma {branchId, categories} que consume
// el panel) sigue en el endpoint, igual que siempre. Lo que este
// test fija es el AISLAMIENTO y el orden:
//   - el branch_admin no puede ver NINGUNA row de la otra
//     sucursal (ni en el listado ni por id);
//   - el listado respeta sort_order (categoría, después producto);
//   - el superadmin (scope null) sigue viendo todo.
// ============================================================

async function makeDb() {
  const client = createClient({ url: "file::memory:" });
  const db = createDb(client);
  await db.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL,
      category_id TEXT NOT NULL,
      category_name TEXT NOT NULL DEFAULT '',
      group_name TEXT NOT NULL DEFAULT '',
      product_id TEXT NOT NULL,
      name TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '',
      extras_json TEXT NOT NULL DEFAULT '[]',
      available INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(branch, product_id)
    );
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL,
      category_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(branch, category_id)
    );
  `);
  return db;
}

async function addCategory(db, { branch, categoryId, name, sortOrder }) {
  const r = await db
    .prepare("INSERT INTO categories (branch, category_id, name, sort_order) VALUES (?, ?, ?, ?)")
    .run(branch, categoryId, name, sortOrder);
  return Number(r.lastInsertRowid);
}

async function addProduct(db, o = {}) {
  const ts = "2026-01-01T00:00:00.000Z";
  const r = await db
    .prepare(
      `INSERT INTO products
        (branch, category_id, category_name, product_id, name, price, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      o.branch || "tandil",
      o.categoryId || "woks",
      o.categoryName || "Woks",
      o.productId || `p-${Math.random().toString(36).slice(2, 8)}`,
      o.name || "Producto",
      o.price ?? 10000,
      o.sortOrder ?? 0,
      ts,
      ts
    );
  return Number(r.lastInsertRowid);
}

// Menú de ambas sucursales: tandil tiene woks (cat 1) con dos
// productos y extras (cat 2) con uno; necochea tiene su propio wok.
async function seed(db) {
  await addCategory(db, { branch: "tandil", categoryId: "woks", name: "Woks", sortOrder: 1 });
  await addCategory(db, { branch: "tandil", categoryId: "extras", name: "Extras", sortOrder: 2 });
  await addCategory(db, { branch: "necochea", categoryId: "woks", name: "Woks", sortOrder: 1 });
  await addProduct(db, { branch: "tandil", categoryId: "woks", name: "Wok A", sortOrder: 1 });
  await addProduct(db, { branch: "tandil", categoryId: "woks", name: "Wok B", sortOrder: 2 });
  await addProduct(db, { branch: "tandil", categoryId: "extras", name: "Extra A", sortOrder: 1 });
  await addProduct(db, { branch: "necochea", categoryId: "woks", name: "Wok Necochea", sortOrder: 1 });
}

describe("listMenuForAdmin", () => {
  it("branch_admin: rows SOLO de su sucursal (la otra no aparece)", async () => {
    const db = await makeDb();
    await seed(db);

    const rows = await listMenuForAdmin(db, { scope: "tandil" });
    assert.equal(rows.length, 3, "los 3 productos de tandil");
    assert.ok(rows.every((r) => r.branch === "tandil"), "ningún producto de necochea puede colarse");
    assert.ok(!rows.some((r) => r.name === "Wok Necochea"));
  });

  it("superadmin (scope null): rows de ambas sucursales", async () => {
    const db = await makeDb();
    await seed(db);

    const rows = await listMenuForAdmin(db, { scope: null });
    assert.equal(rows.length, 4);
    assert.equal(new Set(rows.map((r) => r.branch)).size, 2);
  });

  it("respeta sort_order: primero la categoría, después el producto", async () => {
    const db = await makeDb();
    await seed(db);

    const rows = await listMenuForAdmin(db, { scope: "tandil" });
    assert.deepEqual(
      rows.map((r) => r.name),
      ["Wok A", "Wok B", "Extra A"],
      "woks (cat 1) antes que extras (cat 2), y dentro de la categoría por sort_order"
    );
    // La row viene con el id de la fila de categories (para
    // renombrar/mover/eliminar desde el panel).
    assert.ok("_catRowId" in rows[0]);
  });
});

describe("getScopedProduct / getScopedCategory — por id", () => {
  it("ajeno → null; propio → row; superadmin → siempre", async () => {
    const db = await makeDb();
    await seed(db);
    const prodTandil = await db.prepare("SELECT id FROM products WHERE branch = 'tandil' AND name = 'Wok A'").get();
    const prodNecochea = await db.prepare("SELECT id FROM products WHERE name = 'Wok Necochea'").get();
    const catTandil = await db.prepare("SELECT id FROM categories WHERE branch = 'tandil' AND category_id = 'woks'").get();
    const catNecochea = await db.prepare("SELECT id FROM categories WHERE branch = 'necochea'").get();

    assert.equal((await getScopedProduct(db, prodTandil.id, "tandil")).name, "Wok A");
    assert.equal(await getScopedProduct(db, prodNecochea.id, "tandil"), null, "producto ajeno: 404 sin confirmar");
    assert.equal((await getScopedProduct(db, prodNecochea.id, null)).name, "Wok Necochea");
    assert.equal(await getScopedProduct(db, 99999, "tandil"), null);

    assert.equal((await getScopedCategory(db, catTandil.id, "tandil")).category_id, "woks");
    assert.equal(await getScopedCategory(db, catNecochea.id, "tandil"), null, "categoría ajena: 404 sin confirmar");
    assert.equal((await getScopedCategory(db, catNecochea.id, null)).category_id, "woks");
    assert.equal(await getScopedCategory(db, 99999, "tandil"), null);
  });
});
