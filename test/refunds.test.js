import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { applyRefunds, mergeRefunds, parseRefunds, refundableAmount, cleanRefundedBy } from "../server/refunds.js";
import { toPublicOrder } from "../server/public-order.js";

// Las devoluciones se prueban contra un SQLite real en memoria (file::memory:)
// porque lo que importa —el UPDATE condicional que hace de compare-and-set—
// depende del motor: un mock no probaria nada.

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
  await db.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      total INTEGER NOT NULL DEFAULT 0,
      refunded_amount INTEGER NOT NULL DEFAULT 0,
      refunds_json TEXT NOT NULL DEFAULT '[]',
      payment_status TEXT NOT NULL DEFAULT 'approved',
      status TEXT NOT NULL DEFAULT 'received',
      mp_payment_id TEXT,
      items TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT
    );
  `);
  return db;
}

async function addOrder(db, total = 1000) {
  const r = await db.prepare("INSERT INTO orders (total) VALUES (?)").run(total);
  return r.lastInsertRowid;
}

async function readOrder(db, id) {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
}

// Igual que el endpoint: total -> "refunded", parcial -> deja el estado.
const endpointPatch = (row, { refundedAmount }) => ({
  payment_status: refundedAmount >= (row.total || 0) ? "refunded" : row.payment_status,
});

// ---------------------------------------------------------------------
// LA REGRESION: applyRefund sumaba sobre un refunds_json leido ANTES del
// llamado a MP y despues reemplazaba la columna entera. Dos devoluciones
// parciales en vuelo al mismo tiempo leian lo mismo y la ultima pisaba a
// la otra: MP devolvia $300 y la base quedaba diciendo $200, asi que el
// panel ofrecia devolver plata que ya no existia.
// ---------------------------------------------------------------------

describe("devoluciones concurrentes", () => {
  it("dos parciales en simultaneo conservan la SUMA, no la ultima", async () => {
    const db = await makeDb();
    const id = await addOrder(db, 1000);

    await Promise.all([
      applyRefunds(db, id, { mpRefunds: [{ id: "a", amount: 100 }], patch: endpointPatch }),
      applyRefunds(db, id, { mpRefunds: [{ id: "b", amount: 200 }], patch: endpointPatch }),
    ]);

    const row = await readOrder(db, id);
    assert.equal(Number(row.refunded_amount), 300, "se perdio una de las dos devoluciones");
    const ids = parseRefunds(row.refunds_json).map((r) => r.id).sort();
    assert.deepEqual(ids, ["a", "b"], "falta un registro en el historial");
    assert.equal(row.payment_status, "approved", "no era devolucion total");
  });

  it("cinco parciales en simultaneo suman todos", async () => {
    const db = await makeDb();
    const id = await addOrder(db, 1000);

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        applyRefunds(db, id, { mpRefunds: [{ id: `r${i}`, amount: 50 }], patch: endpointPatch })
      )
    );

    const row = await readOrder(db, id);
    assert.equal(Number(row.refunded_amount), 250);
    assert.equal(parseRefunds(row.refunds_json).length, 5);
  });

  it("concurrente con la devolucion total deja el pedido en 'refunded'", async () => {
    const db = await makeDb();
    const id = await addOrder(db, 1000);

    await Promise.all([
      applyRefunds(db, id, { mpRefunds: [{ id: "p", amount: 200 }], patch: endpointPatch }),
      applyRefunds(db, id, { mpRefunds: [{ id: "t", amount: 800 }], patch: endpointPatch }),
    ]);

    const row = await readOrder(db, id);
    assert.equal(Number(row.refunded_amount), 1000);
    assert.equal(row.payment_status, "refunded");
  });
});

describe("idempotencia y limites", () => {
  it("el mismo id de reembolso dos veces no duplica el historial", async () => {
    const db = await makeDb();
    const id = await addOrder(db, 1000);

    const r = { id: "mp-1", amount: 100 };
    await applyRefunds(db, id, { mpRefunds: [r], patch: endpointPatch });
    await applyRefunds(db, id, { mpRefunds: [r], patch: endpointPatch });

    const row = await readOrder(db, id);
    assert.equal(Number(row.refunded_amount), 100);
    assert.equal(parseRefunds(row.refunds_json).length, 1);
  });

  it("una parcial no marca el pedido como refunded", async () => {
    const db = await makeDb();
    const id = await addOrder(db, 1000);
    await applyRefunds(db, id, { mpRefunds: [{ id: "a", amount: 100 }], patch: endpointPatch });
    const row = await readOrder(db, id);
    assert.equal(row.payment_status, "approved");
  });

  it("la total marca refunded", async () => {
    const db = await makeDb();
    const id = await addOrder(db, 1000);
    await applyRefunds(db, id, { mpRefunds: [{ id: "a", amount: 1000 }], patch: endpointPatch });
    const row = await readOrder(db, id);
    assert.equal(row.payment_status, "refunded");
    assert.equal(refundableAmount(row), 0);
  });

  it("sin reembolsos nuevos no toca nada", async () => {
    const db = await makeDb();
    const id = await addOrder(db, 1000);
    await applyRefunds(db, id, { mpRefunds: [], patch: endpointPatch });
    const row = await readOrder(db, id);
    assert.equal(Number(row.refunded_amount), 0);
  });

  it("devuelve not_found si el pedido no existe", async () => {
    const db = await makeDb();
    const res = await applyRefunds(db, 999, { mpRefunds: [{ id: "a", amount: 100 }] });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "not_found");
  });
});

describe("mergeRefunds", () => {
  it("deduplica por id y conserva el 'at' original", () => {
    const existing = [{ id: "a", amount: 100, at: "2026-01-01T00:00:00.000Z" }];
    const merged = mergeRefunds(existing, [{ id: "a", amount: 100 }, { id: "b", amount: 50 }]);
    assert.equal(merged.length, 2);
    assert.equal(merged.find((r) => r.id === "a").at, "2026-01-01T00:00:00.000Z");
  });

  it("parseRefunds tolera JSON corrupto y filas viejas", () => {
    assert.deepEqual(parseRefunds(""), []);
    assert.deepEqual(parseRefunds(null), []);
    assert.deepEqual(parseRefunds("no-json"), []);
    assert.deepEqual(parseRefunds('{"a":1}'), []);
  });
});

// ---------------------------------------------------------------------
// Quien realiza la devolucion (refundedBy): se valida en el server ANTES
// de llamar a Mercado Pago (un fallo es 400 directo, sin contactar MP ni
// tocar la base) y queda registrado en refunds_json como by/admin.
// ---------------------------------------------------------------------

describe("cleanRefundedBy (la validacion del 400 del endpoint)", () => {
  it("rechaza ausente, corto y largo (el endpoint responde 400 sin seguir)", () => {
    assert.equal(cleanRefundedBy(undefined), null);
    assert.equal(cleanRefundedBy(""), null);
    assert.equal(cleanRefundedBy("   "), null); // solo espacios
    assert.equal(cleanRefundedBy("a"), null); // menos de 2
    assert.equal(cleanRefundedBy("x".repeat(61)), null); // mas de 60
  });

  it("acepta y recorta con trim", () => {
    assert.equal(cleanRefundedBy("  María Pérez  "), "María Pérez");
    assert.equal(cleanRefundedBy("Bo"), "Bo");
  });
});

describe("registro de quien devuelve (by/admin en refunds_json)", () => {
  it("una devolucion con nombre guarda by y admin, y se proyecta", async () => {
    const db = await makeDb();
    const id = await addOrder(db, 1000);
    await applyRefunds(db, id, {
      mpRefunds: [{ id: "r1", amount: 1000, by: "María Pérez", admin: "mostrador1" }],
      patch: endpointPatch,
    });
    const pub = toPublicOrder(await readOrder(db, id));
    assert.equal(pub.refunds.length, 1);
    assert.equal(pub.refunds[0].by, "María Pérez");
    assert.equal(pub.refunds[0].admin, "mostrador1");
    assert.equal(pub.paymentStatus, "refunded");
  });

  it("un re-merge del webhook (sin by) conserva el by original", async () => {
    const db = await makeDb();
    const id = await addOrder(db, 1000);
    await applyRefunds(db, id, {
      mpRefunds: [{ id: "r1", amount: 500, by: "María Pérez", admin: "mostrador1" }],
      patch: endpointPatch,
    });
    // El webhook re-reporta el mismo reembolso, pelado (MP no sabe quien fue).
    await applyRefunds(db, id, { mpRefunds: [{ id: "r1", amount: 500 }], patch: endpointPatch });
    const row = await readOrder(db, id);
    const r = parseRefunds(row.refunds_json)[0];
    assert.equal(r.by, "María Pérez", "el webhook piso el nombre");
    assert.equal(r.admin, "mostrador1");
  });

  it("una devolucion sin by (vieja o hecha desde la app de MP) se proyecta igual", async () => {
    const db = await makeDb();
    const id = await addOrder(db, 1000);
    await applyRefunds(db, id, { mpRefunds: [{ id: "r9", amount: 500 }], patch: endpointPatch });
    const pub = toPublicOrder(await readOrder(db, id));
    assert.equal(pub.refunds.length, 1);
    assert.equal(pub.refunds[0].amount, 500);
    assert.equal(pub.refunds[0].by, undefined);
    assert.equal(pub.refundedAmount, 500);
  });
});
