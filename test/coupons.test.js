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
  expireAbandonedPayments,
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
      payment_method TEXT NOT NULL DEFAULT 'mercadopago',
      status TEXT NOT NULL DEFAULT 'received',
      mp_order_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '',
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

async function addOrder(
  db,
  { code = "VERDE", payment = "pending", status = "received", ageMin = 0, branch = "", method = "mercadopago", mpOrderId = null } = {}
) {
  const r = await db
    .prepare(
      `INSERT INTO orders (coupon_code, payment_status, status, payment_method, mp_order_id, created_at, updated_at, branch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(code, payment, status, method, mpOrderId, iso(-ageMin), iso(-ageMin), branch);
  return r.lastInsertRowid;
}

async function usedCount(db, code = "VERDE") {
  const row = await db.prepare("SELECT used_count FROM coupons WHERE code = ?").get(code);
  return row ? Number(row.used_count) : -1;
}

async function orderRow(db, id) {
  const row = await db.prepare("SELECT status, payment_status, coupon_released_at FROM orders WHERE id = ?").get(id);
  return { status: row.status, payment: row.payment_status, released: !!row.coupon_released_at };
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
// BUG-08: los pedidos de MP que el cliente abandonaba (nunca pagados) se
// quedaban en pending_payment PARA SIEMPRE. No es solo que molestaran en
// el panel: el cliente los dejaba de ver a las 2 h (MyOrders.jsx los
// filtra) y el cupón ya lo había liberado el sweep de 30 min, asi que
// quedaban filas huerfanas que nadie iba a cerrar nunca.
// ---------------------------------------------------------------------
describe("expireAbandonedPayments", () => {
  const H = 60; // minutos por hora, para que las edades se lean en test
  let db;
  beforeEach(async () => { db = await makeDb(); });

  it("cancela un pedido de MP de 25 h que sigue sin pago", async () => {
    const id = await addOrder(db, { payment: "pending", status: "pending_payment", ageMin: 25 * H });
    assert.equal(await expireAbandonedPayments(db), 1);
    assert.equal((await orderRow(db, id)).status, "cancelled");
  });

  it("NO toca un pedido de 2 h: todavia esta dentro de la ventana", async () => {
    // 24 h es el umbral. A las 2 h el cliente puede volver a abrir el link de
    // pago de Mercado Pago, que sigue vivo.
    const id = await addOrder(db, { payment: "pending", status: "pending_payment", ageMin: 2 * H });
    assert.equal(await expireAbandonedPayments(db), 0);
    assert.equal((await orderRow(db, id)).status, "pending_payment");
  });

  it("NUNCA toca un pedido aprobado, aunque sea viejo", async () => {
    // El pago fue real: el pedido se cobra, se cocina y se entrega. Da igual
    // cuantos dias tiene.
    const id = await addOrder(db, { payment: "approved", status: "received", ageMin: 30 * H });
    assert.equal(await expireAbandonedPayments(db), 0);
    assert.equal((await orderRow(db, id)).status, "received");
  });

  it("no toca un pedido de efectivo ni de transferencia", async () => {
    // Esos se crean ya aprobados (server/index.js isMp ? pending : approved),
    // pero el filtro no se apoya en eso: mira el metodo de pago explicito.
    const efectivo = await addOrder(db, {
      payment: "pending", status: "pending_payment", method: "efectivo", ageMin: 30 * H,
    });
    const transf = await addOrder(db, {
      payment: "pending", status: "pending_payment", method: "transferencia", ageMin: 30 * H,
    });
    assert.equal(await expireAbandonedPayments(db), 0);
    assert.equal((await orderRow(db, efectivo)).status, "pending_payment");
    assert.equal((await orderRow(db, transf)).status, "pending_payment");
  });

  it("libera el cupón del pedido que cancela", async () => {
    // El caso normal: si el sweep de 30 min todavia no corrió (o si el
    // pedido se creó sin cupon y se le agregó despues), cancelar tiene que
    // devolver el uso.
    await addCoupon(db, { used: 1 });
    const id = await addOrder(db, { payment: "pending", status: "pending_payment", ageMin: 25 * H });
    await expireAbandonedPayments(db);
    assert.equal(await usedCount(db), 0, "el uso vuelve al cupón");
    assert.equal((await orderRow(db, id)).released, true);
  });

  it("libera el cupón UNA sola vez aunque la expiración corra mil veces", async () => {
    // El cupón de otro pedido no se gasta en una corrida repetida: la
    // idempotencia de coupon_released_at tiene que aguantar también acá, no
    // solo en el sweep de 30 min.
    await addCoupon(db, { maxUses: 5, used: 1 });
    await addOrder(db, { payment: "pending", status: "pending_payment", ageMin: 25 * H });

    await expireAbandonedPayments(db);
    assert.equal(await usedCount(db), 0);

    // Llega el pedido B y reserva el suyo.
    await reserveCoupon(db, "VERDE");
    assert.equal(await usedCount(db), 1, "B sostiene su propio uso");

    await expireAbandonedPayments(db);
    await expireAbandonedPayments(db);
    assert.equal(await usedCount(db), 1, "el uso de B no se gasta en corridas repetidas");
  });

  it("el sweep de 30 min y la expiración NO liberan dos veces el mismo uso", async () => {
    // El orden real: el sweep de cupones corre cada 30 min y ya liberó hace
    // rato; 24 h después la expiración pasa de nuevo por ese mismo pedido.
    // Sin el filtro coupon_released_at se restarían dos usos del mismo pedido.
    await addCoupon(db, { used: 1 });
    const id = await addOrder(db, { payment: "pending", status: "pending_payment", ageMin: 25 * H });

    await releaseStaleCouponReservations(db);
    assert.equal(await usedCount(db), 0, "el sweep de 30 min lo liberó");

    await expireAbandonedPayments(db);
    assert.equal((await orderRow(db, id)).status, "cancelled", "igual se cancela");
    assert.equal(await usedCount(db), 0, "y no vuelve a bajar el contador");
  });

  it("deja la fila coherente para el panel: cancelled + pending", async () => {
    // Si solo se liberara el cupón, el pedido quedaria en pending_payment para
    // siempre (el bug). La fila tiene que quedar limpia y sin mp_payment_id
    // inventado: el pago nunca existio.
    const id = await addOrder(db, {
      code: "", payment: "pending", status: "pending_payment", ageMin: 25 * H, mpOrderId: null,
    });
    await expireAbandonedPayments(db);
    const row = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    assert.equal(row.status, "cancelled");
    assert.equal(row.payment_status, "pending");
    assert.equal(row.mp_order_id, null);
    assert.notEqual(row.updated_at, "", "updated_at se toca para que el panel lo vea");
  });

  it("es idempotente: el segundo pase no vuelve a cancelar", async () => {
    const id = await addOrder(db, { payment: "pending", status: "pending_payment", ageMin: 25 * H });
    assert.equal(await expireAbandonedPayments(db), 1, "la primera corrida cancela");
    assert.equal(await expireAbandonedPayments(db), 0, "la segunda no encuentra nada que hacer");
    assert.equal((await orderRow(db, id)).status, "cancelled");
  });

  it("funciona sin cupón", async () => {
    // releaseOrderCoupon devuelve false con code vacío; no debe romper.
    const id = await addOrder(db, { code: "", payment: "pending", status: "pending_payment", ageMin: 25 * H });
    assert.equal(await expireAbandonedPayments(db), 1);
    assert.equal((await orderRow(db, id)).status, "cancelled");
  });

  it("un pedido con mp_order_id de 25 h SE cancela igual (decisión explícita)", async () => {
    // ESTE es el riesgo documentado de BUG-08, y por lo tanto va con test: si
    // el webhook de MP se perdió y el pago estaba aprobado, esta función
    // cancela un pedido pagado. Hoy se acepta: a las 24 h un checkout de MP
    // sin pagar es, casi con seguridad, un abandono.
    //
    // La red que salva ese caso es la RECONCILIACIÓN de index.js
    // (loadPublicOrder → shouldReconcile → reconcilePendingOrder), que
    // consulta la order en MP y aplica el estado real. Pero OJO con lo que
    // esa red NO cubre:
    //   1) es perezosa: solo corre cuando un cliente pide el pedido por
    //      GET /api/orders/:id. MyOrders.jsx deja de mostrar los
    //      pending_payment de más de 2 h, asi que a las 24 h normalmente
    //      NADIE lo está consultando.
    //   2) se saltea entero si isDemoMode(), si mpAuthBroken, si falta
    //      mp_order_id o si payment_status ya no es "pending".
    //   3) NO resucita un pedido ya cancelado: applyMpOrderState solo
    //      promueve el status cuando pre.status === "pending_payment". Si la
    //      expiración corrió primero, la fila queda en
    //      status="cancelled" con payment_status="approved".
    //
    // Este test existe para que esa consecuencia sea una decisión escrita y
    // no una sorpresa. Si algún día se quiere corregir, el cambio es que la
    // expiración consulte MP antes de cancelar (o que applyMpOrderState
    // pueda promover un cancelled), y este test se cambia junto.
    await addCoupon(db, { used: 1 });
    const id = await addOrder(db, {
      payment: "pending", status: "pending_payment", ageMin: 25 * H, mpOrderId: "mp-123456",
    });
    assert.equal(await expireAbandonedPayments(db), 1, "se cancela aunque tenga mp_order_id");
    assert.equal((await orderRow(db, id)).status, "cancelled");
  });

  it("no explota si la tabla no existe", async () => {
    // El sweep es oportunista: un error acá no puede tumbar la creación de un
    // pedido ni el timer de background. Se avisa y se sigue.
    const roto = createDb(createClient({ url: "file::memory:" }));
    await roto.exec("CREATE TABLE otra (x INTEGER)");
    const errores = [];
    const original = console.error;
    console.error = (...a) => errores.push(a.join(" "));
    try {
      assert.equal(await expireAbandonedPayments(roto), 0);
    } finally {
      console.error = original;
    }
    assert.equal(errores.length, 1, "avisa una vez y no propaga");
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
