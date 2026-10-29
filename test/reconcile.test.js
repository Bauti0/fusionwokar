import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import {
  sweepPendingPayments,
  sweepFailed,
  cronRequestAuthorized,
  SWEEP_DEFAULT_LIMIT,
} from "../server/reconcile.js";
import { expireAbandonedPayments, releaseOrderCoupon } from "../server/coupons.js";
import { cronSecretProblem, MIN_CRON_SECRET_LENGTH } from "../server/config.js";

// ============================================================
// PAY-04 — barrido periódico de reconciliación de pagos.
//
// La regresión que estos tests fijan: si se pierde el webhook de Mercado
// Pago y el cliente cierra la pestaña, un pago APROBADO queda en la base
// como pending_payment y el local nunca lo ve. La única red que había era
// la reconciliación perezosa del polling (GET /api/orders/:id), que solo
// corre si ALGUIEN consulta el pedido — y MyOrders.jsx deja de mostrar los
// pending_payment pasadas las 2 h. El barrido (server/reconcile.js) corre
// periódicamente, disparado por el timer interno de 15 min y por el cron
// externo (POST /api/cron/reconcile).
//
// Se prueba el ORQUESTADOR con SQLite en memoria (createDb de
// server/sqlite.js) y getOrder mockeado: qué pedidos revisa, en qué orden,
// con qué tope y qué contadores devuelve. applyMpOrderState no se puede
// importar sin arrancar el server entero, así que acá se usa una réplica
// mínima de su contrato (makeApplyState, abajo); la máquina de estados
// real sigue siendo la de index.js, que se reusa sin duplicarla.
// ============================================================

const H = 60; // minutos por hora, para que las edades se lean en test

function iso(offsetMin = 0) {
  return new Date(Date.now() + offsetMin * 60000).toISOString();
}

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
  // Mismo esquema mínimo que usa test/coupons.test.js: las columnas que
  // tocan el barrido, la expiración y la contabilidad de cupones.
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
  { code = "", payment = "pending", status = "pending_payment", ageMin = 30, branch = "", method = "mercadopago", mpOrderId = "mp-1" } = {}
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

// La order de MP como la devuelve la Orders API: el estado del pago vive en
// payments[0].status ("processed" = aprobado).
function mpOrder(paymentStatus) {
  return { payments: [{ status: paymentStatus }], refunds: [] };
}

// getOrder de MP mockeado: registra cada llamada (para probar orden, tope y
// que no se consulte lo que no corresponde) y resuelve según el handler.
function makeGetOrder(handler) {
  const calls = [];
  const getOrder = async (mpOrderId) => {
    calls.push(mpOrderId);
    return handler(mpOrderId);
  };
  return { getOrder, calls };
}

// Réplica MÍNIMA del contrato de applyMpOrderState (server/index.js): aplica
// a la BD el estado que reporta la order de MP, promueve a received SOLO si
// venía pending_payment (no pisa el avance del admin) y libera el cupón si
// el pago terminó mal (con la primitiva REAL releaseOrderCoupon, que es la
// idempotente por coupon_released_at). Si ese contrato cambia en index.js,
// este mock y estos tests se actualizan junto.
function makeApplyState(db) {
  return async (row, mp) => {
    const payment = mp.payments && mp.payments[0];
    const status = !payment
      ? "pending"
      : payment.status === "refunded"
        ? "refunded"
        : ["failed", "canceled", "expired", "charged_back"].includes(payment.status)
          ? "rejected"
          : payment.status === "processed"
            ? "approved"
            : "pending";
    await db
      .prepare("UPDATE orders SET payment_status = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(
        status,
        status === "approved" && row.status === "pending_payment" ? "received" : row.status,
        iso(0),
        row.id
      );
    if (status === "rejected" && row.coupon_code) {
      await releaseOrderCoupon(db, row.id, row.coupon_code, row.branch);
    }
    return status;
  };
}

// Barrido con las dependencias típicas de los tests (db en memoria, MP
// simulado, credenciales sanas). Sin shouldReconcile: el filtro fino del
// polling se prueba aparte.
function sweep(db, getOrder, applyState, extra = {}) {
  return sweepPendingPayments({ db, getOrder, applyState, isAuthBroken: () => false, ...extra });
}

// ---------------------------------------------------------------------
// Selección de candidatos: QUÉ pedidos entran al barrido. Si esto se
// filtra de más, un pago aprobado con webhook perdido se queda pendiente
// para siempre; si se filtra de menos, se consultan pedidos sin sentido
// (gasto de requests contra MP).
// ---------------------------------------------------------------------
describe("sweepPendingPayments — selección de candidatos", () => {
  let db;
  beforeEach(async () => {
    db = await makeDb();
  });

  it("30 min con el pago aprobado en MP: el pedido pasa a aprobado/recibido", async () => {
    // El caso de la regresión real: el cliente pagó, cerró la pestaña, el
    // webhook se perdió. Nadie consulta el pedido, así que el barrido es lo
    // único que lo puede aprobar.
    const id = await addOrder(db, { ageMin: 30 });
    const { getOrder, calls } = makeGetOrder(() => mpOrder("processed"));

    const r = await sweep(db, getOrder, makeApplyState(db));

    assert.equal(calls.length, 1, "se consulta la order en MP una sola vez");
    const row = await orderRow(db, id);
    assert.equal(row.payment, "approved", "el pago queda aprobado");
    assert.equal(row.status, "received", "y el pedido promovido a received");
    assert.deepEqual(
      { ...r },
      { revisados: 1, aprobados: 1, rechazados: 0, sinCambios: 0, errores: 0, aborted: false }
    );
  });

  it("5 min: no se toca (el webhook y el polling todavía tienen tiempo)", async () => {
    const id = await addOrder(db, { ageMin: 5 });
    const { getOrder, calls } = makeGetOrder(() => mpOrder("processed"));

    const r = await sweep(db, getOrder, makeApplyState(db));

    assert.equal(calls.length, 0, "ni se consulta a MP");
    assert.equal(r.revisados, 0);
    assert.equal((await orderRow(db, id)).status, "pending_payment", "la fila queda intacta");
  });

  it("25 h: no entra al barrido, a esa edad ya es territorio de la expiración", async () => {
    // La ventana del barrido termina en 24 h justo para no pisar el terreno
    // de expireAbandonedPayments: solaparse no rompería nada (los UPDATEs
    // son condicionales), pero la separación hace los dos invariantes
    // legibles: el barrido reconcilia, la expiración cierra.
    const id = await addOrder(db, { ageMin: 25 * H });
    const { getOrder, calls } = makeGetOrder(() => mpOrder("processed"));

    const r = await sweep(db, getOrder, makeApplyState(db));

    assert.equal(calls.length, 0);
    assert.equal(r.revisados, 0);
    assert.equal((await orderRow(db, id)).status, "pending_payment");
  });

  it("sin mp_order_id se ignora: sin order de MP no hay nada que consultar", async () => {
    // Son los pedidos cuyo link de pago falló al generarse (el reintento
    // de payment-link es su camino), o los de antes del deploy de mp_order_id.
    const id = await addOrder(db, { ageMin: 30, mpOrderId: null });
    const { getOrder, calls } = makeGetOrder(() => mpOrder("processed"));

    const r = await sweep(db, getOrder, makeApplyState(db));

    assert.equal(calls.length, 0);
    assert.equal(r.revisados, 0);
    assert.equal((await orderRow(db, id)).status, "pending_payment");
  });

  it("ya aprobado se ignora: el webhook llegó bien, no hay nada que reconciliar", async () => {
    await addOrder(db, { ageMin: 30, payment: "approved", status: "received" });
    const { getOrder, calls } = makeGetOrder(() => mpOrder("processed"));

    const r = await sweep(db, getOrder, makeApplyState(db));

    assert.equal(calls.length, 0);
    assert.equal(r.revisados, 0);
  });

  it("efectivo y transferencia se ignoran: no hay pago de MP que reconciliar", async () => {
    await addOrder(db, { ageMin: 30, method: "efectivo" });
    await addOrder(db, { ageMin: 30, method: "transferencia" });
    const { getOrder, calls } = makeGetOrder(() => mpOrder("processed"));

    const r = await sweep(db, getOrder, makeApplyState(db));

    assert.equal(calls.length, 0);
    assert.equal(r.revisados, 0);
  });
});

// ---------------------------------------------------------------------
// Procesamiento: cómo trata cada pedido del lote.
// ---------------------------------------------------------------------
describe("sweepPendingPayments — procesamiento", () => {
  let db;
  beforeEach(async () => {
    db = await makeDb();
  });

  it("rechazo en MP libera el cupón UNA sola vez aunque el barrido corra dos veces", async () => {
    // El cliente usó un cupón limitado y el pago fue rechazado con el
    // webhook perdido. La primera corrida devuelve el uso al cupón; si la
    // segunda lo devolviera otra vez, el cupón regalaría usos.
    await addCoupon(db, { maxUses: 5, used: 1 });
    const id = await addOrder(db, { code: "VERDE", ageMin: 30 });
    const { getOrder, calls } = makeGetOrder(() => mpOrder("failed"));

    const r1 = await sweep(db, getOrder, makeApplyState(db));
    assert.equal(r1.rechazados, 1);
    assert.equal(await usedCount(db), 0, "el rechazo devuelve el uso al cupón");

    const r2 = await sweep(db, getOrder, makeApplyState(db));
    assert.equal(await usedCount(db), 0, "la segunda corrida NO vuelve a liberar");
    assert.equal(calls.length, 1, "ni re-consulta a MP: dejó de ser candidato al pasar a rejected");
    assert.equal((await orderRow(db, id)).payment, "rejected");
  });

  it("un error transitorio en un pedido no impide procesar los siguientes", async () => {
    // MP con un 502 puntual en UNA order no puede dejar a todos los demás
    // esperando al próximo ciclo: se cuenta el error y se sigue.
    await addOrder(db, { mpOrderId: "mp-malo", ageMin: 40 });
    const ok = await addOrder(db, { mpOrderId: "mp-bueno", ageMin: 30 });
    const { getOrder } = makeGetOrder((mpOrderId) => {
      if (mpOrderId === "mp-malo") throw new Error("502 de MP");
      return mpOrder("processed");
    });

    const r = await sweep(db, getOrder, makeApplyState(db));

    assert.equal(r.revisados, 2);
    assert.equal(r.errores, 1);
    assert.equal(r.aprobados, 1);
    assert.equal((await orderRow(db, ok)).status, "received", "el pedido siguiente se procesa igual");
  });

  it("mpAuthBroken activo aborta sin llamar a getOrder", async () => {
    // Con el token de MP marcado como roto, cada consulta es una request
    // quemada que ya sabemos cómo termina. El abort es también la señal
    // para el ciclo: como el barrido no pudo confirmar nada, la expiración
    // de ese ciclo no cancela pedidos con mp_order_id.
    await addOrder(db, { ageMin: 30 });
    const { getOrder, calls } = makeGetOrder(() => {
      throw new Error("no se debería haber llamado a getOrder");
    });

    const r = await sweepPendingPayments({
      db,
      getOrder,
      applyState: makeApplyState(db),
      isAuthBroken: () => true,
    });

    assert.deepEqual(
      { ...r },
      { revisados: 0, aprobados: 0, rechazados: 0, sinCambios: 0, errores: 0, aborted: true }
    );
    assert.equal(calls.length, 0, "ni gasta una request: el token ya se sabe roto");
  });

  it("respeta el tope limit y procesa del más viejo al más nuevo", async () => {
    await addOrder(db, { mpOrderId: "mp-nuevo", ageMin: 11 });
    await addOrder(db, { mpOrderId: "mp-medio", ageMin: 30 });
    await addOrder(db, { mpOrderId: "mp-viejo", ageMin: 50 });
    const { getOrder, calls } = makeGetOrder(() => mpOrder("processed"));

    const r = await sweep(db, getOrder, makeApplyState(db), { limit: 2 });

    assert.equal(r.revisados, 2, "con 3 candidatos y tope 2, se procesan 2");
    assert.deepEqual(calls, ["mp-viejo", "mp-medio"], "del más viejo al más nuevo");
  });

  it(`el tope por defecto es ${SWEEP_DEFAULT_LIMIT}`, async () => {
    for (let i = 0; i < 23; i++) {
      await addOrder(db, { mpOrderId: `mp-${i}`, ageMin: 12 + i });
    }
    const { getOrder } = makeGetOrder(() => mpOrder("processed"));

    const r = await sweep(db, getOrder, makeApplyState(db));

    assert.equal(r.revisados, SWEEP_DEFAULT_LIMIT, "los más nuevos quedan para la próxima corrida");
  });

  it("shouldReconcile en false saltea el pedido sin consultar a MP", async () => {
    // En producción el wiring pasa el shouldReconcile del polling tal como
    // existe (demo, credenciales rotas, cooldowns). Si dice "este no", el
    // barrido no lo toca.
    await addOrder(db, { ageMin: 30 });
    const { getOrder, calls } = makeGetOrder(() => mpOrder("processed"));

    const r = await sweep(db, getOrder, makeApplyState(db), { shouldReconcile: () => false });

    assert.equal(calls.length, 0);
    assert.equal(r.revisados, 1);
    assert.equal(r.sinCambios, 1, "cuenta como revisado sin cambios");
  });

  it("no pisa el avance del admin: un preparing ni entra al barrido", async () => {
    // El admin vio el pedido y lo avanzó a mano antes de que el barrido
    // corriera. Al dejar de ser pending_payment deja de ser candidato: el
    // barrido ni lo consulta (y aunque entrara, applyMpOrderState solo
    // promueve pending_payment → received, nunca hacia atrás).
    const id = await addOrder(db, { ageMin: 30, status: "preparing" });
    const { getOrder, calls } = makeGetOrder(() => mpOrder("processed"));

    const r = await sweep(db, getOrder, makeApplyState(db));

    assert.equal(calls.length, 0, "ni se consulta a MP");
    assert.equal(r.revisados, 0);
    assert.equal((await orderRow(db, id)).status, "preparing", "la fila queda como la dejó el admin");
  });

  it("no explota si la tabla orders no existe: cuenta el error y no lanza", async () => {
    // El barrido es oportunista, igual que la expiración: un fallo local no
    // puede tumbar el timer ni el endpoint. Con errores > 0 el ciclo igual
    // saltea los cancelables con mp_order_id (no sabemos nada de MP).
    const rotoClient = createClient({ url: "file::memory:" });
    clients.push(rotoClient);
    const roto = createDb(rotoClient);
    await roto.exec("CREATE TABLE otra (x INTEGER)");
    const { getOrder, calls } = makeGetOrder(() => mpOrder("processed"));
    const original = console.error;
    console.error = () => {};
    try {
      const r = await sweep(roto, getOrder, makeApplyState(roto));
      assert.equal(r.errores, 1);
      assert.equal(r.aborted, false);
    } finally {
      console.error = original;
    }
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------
// sweepFailed: la decisión que el timer toma después del barrido. Es la
// mitad del fix de PAY-04: si el barrido no pudo hablar con MP, la
// expiración NO cancela pedidos con mp_order_id en ese ciclo, porque un
// "pendiente" puede ser un aprobado con el webhook perdido.
// ---------------------------------------------------------------------
describe("sweepFailed", () => {
  it("un barrido abortado (credenciales rotas) es fallido", () => {
    assert.equal(sweepFailed({ revisados: 0, aprobados: 0, rechazados: 0, sinCambios: 0, errores: 0, aborted: true }), true);
  });

  it("un barrido con errores de red es fallido", () => {
    assert.equal(sweepFailed({ revisados: 3, aprobados: 2, rechazados: 0, sinCambios: 0, errores: 1, aborted: false }), true);
  });

  it("un barrido limpio habilita la expiración completa", () => {
    assert.equal(sweepFailed({ revisados: 3, aprobados: 3, rechazados: 0, sinCambios: 0, errores: 0, aborted: false }), false);
  });
});

// ---------------------------------------------------------------------
// El ciclo del timer de index.js: PRIMERO el barrido, DESPUÉS la
// expiración (con skipWithMpOrder según cómo salió el barrido). Este orden
// es el invariante de PAY-04: antes, la expiración era la primera en
// llegar a un pedido de 24 h con el webhook perdido y lo cancelaba aunque
// el pago estuviera aprobado en MP — applyMpOrderState no resucita un
// cancelled, así que era plata quemada sin recuperación.
// ---------------------------------------------------------------------
describe("ciclo del timer: barrido → expiración", () => {
  let db;
  beforeEach(async () => {
    db = await makeDb();
  });

  it("pedido de 23 h con el pago aprobado en MP: el ciclo lo aprueba y NO lo cancela", async () => {
    const id = await addOrder(db, { ageMin: 23 * H });
    const { getOrder } = makeGetOrder(() => mpOrder("processed"));

    // El mismo orden que arma el setInterval de index.js.
    const result = await sweep(db, getOrder, makeApplyState(db));
    await expireAbandonedPayments(db, { skipWithMpOrder: sweepFailed(result) });

    const row = await orderRow(db, id);
    assert.equal(row.payment, "approved");
    assert.equal(row.status, "received", "queda aprobado para el local, no cancelado");
  });

  it("mpAuthBroken: el de 25 h con mp_order_id NO se cancela; el de 25 h sin mp_order_id sí", async () => {
    // Si el barrido abortó, la expiración no puede cancelar NADA que tenga
    // mp_order_id: ese "pendiente" puede ser un pago aprobado que el
    // webhook perdió (y sin credenciales no hay forma de saberlo). Los que
    // no tienen order de MP se cierran igual: nunca hubo un pago posible.
    const conMp = await addOrder(db, { ageMin: 25 * H, mpOrderId: "mp-1" });
    const sinMp = await addOrder(db, { ageMin: 25 * H, mpOrderId: null });
    const { getOrder, calls } = makeGetOrder(() => mpOrder("processed"));

    const result = await sweepPendingPayments({
      db,
      getOrder,
      applyState: makeApplyState(db),
      isAuthBroken: () => true,
    });
    assert.equal(result.aborted, true);
    assert.equal(calls.length, 0);
    await expireAbandonedPayments(db, { skipWithMpOrder: sweepFailed(result) });

    assert.equal((await orderRow(db, conMp)).status, "pending_payment", "se queda para el próximo ciclo");
    assert.equal((await orderRow(db, sinMp)).status, "cancelled", "sin order de MP no hay pago posible");
  });

  it("error de red en el barrido: el de 25 h con mp_order_id tampoco se cancela ese ciclo", async () => {
    // Un candidato joven cuyo getOrder falla es lo que marca el barrido como
    // fallido; el veterano de 25 h ni es candidato, pero ese ciclo tampoco
    // se puede cancelar: no sabemos cómo terminó su pago en MP.
    const conMp = await addOrder(db, { ageMin: 25 * H, mpOrderId: "mp-viejo" });
    await addOrder(db, { ageMin: 30, mpOrderId: "mp-joven" });
    const { getOrder } = makeGetOrder(() => {
      throw new Error("timeout de MP");
    });

    const result = await sweep(db, getOrder, makeApplyState(db));
    assert.equal(result.errores, 1, "el error del candidato se cuenta");
    await expireAbandonedPayments(db, { skipWithMpOrder: sweepFailed(result) });

    assert.equal((await orderRow(db, conMp)).status, "pending_payment", "no se cancela a ciegas");
  });

  it("barrido limpio: la expiración cierra con el comportamiento de siempre", async () => {
    // Sin errores ni abort, el ciclo no cambia nada de BUG-08: los
    // abandonados de 25 h se cancelan igual (riesgo asumido, testeado en
    // coupons.test.js, pero ahora con el barrido que pasa antes).
    const id = await addOrder(db, { ageMin: 25 * H });
    const { getOrder } = makeGetOrder(() => mpOrder("processing"));

    const result = await sweep(db, getOrder, makeApplyState(db));
    await expireAbandonedPayments(db, { skipWithMpOrder: sweepFailed(result) });

    assert.equal((await orderRow(db, id)).status, "cancelled");
  });
});

// ---------------------------------------------------------------------
// Auth del endpoint de cron. La función es pura para poder probarla sin
// levantar el server; el endpoint responde el MISMO 404 que una ruta
// inexistente cuando algo no cuadra (no se confirma que exista).
// ---------------------------------------------------------------------
describe("auth del endpoint de cron (X-Cron-Secret)", () => {
  const SECRET = "cab8f9f0e2d34a5b6c7d8e9f0011223344556677"; // 40 chars, de ejemplo

  it("con el secret correcto autoriza", () => {
    assert.equal(cronRequestAuthorized({ secret: SECRET, header: SECRET }), true);
  });

  it("con un secret incorrecto NO autoriza", () => {
    assert.equal(cronRequestAuthorized({ secret: SECRET, header: "otra-cosa-totalmente-distinta" }), false);
  });

  it("sin header NO autoriza (ausente = incorrecto)", () => {
    assert.equal(cronRequestAuthorized({ secret: SECRET, header: undefined }), false);
    assert.equal(cronRequestAuthorized({ secret: SECRET, header: "" }), false);
  });

  it("sin CRON_SECRET el endpoint queda apagado: nunca autoriza", () => {
    // El secret ausente o corto APAGA el endpoint (404). Así un deploy sin
    // la variable no publica una ruta que acepta cualquier cosa.
    assert.equal(cronRequestAuthorized({ secret: "", header: SECRET }), false);
    assert.equal(cronRequestAuthorized({ secret: undefined, header: SECRET }), false);
  });

  it("un CRON_SECRET más corto que el mínimo deja el endpoint apagado", () => {
    const corto = "a".repeat(MIN_CRON_SECRET_LENGTH - 1);
    assert.equal(cronSecretProblem(corto), "corto");
    assert.equal(cronRequestAuthorized({ secret: corto, header: corto }), false, "aunque el header coincida");
  });

  it("cronSecretProblem distingue falta, corto y válido", () => {
    assert.equal(cronSecretProblem(""), "falta");
    assert.equal(cronSecretProblem(undefined), "falta");
    assert.equal(cronSecretProblem("a".repeat(MIN_CRON_SECRET_LENGTH)), "");
  });
});
