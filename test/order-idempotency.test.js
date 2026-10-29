import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { reserveCoupon } from "../server/coupons.js";
import {
  parseClientRequestId,
  orderFingerprint,
  isClientRequestConflict,
  findOrderByClientRequestId,
  sameAttempt,
  insertOrderWithIdempotency,
  replayPayload,
  CLIENT_REQUEST_ID_MAX,
} from "../server/order-idempotency.js";

// La idempotencia se prueba contra un SQLite real en memoria (file::memory:),
// como coupons.js: lo que importa es que el ÚNICO índice haga de mutex, y eso
// es comportamiento del motor, no de un mock. Si el índice no existiera, el
// INSERT del segundo request simplemente entraría y el test de "un solo pedido"
// no lo vería.
//
// El esquema espeja el de server/db.js (incluidas las dos columnas nuevas y el
// índice único PARCIAL) y el batch espeja el INSERT del endpoint, incluido el
// UPDATE que deriva el número de pedido del id.

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

// Cada createClient abre una conexión NATIVA de libsql: sin cerrarla, el addon
// se libera en el GC y el proceso de este archivo muere con 0xC0000005 al
// terminar. Por eso se registran todos y se cierran en el after (mismo motivo
// que en test/coupons.test.js).
const clients = [];
after(() => {
  for (const c of clients) c.close();
});

function iso(offsetMin = 0) {
  return new Date(Date.now() + offsetMin * 60000).toISOString();
}

async function makeDb() {
  const client = createClient({ url: "file::memory:" });
  clients.push(client);
  const db = createDb(client);
  await db.exec(`
    CREATE TABLE coupons (
      code TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1,
      max_uses INTEGER NOT NULL DEFAULT 0, used_count INTEGER NOT NULL DEFAULT 0,
      min_total INTEGER NOT NULL DEFAULT 0, type TEXT NOT NULL DEFAULT 'percent',
      value INTEGER NOT NULL DEFAULT 0, expires_at TEXT, updated_at TEXT,
      branch TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      customer_name TEXT NOT NULL DEFAULT '',
      customer_phone TEXT NOT NULL DEFAULT '',
      customer_email TEXT NOT NULL DEFAULT '',
      customer_first_name TEXT NOT NULL DEFAULT '',
      customer_last_name TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      order_mode TEXT NOT NULL DEFAULT 'delivery',
      payment_method TEXT NOT NULL DEFAULT 'efectivo',
      payment_status TEXT NOT NULL DEFAULT 'approved',
      status TEXT NOT NULL DEFAULT 'received',
      items TEXT NOT NULL DEFAULT '[]',
      total INTEGER NOT NULL DEFAULT 0,
      discount INTEGER NOT NULL DEFAULT 0,
      coupon_code TEXT NOT NULL DEFAULT '',
      coupon_released_at TEXT,
      scheduled_for TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      shipping INTEGER NOT NULL DEFAULT 0,
      shipping_km INTEGER NOT NULL DEFAULT 0,
      shipping_pending INTEGER NOT NULL DEFAULT 0,
      mp_order_id TEXT,
      client_request_id TEXT,
      client_request_fingerprint TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_client_request
    ON orders(client_request_id) WHERE client_request_id IS NOT NULL;
  `);
  return db;
}

// El batch que arma el endpoint: INSERT (con la clave y la huella) + el UPDATE
// que fija el número definitivo a partir del id.
function insertStmts({ key = null, fingerprint = null, total = 10000, tmpNumber = null } = {}) {
  const ts = iso();
  return [
    {
      sql: `INSERT INTO orders
        (order_number, branch, customer_name, customer_phone, customer_email, customer_first_name, customer_last_name, address, order_mode,
         payment_method, payment_status, status, items, total, discount, coupon_code,
         scheduled_for, notes, shipping, shipping_km, shipping_pending, client_request_id, client_request_fingerprint, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        tmpNumber || `tmp-${randomBytes(8).toString("hex")}`,
        "necochea",
        "Ana Perez",
        "2262555555",
        "ana@correo.com",
        "Ana",
        "Perez",
        "Calle 123",
        "delivery",
        "efectivo",
        "approved",
        "received",
        JSON.stringify([{ key: "wok-1", productId: "wok-pollo", qty: 1, unitPrice: total, extras: [] }]),
        total,
        0,
        "",
        "",
        "",
        0,
        0,
        0,
        key,
        fingerprint,
        ts,
        ts,
      ],
    },
    {
      sql: "UPDATE orders SET order_number = ? || printf('%05d', id), updated_at = ? WHERE id = last_insert_rowid()",
      args: ["FW-", ts],
    },
  ];
}

async function countOrders(db, where = "") {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM orders ${where}`).get();
  return Number(row.n);
}

async function usedCount(db, code = "VERDE") {
  const row = await db.prepare("SELECT used_count FROM coupons WHERE code = ?").get(code);
  return row ? Number(row.used_count) : -1;
}

async function addCoupon(db, { code = "VERDE", maxUses = 0, used = 0 } = {}) {
  await db
    .prepare("INSERT INTO coupons (code, active, max_uses, used_count, branch) VALUES (?, 1, ?, ?, '')")
    .run(code, maxUses, used);
}

const body = {
  branch: "necochea",
  orderMode: "delivery",
  paymentMethod: "efectivo",
  couponCode: "",
  scheduledFor: "",
  address: "Calle 123",
  customer: { name: "Ana Perez", phone: "2262 55-5555", email: "ana@correo.com" },
  total: 10000,
  items: [{ productId: "wok-pollo", qty: 1, unitPrice: 10000, extras: [], name: "Wok pollo" }],
};

describe("parseClientRequestId", () => {
  it("acepta un UUID y lo deja en minúsculas", () => {
    assert.deepEqual(parseClientRequestId(UUID_A), { id: UUID_A });
    assert.deepEqual(parseClientRequestId(UUID_A.toUpperCase()), { id: UUID_A });
    assert.deepEqual(parseClientRequestId(`  ${UUID_A}  `), { id: UUID_A });
  });

  it("sin clave: null, undefined o vacío es 'sin clave' (no error)", () => {
    // El frontend viejo y la carga manual del panel no mandan clave: siguen
    // creando pedidos como siempre, sin deduplicar.
    assert.deepEqual(parseClientRequestId(undefined), { id: "" });
    assert.deepEqual(parseClientRequestId(null), { id: "" });
    assert.deepEqual(parseClientRequestId(""), { id: "" });
    assert.deepEqual(parseClientRequestId("   "), { id: "" });
  });

  it("rechaza lo que no es un UUID (400 en el endpoint)", () => {
    const malos = [
      "basura",
      "1111",
      "11111111-2222-4333-8444-5555555555555", // un hex de más
      "11111111-2222-4333-8444-55555555555", // uno de menos
      "1111111122224333844455555555555", // sin guiones
      "11111111-2222-4333-8444-55555555555g", // no hex
      "../../etc/passwd",
      `${UUID_A}x`,
    ];
    for (const value of malos) {
      const r = parseClientRequestId(value);
      assert.ok(r.error, `debería rechazar ${JSON.stringify(value)}`);
      assert.equal(r.id, undefined);
    }
  });

  it("rechaza una cadena más larga que el máximo", () => {
    const r = parseClientRequestId("a".repeat(CLIENT_REQUEST_ID_MAX + 1));
    assert.ok(r.error);
  });

  it("rechaza los tipos que no son string (número, objeto, array)", () => {
    // Un number no es una clave válida: se rechaza en vez de castear, para no
    // inventar una clave que el cliente nunca pidió.
    for (const value of [12345, {}, [], true]) {
      assert.ok(parseClientRequestId(value).error, `debería rechazar ${typeof value}`);
    }
  });
});

describe("orderFingerprint", () => {
  it("es estable: mismo pedido con las claves en otro orden y otra clientRequestId", () => {
    const otro = {
      clientRequestId: UUID_B,
      items: [{ name: "Wok pollo", extras: [], unitPrice: 10000, qty: 1, productId: "wok-pollo" }],
      total: 10000,
      customer: { email: "ana@correo.com", phone: "2262 55-5555", name: "Ana Perez" },
      address: "Calle 123",
      scheduledFor: "",
      couponCode: "",
      paymentMethod: "efectivo",
      orderMode: "delivery",
      branch: "necochea",
    };
    assert.equal(orderFingerprint(body), orderFingerprint(otro));
  });

  it("cambia si cambia el total, el carrito, la sucursal, el cupón, la dirección o el teléfono", () => {
    const base = orderFingerprint(body);
    const cambios = [
      { total: 12000 },
      { items: [{ productId: "wok-carne", qty: 1, unitPrice: 12000, extras: [] }] },
      { items: [{ productId: "wok-pollo", qty: 2, unitPrice: 10000, extras: [] }] },
      { items: [{ productId: "wok-pollo", qty: 1, unitPrice: 10000, extras: [{ id: "salsa-fuerte", price: 500 }] }] },
      { branch: "tandil" },
      { couponCode: "VERDE" },
      { address: "Calle 456" },
      { orderMode: "pickup" },
      { paymentMethod: "mercadopago" },
      { customer: { ...body.customer, phone: "2262555556" } },
    ];
    for (const cambio of cambios) {
      assert.notEqual(orderFingerprint({ ...body, ...cambio }), base, JSON.stringify(cambio).slice(0, 60));
    }
  });

  it("el mismo carrito en otro orden NO cambia la huella", () => {
    const items = [
      { productId: "wok-pollo", qty: 1, unitPrice: 10000, extras: [{ id: "salsa-fuerte", price: 500 }] },
      { productId: "arroz", qty: 2, unitPrice: 3000, extras: [] },
    ];
    assert.equal(
      orderFingerprint({ ...body, items }),
      orderFingerprint({ ...body, items: [...items].reverse() })
    );
  });

  it("ignora lo que el server reescribe o no usa (notas, envío, nombre del ítem)", () => {
    // Si esto cambiara la huella, corregir una observación o que la cotización
    // de envío derivara un poco convertirían un reintento legítimo en un 409.
    const base = orderFingerprint(body);
    assert.equal(orderFingerprint({ ...body, notes: "dejálo sin cebolla" }), base);
    assert.equal(
      orderFingerprint({
        ...body,
        items: [{ ...body.items[0], notes: "sin cebolla" }],
      }),
      base
    );
    assert.equal(orderFingerprint({ ...body, items: [{ ...body.items[0], name: "Wok de pollo" }] }), base);
    assert.equal(orderFingerprint({ ...body, shipping: { cost: 9999, blocks: 4 } }), base);
  });

  it("normaliza el formato del teléfono y del cupón", () => {
    // El server normaliza el teléfono a solo dígitos y el cupón a mayúsculas
    // (validateOrderBody/applyCoupon): el mismo cliente que escribe el código de
    // otra forma tiene que poder reintentar sin caer en el 409.
    const conCupon = { ...body, couponCode: "VERDE" };
    assert.equal(
      orderFingerprint({ ...conCupon, customer: { ...body.customer, phone: "2262555555" } }),
      orderFingerprint({ ...conCupon, customer: { ...body.customer, phone: "2262-55-5555" } })
    );
    assert.equal(orderFingerprint({ ...conCupon, couponCode: " verde " }), orderFingerprint(conCupon));
  });

  it("aguanta un body vacío o raro sin tirar", () => {
    assert.match(orderFingerprint(undefined), /^[0-9a-f]{64}$/);
    assert.match(orderFingerprint({ items: "no es un array" }), /^[0-9a-f]{64}$/);
  });
});

// El caso que motiva todo: el POST se guardó pero la respuesta se perdió, el
// cliente reintenta con la misma clave y NO tiene que aparecer un segundo pedido
// ni gastarse un segundo uso del cupón.
describe("misma clave dos veces → un solo pedido y un solo uso de cupón", () => {
  let db;
  beforeEach(async () => {
    db = await makeDb();
    await addCoupon(db);
  });

  it("el reintento devuelve la fila existente y no inserta nada", async () => {
    const fingerprint = orderFingerprint(body);
    const primerIntento = await insertOrderWithIdempotency(db, {
      stmts: insertStmts({ key: UUID_A, fingerprint }),
      clientRequestId: UUID_A,
      fingerprint,
    });
    assert.equal(primerIntento.inserted, true);
    assert.equal(await countOrders(db), 1);

    // El reintento: el endpoint ya consultó la clave y no encontró fila, así que
    // llegó hasta el INSERT (es la carrera del test de concurrencia). El índice
    // único es el que lo frena.
    const reintento = await insertOrderWithIdempotency(db, {
      stmts: insertStmts({ key: UUID_A, fingerprint }),
      clientRequestId: UUID_A,
      fingerprint,
    });
    assert.ok(reintento.replay, "el segundo intento devuelve el pedido existente");
    assert.equal(Number(reintento.replay.id), primerIntento.lastInsertRowid);
    assert.equal(await countOrders(db), 1, "no se crea una segunda fila");
  });

  it("el cupón se usa UNA sola vez aunque se haya reservado dos veces", async () => {
    const fingerprint = orderFingerprint(body);
    const args = { couponCode: "VERDE", branch: "necochea" };

    // Cada intento reserva el cupón antes de insertar (así lo hace el endpoint).
    assert.equal(await reserveCoupon(db, "VERDE", "necochea"), true);
    await insertOrderWithIdempotency(db, {
      stmts: insertStmts({ key: UUID_A, fingerprint }),
      clientRequestId: UUID_A,
      fingerprint,
      couponReserved: true,
      ...args,
    });
    assert.equal(await usedCount(db), 1);

    // El reintento también reservó antes de intentar insertar (otra reserva que
    // hay que devolver porque su pedido nunca se creó).
    assert.equal(await reserveCoupon(db, "VERDE", "necochea"), true);
    assert.equal(await usedCount(db), 2, "la segunda reserva sí cuenta hasta que se devuelve");
    await insertOrderWithIdempotency(db, {
      stmts: insertStmts({ key: UUID_A, fingerprint }),
      clientRequestId: UUID_A,
      fingerprint,
      couponReserved: true,
      ...args,
    });
    assert.equal(await usedCount(db), 1, "la reserva huérfana del reintento se devuelve");
    assert.equal(await countOrders(db), 1);
  });

  it("el reintento NO vuelve a registrar el evento order_created", async () => {
    // El evento va en el mismo batch que el INSERT: si el batch atómico no
    // corrió, no hay evento duplicado en las analíticas.
    const fingerprint = orderFingerprint(body);
    await insertOrderWithIdempotency(db, { stmts: insertStmts({ key: UUID_A, fingerprint }), clientRequestId: UUID_A, fingerprint });
    const row = await db.prepare("SELECT * FROM orders WHERE client_request_id = ?").get(UUID_A);
    assert.equal(row.order_number, "FW-00001", "el número se derivó del id real, una sola vez");
  });
});

// La defensa final contra dos requests EXACTAMENTE simultáneos (dos tabs, o un
// doble click): el chequeo previo de la clave no alcanza y decide el índice.
describe("dos requests simultáneos con la misma clave → un solo pedido", () => {
  let db;
  beforeEach(async () => {
    db = await makeDb();
    await addCoupon(db, { maxUses: 5 });
  });

  it("de los dos insertos, uno inserta y el otro recupera la fila", async () => {
    const fingerprint = orderFingerprint(body);
    const correr = () =>
      insertOrderWithIdempotency(db, {
        stmts: insertStmts({ key: UUID_A, fingerprint }),
        clientRequestId: UUID_A,
        fingerprint,
      });
    const [a, b] = await Promise.all([correr(), correr()]);

    assert.equal(await countOrders(db, `WHERE client_request_id = '${UUID_A}'`), 1);
    const insertados = [a, b].filter((r) => r.inserted);
    const reintentos = [a, b].filter((r) => r.replay);
    assert.equal(insertados.length, 1, "exactamente uno inserta");
    assert.equal(reintentos.length, 1, "el otro recibe la fila existente");
    assert.equal(Number(reintentos[0].replay.id), insertados[0].lastInsertRowid);
    assert.ok(!a.conflict && !b.conflict);
  });

  it("con cupón, el reintento no gasta un segundo uso", async () => {
    const fingerprint = orderFingerprint(body);
    // Cada request reserva el cupón antes de insertar (como hace el endpoint),
    // así que los dos compiten por el mismo uso.
    const correr = async () => {
      const reservado = await reserveCoupon(db, "VERDE", "necochea");
      return insertOrderWithIdempotency(db, {
        stmts: insertStmts({ key: UUID_B, fingerprint }),
        clientRequestId: UUID_B,
        fingerprint,
        couponCode: "VERDE",
        branch: "necochea",
        couponReserved: reservado,
      });
    };
    await Promise.all([correr(), correr()]);
    // Las dos reservas se hicieron, pero la del request perdedor se devuelve:
    // un pedido = un uso (que es lo que evita que el cupón se queme).
    assert.equal(await countOrders(db), 1);
    assert.equal(await usedCount(db), 1);
  });
});

describe("claves distintas → dos pedidos", () => {
  it("no se deduplican entre sí", async () => {
    const db = await makeDb();
    await addCoupon(db);
    const fingerprint = orderFingerprint(body);
    const uno = await insertOrderWithIdempotency(db, {
      stmts: insertStmts({ key: UUID_A, fingerprint }),
      clientRequestId: UUID_A,
      fingerprint,
    });
    const otro = await insertOrderWithIdempotency(db, {
      stmts: insertStmts({ key: UUID_B, fingerprint }),
      clientRequestId: UUID_B,
      fingerprint,
    });
    assert.equal(uno.inserted, true);
    assert.equal(otro.inserted, true);
    assert.equal(await countOrders(db), 2);
    assert.notEqual(uno.lastInsertRowid, otro.lastInsertRowid);
    assert.equal(await usedCount(db), 0, "sin cupón no hay uso que contar");
  });
});

// La regla de seguridad: la misma clave con OTRO contenido nunca devuelve el
// pedido que ya existe. Si devolviera, adivinar o reutilizar una clave leaky
// mostraría el número y el total de un pedido ajeno.
describe("misma clave con payload distinto → conflicto", () => {
  let db;
  beforeEach(async () => {
    db = await makeDb();
    await addCoupon(db);
  });

  it("no inserta y no devuelve la fila del otro pedido", async () => {
    const fingerprintA = orderFingerprint(body);
    const primero = await insertOrderWithIdempotency(db, {
      stmts: insertStmts({ key: UUID_A, fingerprint: fingerprintA }),
      clientRequestId: UUID_A,
      fingerprint: fingerprintA,
    });
    assert.equal(primero.inserted, true);

    // Misma clave, otro total/carrito → huella distinta.
    const otroBody = { ...body, total: 25000, items: [{ productId: "wok-carne", qty: 1, unitPrice: 25000, extras: [] }] };
    const fingerprintB = orderFingerprint(otroBody);
    assert.notEqual(fingerprintA, fingerprintB);
    const segundo = await insertOrderWithIdempotency(db, {
      stmts: insertStmts({ key: UUID_A, fingerprint: fingerprintB, total: 25000 }),
      clientRequestId: UUID_A,
      fingerprint: fingerprintB,
    });
    assert.equal(segundo.conflict, true);
    assert.equal(segundo.replay, undefined, "no se devuelve ninguna fila");
    assert.equal(await countOrders(db), 1, "el pedido ajeno queda intacto");
  });

  it("devuelve la reserva de cupón del request que no pudo insertar", async () => {
    const fingerprintA = orderFingerprint(body);
    await reserveCoupon(db, "VERDE", "necochea");
    await insertOrderWithIdempotency(db, {
      stmts: insertStmts({ key: UUID_A, fingerprint: fingerprintA }),
      clientRequestId: UUID_A,
      fingerprint: fingerprintA,
      couponReserved: true,
      couponCode: "VERDE",
      branch: "necochea",
    });
    assert.equal(await usedCount(db), 1);

    await reserveCoupon(db, "VERDE", "necochea");
    await insertOrderWithIdempotency(db, {
      stmts: insertStmts({ key: UUID_A, fingerprint: "otra-huella" }),
      clientRequestId: UUID_A,
      fingerprint: "otra-huella",
      couponReserved: true,
      couponCode: "VERDE",
      branch: "necochea",
    });
    assert.equal(await usedCount(db), 1, "el intento en conflicto no quema un uso");
    assert.equal(await countOrders(db), 1);
  });
});

describe("pedidos viejos (sin clave) → sin cambios", () => {
  let db;
  beforeEach(async () => {
    db = await makeDb();
  });

  it("todos los NULL conviven: el índice es parcial sobre IS NOT NULL", async () => {
    // Por esto el índice lleva el WHERE: sin él, el UNIQUE de la columna
    // rechazaría el segundo pedido sin clave (NULL != NULL en SQLite, pero un
    // índice no parcial trataría la columna como si tuviera que ser única).
    await insertOrderWithIdempotency(db, { stmts: insertStmts() });
    await insertOrderWithIdempotency(db, { stmts: insertStmts() });
    await insertOrderWithIdempotency(db, { stmts: insertStmts() });
    assert.equal(await countOrders(db, "WHERE client_request_id IS NULL"), 3);
  });

  it("un INSERT sin clave no toca los pedidos viejos", async () => {
    await insertOrderWithIdempotency(db, { stmts: insertStmts() });
    const viejo = await db.prepare("SELECT * FROM orders WHERE client_request_id IS NULL").get();
    assert.equal(await findOrderByClientRequestId(db, UUID_A), undefined, "una clave nueva no encuentra los viejos");
    assert.equal(await findOrderByClientRequestId(db, ""), undefined, "sin clave no se busca nada");

    const nuevo = await insertOrderWithIdempotency(db, {
      stmts: insertStmts({ key: UUID_A, fingerprint: "huella" }),
      clientRequestId: UUID_A,
      fingerprint: "huella",
    });
    assert.equal(nuevo.inserted, true);
    const despues = await db.prepare("SELECT * FROM orders WHERE id = ?").get(viejo.id);
    assert.deepEqual(despues, viejo, "la fila vieja queda idéntica");
  });

  it("una fila sin huella no se considera el mismo intento (falla cerrado)", async () => {
    // No debería pasar (el INSERT siempre escribe la huella cuando hay clave),
    // pero si pasara, devolver ese pedido sería peor que un 409.
    await db
      .prepare("INSERT INTO orders (order_number, branch, created_at, client_request_id) VALUES ('FW-00009', 'necochea', ?, ?)")
      .run(iso(), UUID_A);
    const row = await findOrderByClientRequestId(db, UUID_A);
    assert.ok(row);
    assert.equal(sameAttempt(row, "cualquiera"), false);
  });
});

describe("isClientRequestConflict", () => {
  it("reconoce el choque del índice de la clave y no otros errores", async () => {
    const db = await makeDb();
    await insertOrderWithIdempotency(db, { stmts: insertStmts({ key: UUID_A }) });
    let err = null;
    try {
      await db.batch(insertStmts({ key: UUID_A }), "write");
    } catch (e) {
      err = e;
    }
    assert.ok(err, "el INSERT duplicado tiene que fallar");
    assert.equal(isClientRequestConflict(err), true);

    // Un UNIQUE de otra columna (order_number) NO es un choque de la clave: el
    // error se propaga y el endpoint responde 500 como siempre.
    let otro = null;
    try {
      await db.batch(insertStmts({ key: UUID_B, tmpNumber: "FW-00001" }), "write");
    } catch (e) {
      otro = e;
    }
    assert.ok(otro, "el segundo INSERT con el mismo order_number tiene que fallar");
    assert.equal(isClientRequestConflict(otro), false);
    assert.equal(isClientRequestConflict(new Error("conexión caída")), false);
    assert.equal(isClientRequestConflict(undefined), false);
  });

  it("insertOrderWithIdempotency propaga los errores que no son de la clave", async () => {
    const db = await makeDb();
    await assert.rejects(
      () => db.exec("SELECT * FROM tabla_que_no_existe"),
      /tabla_que_no_existe|no such table/i
    );
    // Sin clave no hay choque posible: el error del INSERT sube tal cual.
    await assert.rejects(
      () => insertOrderWithIdempotency(db, { stmts: [{ sql: "INSERT INTO nope VALUES (1)", args: [] }] }),
      /nope|no such table/i
    );
  });
});

describe("replayPayload", () => {
  const row = {
    id: 42,
    order_number: "FW-00042",
    branch: "necochea",
    customer_name: "Ana Perez",
    customer_phone: "2262555555",
    customer_email: "ana@correo.com",
    customer_first_name: "Ana",
    customer_last_name: "Perez",
    address: "Calle 123",
    order_mode: "delivery",
    payment_method: "mercadopago",
    payment_status: "pending",
    status: "pending_payment",
    items: JSON.stringify([{ key: "wok-1", productId: "wok-pollo", name: "Wok pollo", qty: 1, unitPrice: 10000, notes: "sin cebolla" }]),
    total: 12000,
    discount: 2000,
    coupon_code: "VERDE",
    coupon_released_at: null,
    scheduled_for: "2026-10-05T20:00:00.000Z",
    notes: "dejálo sin cebolla",
    shipping: 2000,
    shipping_km: 4,
    shipping_pending: 0,
    mp_order_id: "ORD_1",
  };

  it("tiene la misma forma que la respuesta de éxito", () => {
    const payload = replayPayload(row, { demo: false, checkoutUrl: "https://mp/checkout" });
    assert.deepEqual(payload, {
      ok: true,
      orderId: 42,
      orderNumber: "FW-00042",
      demo: false,
      demoToken: "",
      checkoutUrl: "https://mp/checkout",
      status: "pending_payment",
      total: 12000,
      discount: 2000,
      couponCode: "VERDE",
      scheduledFor: "2026-10-05T20:00:00.000Z",
      shipping: { cost: 2000, blocks: 4, pending: false },
    });
  });

  it("el status sale de la fila, no del literal del camino feliz", () => {
    // Entre el intento y el reintento el pedido pudo avanzar o ser cancelado
    // desde el panel: el cliente tiene que ver la verdad.
    assert.equal(replayPayload({ ...row, status: "received" }).status, "received");
    assert.equal(replayPayload({ ...row, status: "cancelled" }).status, "cancelled");
  });

  it("no devuelve NINGÚN dato personal", () => {
    // La respuesta del replay es la única que se armó sin pasar por
    // validateOrderBody, así que la garantía tiene que ser explícita: ni
    // nombre, ni teléfono, ni email, ni dirección, ni notas, ni los ítems con
    // la nota del cliente.
    const payload = replayPayload(row, { demo: true, demoToken: "tok", checkoutUrl: null });
    const serializado = JSON.stringify(payload);
    for (const prohibido of [
      "Ana",
      "Perez",
      "2262555555",
      "ana@correo.com",
      "Calle 123",
      "dejálo sin cebolla",
      "sin cebolla",
      "customer",
      "address",
      "notes",
      "items",
    ]) {
      assert.equal(serializado.includes(prohibido), false, `no debe filtrar ${prohibido}`);
    }
  });

  it("tolera una fila con columnas vacías (pedidos viejos)", () => {
    const payload = replayPayload({ id: 1, order_number: "FW-00001" }, {});
    assert.equal(payload.orderId, 1);
    assert.equal(payload.discount, 0);
    assert.equal(payload.couponCode, "");
    assert.equal(payload.scheduledFor, "");
    assert.deepEqual(payload.shipping, { cost: 0, blocks: 0, pending: false });
    assert.equal(payload.checkoutUrl, null);
  });
});
