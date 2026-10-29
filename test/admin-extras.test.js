import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { listExtras, updateExtra } from "../server/admin-queries.js";
import { availableExtras } from "../server/extras.js";

// ============================================================
// Adicionales globales (feature: editar precio y visibilidad de
// los extras desde el panel, de una vez para TODOS los productos).
//
// Por qué así: el "teriyaki" vive COPIADO en el extras_json de cada
// wok. Cuando el local se queda sin teriyaki, editar 10 productos
// a mano no es opción. Estas funciones son la base de la sección
// "Adicionales" del panel:
//   - listExtras agrupa por id DENTRO de una sucursal
//     (un solo renglón por adicional, con en cuántos productos está);
//   - updateExtra reescribe el extra con ese id en TODOS los
//     productos de la sucursal que lo contienen, sin tocar otros
//     extras ni la otra sucursal;
//   - availableExtras es el filtro que saca los extras con
//     available:false del menú público y del catálogo que valida
//     precios (así tampoco se pueden cobrar en un pedido).
// ============================================================

// Ver test/admin-products.test.js: cada cliente nativo de libsql que
// no se cierra mata el proceso con 0xC0000005 al terminar el archivo.
const clients = [];
after(() => {
  for (const c of clients) c.close();
});

async function makeDb() {
  const client = createClient({ url: "file::memory:" });
  clients.push(client);
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
  `);
  return db;
}

const EXTRAS_WOK = [
  { id: "salsa-teriyaki", label: "Teriyaki", price: 1900, subgroup: "salsas", subgroupLabel: "SALSAS ADICIONALES" },
  { id: "salsa-agridulce", label: "Agridulce", price: 1900, subgroup: "salsas", subgroupLabel: "SALSAS ADICIONALES" },
  { id: "palitos-chinos", label: "Palitos chinos", price: 500, subgroup: "palitos", subgroupLabel: "PALITOS DESCARTABLES" },
];

async function addProduct(db, o = {}) {
  const ts = "2026-01-01T00:00:00.000Z";
  const r = await db
    .prepare(
      `INSERT INTO products
        (branch, category_id, category_name, product_id, name, price, extras_json, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      o.branch || "tandil",
      o.categoryId || "woks",
      o.categoryName || "Woks",
      o.productId || `p-${Math.random().toString(36).slice(2, 8)}`,
      o.name || "Producto",
      o.price ?? 10000,
      JSON.stringify(o.extras ?? []),
      o.sortOrder ?? 0,
      ts,
      ts
    );
  return Number(r.lastInsertRowid);
}

describe("listExtras — agrupado global por sucursal", () => {
  it("une el mismo extra repetido en varios productos y cuenta en cuántos está", async () => {
    const db = await makeDb();
    await addProduct(db, { branch: "tandil", name: "Wok 1", extras: EXTRAS_WOK, sortOrder: 1 });
    await addProduct(db, { branch: "tandil", name: "Wok 2", extras: EXTRAS_WOK, sortOrder: 2 });
    await addProduct(db, { branch: "tandil", name: "Bebida", categoryId: "bebidas", extras: [], sortOrder: 3 });
    await addProduct(db, { branch: "necochea", name: "Wok N", extras: EXTRAS_WOK, sortOrder: 1 });

    const extras = await listExtras(db, { scope: "tandil" });
    assert.equal(extras.length, 3, "un renglón por adicional, no por producto");
    const teriyaki = extras.find((e) => e.id === "salsa-teriyaki");
    assert.equal(teriyaki.label, "Teriyaki");
    assert.equal(teriyaki.price, 1900);
    assert.equal(teriyaki.subgroupLabel, "SALSAS ADICIONALES");
    assert.equal(teriyaki.productCount, 2, "está en los dos woks, no en la bebida");
    assert.equal(teriyaki.available, true);
  });

  it("branch_admin: solo ve los de su sucursal", async () => {
    const db = await makeDb();
    await addProduct(db, { branch: "tandil", extras: EXTRAS_WOK });
    await addProduct(db, {
      branch: "necochea",
      extras: [{ id: "salsa-curry", label: "Curry", price: 2000 }],
    });

    const extras = await listExtras(db, { scope: "necochea" });
    assert.deepEqual(extras.map((e) => e.id), ["salsa-curry"]);
  });
});

describe("updateExtra — cambio global de precio y visibilidad", () => {
  it("pisa el extra en TODOS los productos de la sucursal que lo tienen", async () => {
    const db = await makeDb();
    const id1 = await addProduct(db, { branch: "tandil", name: "Wok 1", extras: EXTRAS_WOK });
    const id2 = await addProduct(db, { branch: "tandil", name: "Wok 2", extras: EXTRAS_WOK });
    await addProduct(db, { branch: "tandil", name: "Bebida", categoryId: "bebidas", extras: [] });
    const idN = await addProduct(db, { branch: "necochea", name: "Wok N", extras: EXTRAS_WOK });

    const result = await updateExtra(db, {
      branch: "tandil",
      extraId: "salsa-teriyaki",
      price: 2500,
      available: false,
      nowIso: "2026-02-01T00:00:00.000Z",
    });
    assert.equal(result.updated, 2);

    for (const id of [id1, id2]) {
      const row = await db.prepare("SELECT extras_json FROM products WHERE id = ?").get(id);
      const extras = JSON.parse(row.extras_json);
      const teriyaki = extras.find((e) => e.id === "salsa-teriyaki");
      assert.equal(teriyaki.price, 2500);
      assert.equal(teriyaki.available, false);
      // Los demás extras no se tocan
      assert.equal(extras.find((e) => e.id === "salsa-agridulce").price, 1900);
      assert.equal(extras.length, 3);
    }
    // La otra sucursal queda igual (aislamiento por sucursal)
    const rowN = await db.prepare("SELECT extras_json FROM products WHERE id = ?").get(idN);
    const extrasN = JSON.parse(rowN.extras_json);
    assert.equal(extrasN.find((e) => e.id === "salsa-teriyaki").price, 1900);
  });

  it("permite cambiar solo la visibilidad o solo el precio", async () => {
    const db = await makeDb();
    const id = await addProduct(db, { branch: "tandil", extras: EXTRAS_WOK });

    await updateExtra(db, { branch: "tandil", extraId: "palitos-chinos", available: false });
    let extras = JSON.parse((await db.prepare("SELECT extras_json FROM products WHERE id = ?").get(id)).extras_json);
    let palitos = extras.find((e) => e.id === "palitos-chinos");
    assert.equal(palitos.available, false);
    assert.equal(palitos.price, 500, "el precio queda como estaba");

    await updateExtra(db, { branch: "tandil", extraId: "palitos-chinos", price: 700 });
    extras = JSON.parse((await db.prepare("SELECT extras_json FROM products WHERE id = ?").get(id)).extras_json);
    palitos = extras.find((e) => e.id === "palitos-chinos");
    assert.equal(palitos.price, 700);
    assert.equal(palitos.available, false, "la visibilidad queda como estaba");
  });

  it("extra inexistente → updated 0, sin explotar", async () => {
    const db = await makeDb();
    await addProduct(db, { branch: "tandil", extras: EXTRAS_WOK });
    const result = await updateExtra(db, { branch: "tandil", extraId: "salsa-inexistente", price: 1 });
    assert.equal(result.updated, 0);
  });
});

describe("availableExtras — filtro del menú público", () => {
  it("saca los extras con available:false y deja el resto", () => {
    const extras = [
      { id: "a", label: "A", price: 100 },
      { id: "b", label: "B", price: 200, available: false },
      { id: "c", label: "C", price: 300, available: true },
    ];
    assert.deepEqual(availableExtras(extras).map((e) => e.id), ["a", "c"]);
  });

  it("sin extras o sin el flag → no filtra nada (compatibilidad con filas viejas)", () => {
    assert.deepEqual(availableExtras([]), []);
    assert.equal(availableExtras(EXTRAS_WOK).length, 3);
  });
});
