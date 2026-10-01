import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import {
  applyCoupon,
  reserveCoupon,
  releaseOrderCoupon,
  releaseOrphanReservation,
  releaseStaleCouponReservations,
} from "../server/coupons.js";

// La contabilidad de cupones se prueba contra un SQLite real en memoria
// (file::memory:), no contra mocks: el comportamiento que importa —el
// UPDATE condicional que hace de mutex— depende del motor, asi que un mock
// no probaria nada.
//
// used_count = (pedidos que ya consumieron el cupon, pago o reserva vigente)
// y por eso una liberacion solo puede ocurrir UNA vez por pedido.

function iso(offsetMin = 0) {
  return new Date(Date.now() + offsetMin * 60000).toISOString();
}

async function makeDb() {
  const client = createClient({ url: "file::memory:" });
  const db = createDb(client);
  // db.exec() es el mismo camino que usan las migraciones del server.
  // `branch` espeja el ensureColumn aditivo de T14: '' = cupón global
  // (vale en ambas sucursales), 'necochea'/'tandil' = cupón local.
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
      coupon_code TEXT NOT NULL DEFAULT '',
      coupon_released_at TEXT,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'received',
      created_at TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

async function addCoupon(db, { code = "VERDE", maxUses = 0, used = 0, active = 1, type = "percent", value = 0, branch = "" } = {}) {
  await db
    .prepare("INSERT INTO coupons (code, active, max_uses, used_count, type, value, branch) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(code, active, maxUses, used, type, value, branch);
}

async function addOrder(db, { code = "VERDE", payment = "pending", status = "received", ageMin = 0, branch = "" } = {}) {
  const r = await db
    .prepare("INSERT INTO orders (coupon_code, payment_status, status, created_at, branch) VALUES (?, ?, ?, ?, ?)")
    .run(code, payment, status, iso(-ageMin), branch);
  return r.lastInsertRowid;
}

async function usedCount(db, code = "VERDE") {
  const row = await db.prepare("SELECT used_count FROM coupons WHERE code = ?").get(code);
  return row ? Number(row.used_count) : -1;
}

// ---------------------------------------------------------------------
// La regresion principal: el sweep reejecutaba sobre los mismos pedidos
// para siempre. Cada pedido nuevo re-bajaba el contador, y el tope de
// usos quedaba anulado (perdida de plata continua).
// ---------------------------------------------------------------------
describe("releaseStaleCouponReservations — no debe re-liberar", () => {
  let db;
  beforeEach(async () => { db = await makeDb(); });

  it("baja el contador UNA vez por pedido, aunque el sweep corra tres veces", async () => {
    await addCoupon(db, { used: 1 });
    await addOrder(db, { payment: "pending", ageMin: 45 });

    await releaseStaleCouponReservations(db);
    assert.equal(await usedCount(db), 0, "el primer sweep libera");

    await releaseStaleCouponReservations(db);
    assert.equal(await usedCount(db), 0, "el segundo sweep no vuelve a bajar");

    await releaseStaleCouponReservations(db);
    assert.equal(await usedCount(db), 0, "ni el tercero");
  });

  it("el cupon de otro pedido no se gasta en un sweep repetido", async () => {
    // Este es el caso que hace perder plata de verdad, y el unico que el
    // clamp MAX(x-1, 0) NO puede disimular.
    //
    // Pedido A (abandonado) sostiene un uso. Llega el pedido B y reserva el
    // suyo: used = 2. El sweep libera a A: used = 1 (correcto). Pero si el
    // sweep corre otra vez — y corre en cada pedido nuevo — vuelve a
    // encontrar a A y libera OTRO uso que no era de A. used queda en 0
    // cuando en realidad B todavia esta sosteniendo el suyo, y el cliente
    // puede usar el cupon max_uses veces en lugar de max_uses - 1.
    await addCoupon(db, { maxUses: 5, used: 1 });
    await addOrder(db, { payment: "pending", ageMin: 45 });

    assert.equal(await reserveCoupon(db, "VERDE"), true, "llega el pedido B y reserva");
    assert.equal(await usedCount(db), 2, "A sostenia 1 uso, B suma el suyo");

    await releaseStaleCouponReservations(db);
    assert.equal(await usedCount(db), 1, "el sweep libera el uso de A");

    await releaseStaleCouponReservations(db);
    assert.equal(await usedCount(db), 1, "el uso de B NO se gasta en un sweep repetido");
  });

  it("libera cada pedido viejo una vez, no uno por corrida", async () => {
    await addCoupon(db, { used: 3 });
    const a = await addOrder(db, { payment: "pending", ageMin: 45 });
    const b = await addOrder(db, { payment: "rejected", ageMin: 45 });
    const c = await addOrder(db, { payment: "cancelled", ageMin: 45 });

    await releaseStaleCouponReservations(db);
    assert.equal(await usedCount(db), 0, "los tres pedidos se liberan en una pasada");

    await releaseStaleCouponReservations(db);
    assert.equal(await usedCount(db), 0, "y no se vuelven a liberar");
    assert.equal(await releaseOrderCoupon(db, a, "VERDE"), false, "ya estaban liberados");
    assert.equal(await releaseOrderCoupon(db, b, "VERDE"), false);
    assert.equal(await releaseOrderCoupon(db, c, "VERDE"), false);
  });

  it("no toca pedidos que todavia no son viejos", async () => {
    await addCoupon(db, { used: 1 });
    await addOrder(db, { payment: "pending", ageMin: 5 });

    await releaseStaleCouponReservations(db);
    assert.equal(await usedCount(db), 1, "un pending de 5 min todavia sostiene la reserva");
  });

  it("un pedido refunded NUNCA libera el cupon", async () => {
    // Decision deliberada: si se liberara, el cliente podria pedir, devolver
    // y reusar el descuento indefinidamente.
    await addCoupon(db, { used: 1 });
    const id = await addOrder(db, { payment: "refunded", ageMin: 45 });

    await releaseStaleCouponReservations(db);
    assert.equal(await usedCount(db), 1, "el cobro fue real: el uso queda consumido");
    assert.equal(await releaseOrderCoupon(db, id, "VERDE"), false);
  });

  it("un pedido pagado NUNCA libera el cupon", async () => {
    await addCoupon(db, { used: 1 });
    await addOrder(db, { payment: "approved", ageMin: 45 });

    await releaseStaleCouponReservations(db);
    assert.equal(await usedCount(db), 1);
  });

  it("ignora pedidos sin cupon", async () => {
    await addCoupon(db, { used: 0 });
    await addOrder(db, { code: "", payment: "pending", ageMin: 45 });

    await releaseStaleCouponReservations(db);
    assert.equal(await usedCount(db), 0, "no hay nada que liberar, y tampoco debe romperse");
  });
});

// ---------------------------------------------------------------------
// releaseOrderCoupon: exactamente-una-vez. El UPDATE condicional es el
// mutex, asi que dos pedidos que lleguen a la vez no pueden ambos bajar
// el contador.
// ---------------------------------------------------------------------
describe("releaseOrderCoupon — exactamente una vez", () => {
  let db;
  beforeEach(async () => { db = await makeDb(); });

  it("dos liberaciones concurrentes del mismo pedido bajan una sola vez", async () => {
    await addCoupon(db, { used: 1 });
    const id = await addOrder(db, { payment: "pending", ageMin: 45 });

    const results = await Promise.all([
      releaseOrderCoupon(db, id, "VERDE"),
      releaseOrderCoupon(db, id, "VERDE"),
    ]);

    assert.equal(await usedCount(db), 0, "el contador baja exactamente una vez");
    assert.equal(results.filter(Boolean).length, 1, "solo un llamado reporta que libero");
  });

  it("cinco liberaciones concurrentes del mismo pedido bajan una sola vez", async () => {
    await addCoupon(db, { used: 1 });
    const id = await addOrder(db, { payment: "rejected", ageMin: 45 });

    await Promise.all(Array.from({ length: 5 }, () => releaseOrderCoupon(db, id, "VERDE")));
    assert.equal(await usedCount(db), 0);
  });

  it("el webhook y el sweep sobre el mismo pedido bajan una sola vez", async () => {
    // Reproducia el pique real: el webhook rechaza a los 2 min y libera, y
    // el sweep a los 31 min vuelve a encontrar ese mismo pedido rechazado.
    await addCoupon(db, { used: 1 });
    const id = await addOrder(db, { payment: "rejected", ageMin: 45 });

    assert.equal(await releaseOrderCoupon(db, id, "VERDE"), true, "el webhook libera");
    await releaseStaleCouponReservations(db);
    assert.equal(await usedCount(db), 0, "el sweep no vuelve a liberar");
  });

  it("no libera si el pedido no tiene ese cupon", async () => {
    await addCoupon(db, { used: 1 });
    const id = await addOrder(db, { code: "OTRO", payment: "pending", ageMin: 45 });

    assert.equal(await releaseOrderCoupon(db, id, "VERDE"), false);
    assert.equal(await usedCount(db), 1, "el contador de VERDE no se toca");
  });

  it("no libera un pedido inexistente ni un id invalido", async () => {
    await addCoupon(db, { used: 1 });
    assert.equal(await releaseOrderCoupon(db, 9999, "VERDE"), false);
    assert.equal(await releaseOrderCoupon(db, null, "VERDE"), false);
    assert.equal(await releaseOrderCoupon(db, 1, ""), false);
    assert.equal(await usedCount(db), 1, "nada se toca");
  });

  it("el contador nunca baja de cero", async () => {
    await addCoupon(db, { used: 0 });
    const id = await addOrder(db, { payment: "pending", ageMin: 45 });
    await releaseOrderCoupon(db, id, "VERDE");
    await releaseStaleCouponReservations(db);
    assert.equal(await usedCount(db), 0, "no se vuelve negativo");
  });
});

// ---------------------------------------------------------------------
// El otro lado del invariante: la reserva.
// ---------------------------------------------------------------------
describe("reserveCoupon — el tope de usos no se puede superar", () => {
  let db;
  beforeEach(async () => { db = await makeDb(); });

  it("reserva con sucesso si hay cupo", async () => {
    await addCoupon(db, { maxUses: 3, used: 1 });
    assert.equal(await reserveCoupon(db, "VERDE"), true);
    assert.equal(await usedCount(db), 2);
  });

  it("falla si ya no quedan usos", async () => {
    await addCoupon(db, { maxUses: 3, used: 3 });
    assert.equal(await reserveCoupon(db, "VERDE"), false);
    assert.equal(await usedCount(db), 3, "y no incrementa igual");
  });

  it("max_uses = 0 es ilimitado", async () => {
    await addCoupon(db, { maxUses: 0, used: 999 });
    assert.equal(await reserveCoupon(db, "VERDE"), true);
  });

  it("no reserva un cupon inactivo", async () => {
    await addCoupon(db, { maxUses: 0, used: 0, active: 0 });
    assert.equal(await reserveCoupon(db, "VERDE"), false);
  });

  it("con reservas simultaneas solo pasa la cantidad que el tope permite", async () => {
    // max_uses=2 y 8 intentos en paralelo: exactamente 2 deben prosperar.
    await addCoupon(db, { maxUses: 2, used: 0 });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reserveCoupon(db, "VERDE"))
    );
    const ok = results.filter(Boolean).length;
    assert.equal(ok, 2, `deberían pasar 2 de 8, pasaron ${ok}`);
    assert.equal(await usedCount(db), 2, "y el contador queda en el tope, no mas");
  });

  it("sin cupon no hay nada que reservar y eso es un exito", async () => {
    assert.equal(await reserveCoupon(db, ""), true);
    assert.equal(await reserveCoupon(db, null), true);
  });
});

// ---------------------------------------------------------------------
// Reserva sin fila: el INSERT del pedido fallo. No hay ni webhook ni sweep
// que puedan volver a liberarla, porque los dos buscan pedidos en la tabla.
// ---------------------------------------------------------------------
describe("releaseOrphanReservation", () => {
  let db;
  beforeEach(async () => { db = await makeDb(); });

  it("baja el contador aunque no exista la fila del pedido", async () => {
    await addCoupon(db, { used: 1 });
    assert.equal(await releaseOrphanReservation(db, "VERDE"), true);
    assert.equal(await usedCount(db), 0);
  });

  it("no hace nada sin codigo", async () => {
    await addCoupon(db, { used: 1 });
    assert.equal(await releaseOrphanReservation(db, ""), false);
    assert.equal(await usedCount(db), 1);
  });

  it("no baja de cero", async () => {
    await addCoupon(db, { used: 0 });
    await releaseOrphanReservation(db, "VERDE");
    assert.equal(await usedCount(db), 0);
  });
});

// ---------------------------------------------------------------------
// applyCoupon: lo que ve el cliente antes de pagar.
// ---------------------------------------------------------------------
describe("applyCoupon", () => {
  let db;
  beforeEach(async () => { db = await makeDb(); });

  it("aplica un porcentaje sobre el total", async () => {
    await db
      .prepare("INSERT INTO coupons (code, type, value) VALUES ('VERDE', 'percent', 10)")
      .run();
    const r = await applyCoupon(db, "verde", 5000);
    assert.deepEqual(r, { code: "VERDE", discount: 500 });
  });

  it("aplica un monto fijo", async () => {
    await db
      .prepare("INSERT INTO coupons (code, type, value) VALUES ('FIJO', 'fixed', 700)")
      .run();
    const r = await applyCoupon(db, "FIJO", 5000);
    assert.equal(r.discount, 700);
  });

  it("nunca descuenta mas que el total", async () => {
    await db
      .prepare("INSERT INTO coupons (code, type, value) VALUES ('FINO', 'fixed', 9999)")
      .run();
    const r = await applyCoupon(db, "FINO", 1000);
    assert.equal(r.discount, 1000);
  });

  it("rechaza un cupon agotado", async () => {
    await addCoupon(db, { maxUses: 2, used: 2 });
    const r = await applyCoupon(db, "VERDE", 5000);
    assert.match(r.error, /no tiene usos disponibles/);
  });

  it("rechaza un cupon inexistente, inactivo o vencido", async () => {
    assert.match((await applyCoupon(db, "NADA", 100)).error, /no existe/);
    await addCoupon(db, { code: "OFF", active: 0 });
    assert.match((await applyCoupon(db, "OFF", 100)).error, /no está activo/);
    await db
      .prepare("INSERT INTO coupons (code, expires_at) VALUES ('VIEJO', ?)")
      .run(new Date(Date.now() - 86400000).toISOString());
    assert.match((await applyCoupon(db, "VIEJO", 100)).error, /vencido/);
  });

  it("exige el minimo del pedido", async () => {
    await db
      .prepare("INSERT INTO coupons (code, type, value, min_total) VALUES ('MIN', 'fixed', 500, 3000)")
      .run();
    assert.match((await applyCoupon(db, "MIN", 1000)).error, /mínimo/);
    assert.equal((await applyCoupon(db, "MIN", 4000)).discount, 500);
  });
});

// ---------------------------------------------------------------------
// Cupones por sucursal (T14). `branch` es OPCIONAL en todas las
// funciones: sin él mantienen el comportamiento actual (las regresiones
// de arriba lo prueban). Con él, la fila se resuelve como:
//   code = ? AND (branch = ? OR branch = '')
// — un cupón local ('necochea'/'tandil') solo vale en SU sucursal;
//   uno global ('') vale en ambas. La unicidad del código sigue siendo
//   GLOBAL (opción 2 del dueño): no puede haber un local y un global
//   con el mismo código.
// ---------------------------------------------------------------------
describe("applyCoupon — scoping por sucursal", () => {
  let db;
  beforeEach(async () => { db = await makeDb(); });

  it("un cupón local de tandil aplica en tandil y NO en necochea", async () => {
    await addCoupon(db, { code: "LOCAL", branch: "tandil", value: 10 });
    assert.deepEqual(await applyCoupon(db, "LOCAL", 5000, "tandil"), { code: "LOCAL", discount: 500 });
    const ajena = await applyCoupon(db, "LOCAL", 5000, "necochea");
    assert.match(ajena.error, /no es válido para esta sucursal/);
  });

  it("un cupón global (branch vacía) aplica en ambas sucursales", async () => {
    await addCoupon(db, { code: "GLOBAL", value: 10 }); // branch '' por defecto
    for (const b of ["necochea", "tandil"]) {
      assert.equal((await applyCoupon(db, "GLOBAL", 5000, b)).discount, 500, `aplica en ${b}`);
    }
  });

  it("en la otra sucursal, un código que no existe sigue siendo 'no existe'", async () => {
    // El scoping no puede disfrazar la inexistencia: el cliente tiene que
    // poder distinguir "lo tipeé mal" de "es de la otra sucursal".
    assert.match((await applyCoupon(db, "FANTASMA", 5000, "necochea")).error, /no existe/);
  });

  it("sin branch, el comportamiento actual no cambia", async () => {
    await addCoupon(db, { code: "LOCAL", branch: "tandil", value: 10 });
    assert.equal((await applyCoupon(db, "LOCAL", 5000)).discount, 500);
  });
});

describe("reserveCoupon — scoping por sucursal", () => {
  let db;
  beforeEach(async () => { db = await makeDb(); });

  it("un cupón local se reserva solo en su sucursal", async () => {
    await addCoupon(db, { code: "LOCAL", branch: "tandil", used: 0 });
    assert.equal(await reserveCoupon(db, "LOCAL", "tandil"), true);
    assert.equal(await usedCount(db, "LOCAL"), 1);
    assert.equal(await reserveCoupon(db, "LOCAL", "necochea"), false, "para necochea el cupón no existe");
    assert.equal(await usedCount(db, "LOCAL"), 1, "y el intento ajeno no toca el contador");
  });

  it("un cupón global se reserva desde ambas sucursales (mismo contador)", async () => {
    await addCoupon(db, { code: "GLOBAL", used: 0 });
    assert.equal(await reserveCoupon(db, "GLOBAL", "necochea"), true);
    assert.equal(await reserveCoupon(db, "GLOBAL", "tandil"), true);
    assert.equal(await usedCount(db, "GLOBAL"), 2, "el global acumula usos de ambas");
  });
});

describe("liberación con branch — baja el contador SOLO de la fila resuelta", () => {
  let db;
  beforeEach(async () => { db = await makeDb(); });

  it("releaseOrderCoupon con branch libera el cupón local de esa sucursal", async () => {
    await addCoupon(db, { code: "LOCAL", branch: "tandil", used: 1 });
    const id = await addOrder(db, { code: "LOCAL", branch: "tandil", payment: "pending", ageMin: 45 });
    assert.equal(await releaseOrderCoupon(db, id, "LOCAL", "tandil"), true);
    assert.equal(await usedCount(db, "LOCAL"), 0);
  });

  it("releaseOrderCoupon con un branch que no resuelve marca el pedido pero NO baja el contador", async () => {
    // Defensivo: un pedido de necochea no puede haber reservado el cupón
    // local de tandil (applyCoupon lo impide). Si igual aparece esa fila
    // (dato viejo, restauración), liberarla no puede regalar un uso del
    // cupón de tandil.
    await addCoupon(db, { code: "LOCAL", branch: "tandil", used: 1 });
    const id = await addOrder(db, { code: "LOCAL", branch: "necochea", payment: "pending", ageMin: 45 });
    assert.equal(await releaseOrderCoupon(db, id, "LOCAL", "necochea"), true, "el pedido se marca liberado igual");
    assert.equal(await usedCount(db, "LOCAL"), 1, "el contador de tandil queda intocado");
  });

  it("releaseOrphanReservation con branch baja la fila resuelta", async () => {
    await addCoupon(db, { code: "LOCAL", branch: "tandil", used: 1 });
    assert.equal(await releaseOrphanReservation(db, "LOCAL", "tandil"), true);
    assert.equal(await usedCount(db, "LOCAL"), 0);
  });

  it("releaseOrphanReservation con un branch que no resuelve no toca nada", async () => {
    await addCoupon(db, { code: "LOCAL", branch: "tandil", used: 1 });
    assert.equal(await releaseOrphanReservation(db, "LOCAL", "necochea"), true);
    assert.equal(await usedCount(db, "LOCAL"), 1);
  });

  it("el sweep libera usando el branch de cada pedido", async () => {
    await addCoupon(db, { code: "LOCAL", branch: "tandil", used: 1 });
    await addOrder(db, { code: "LOCAL", branch: "tandil", payment: "pending", ageMin: 45 });
    await releaseStaleCouponReservations(db);
    assert.equal(await usedCount(db, "LOCAL"), 0);
  });

  it("el sweep no baja un contador que el branch del pedido no resuelve", async () => {
    await addCoupon(db, { code: "LOCAL", branch: "tandil", used: 1 });
    await addOrder(db, { code: "LOCAL", branch: "necochea", payment: "pending", ageMin: 45 });
    await releaseStaleCouponReservations(db);
    assert.equal(await usedCount(db, "LOCAL"), 1, "el cupón local de tandil no se toca");
  });
});
