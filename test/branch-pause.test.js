import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import {
  pauseState,
  getPause,
  getAllPauses,
  setPause,
  clearPause,
  parsePauseRequest,
  pauseMessage,
  PAUSE_MIN_MINUTES,
  PAUSE_MAX_MINUTES,
  PAUSE_MESSAGE_MAX,
} from "../server/branch-pause.js";

// ============================================================
// Pausa de pedidos por sucursal (server/branch-pause.js)
//
// El estado vive en la tabla branch_settings y la reapertura es
// automática: paused_until se evalúa AL LEER (pauseState), sin cron
// ni job. Estos tests cubren las regresiones que importan:
//
//  - Sin fila / fila vencida / indefinida tienen que dar los tres
//    estados correctos (un estado pegado en "pausado" dejaría la
//    sucursal cerrada para siempre; uno pegado en "abierto"
//    dejaría entrar pedidos con la cocina frenada).
//  - La pausa es POR SUCURSAL: pausar Tandil no puede frenar los
//    pedidos de Necochea.
//  - Reanudar limpia el estado (mensaje incluido): el aviso viejo
//    no puede quedar mostrándose con los pedidos ya reanudados.
//  - El mensaje que ve el cliente lleva la hora argentina y el
//    mensaje del local, sin importar la zona del server (Render
//    corre en UTC).
//  - La validación del PUT del panel es la única puerta de entrada
//    de datos: minutos fuera de rango o un mensaje con HTML no
//    pueden guardarse.
//
// Esquema espejo del CREATE TABLE de server/db.js y SQLite en
// memoria con createDb (patrón de order-idempotency.test.js): lo que
// importa probar es el upsert ON CONFLICT, y eso es comportamiento
// del motor, no de un mock. NO se importa server/db.js.
// ============================================================

// Cada createClient abre una conexión NATIVA de libsql: sin cerrarla,
// el addon se libera en el GC y el proceso muere con 0xC0000005 al
// terminar (mismo motivo que en test/order-idempotency.test.js).
const clients = [];
after(() => {
  for (const c of clients) c.close();
});

async function makeDb() {
  const client = createClient({ url: "file::memory:" });
  clients.push(client);
  const db = createDb(client);
  await db.exec(`
    CREATE TABLE branch_settings (
      branch TEXT PRIMARY KEY,
      paused_until INTEGER,
      paused_indefinitely INTEGER NOT NULL DEFAULT 0,
      pause_message TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

// Instante fijo: 04/10/2026 12:00 de Argentina (15:00 UTC). Todos los
// "ahora" de los tests salen de acá para que hasta vencida/indefinida
// sea determinista.
const NOW = Date.UTC(2026, 9, 4, 15, 0, 0);
const IN_30_MIN = NOW + 30 * 60000;
const PASSED_5_MIN = NOW - 5 * 60000;
// 14:30 hora argentina de cualquier día: con el server en UTC el
// instante real son las 17:30 UTC.
const AR_1430 = Date.UTC(2026, 9, 4, 17, 30, 0);

function iso(ms) {
  return new Date(ms).toISOString();
}

describe("pauseState (fila → estado)", () => {
  it("sin fila no está pausada", () => {
    assert.deepEqual(pauseState(undefined, NOW), { paused: false, until: null, message: "" });
  });

  it("pausada con vencimiento futuro", () => {
    const state = pauseState(
      { paused_until: IN_30_MIN, paused_indefinitely: 0, pause_message: "sin cajitas" },
      NOW
    );
    assert.equal(state.paused, true);
    assert.equal(state.until, IN_30_MIN);
    assert.equal(state.message, "sin cajitas");
  });

  it("vencida se reabre sola (se calcula al leer, sin cron)", () => {
    // La pausa de ayer no puede dejar la sucursal cerrada hoy.
    const state = pauseState({ paused_until: PASSED_5_MIN, paused_indefinitely: 0, pause_message: "" }, NOW);
    assert.deepEqual(state, { paused: false, until: null, message: "" });
  });

  it("vencida con mensaje también limpia el mensaje (no queda un aviso huérfano)", () => {
    const state = pauseState({ paused_until: PASSED_5_MIN, paused_indefinitely: 0, pause_message: "volvimos ya" }, NOW);
    assert.equal(state.paused, false);
    assert.equal(state.message, "");
  });

  it("indefinida: pausada sin hasta cuándo", () => {
    const state = pauseState({ paused_until: null, paused_indefinitely: 1, pause_message: "corte de luz" }, NOW);
    assert.deepEqual(state, { paused: true, until: null, message: "corte de luz" });
  });

  it("indefinida ignora un paused_until que haya quedado de una pausa anterior", () => {
    // Al pasar de "30 min" a "hasta reanudar" el until viejo no puede
    // reabrir la sucursal: el flag indefinida manda.
    const state = pauseState({ paused_until: PASSED_5_MIN, paused_indefinitely: 1, pause_message: "" }, NOW);
    assert.deepEqual(state, { paused: true, until: null, message: "" });
  });
});

describe("getPause / getAllPauses (SQL)", () => {
  let db;
  beforeEach(async () => {
    db = await makeDb();
  });

  it("sin filas: no pausada y listado vacío", async () => {
    assert.deepEqual(await getPause(db, "tandil", NOW), { paused: false, until: null, message: "" });
    assert.deepEqual(await getAllPauses(db, NOW), { branches: {} });
  });

  it("aislamiento por sucursal: pausar tandil no afecta necochea", async () => {
    await setPause(db, { branch: "tandil", until: IN_30_MIN, indefinite: false, message: "sin cajitas", nowIso: iso(NOW) });
    const tandil = await getPause(db, "tandil", NOW);
    const necochea = await getPause(db, "necochea", NOW);
    assert.equal(tandil.paused, true);
    assert.equal(necochea.paused, false);
    const all = await getAllPauses(db, NOW);
    assert.equal(all.branches.tandil.paused, true);
    assert.equal(all.branches.necochea, undefined);
  });

  it("setPause sobre una pausa existente la reemplaza (upsert, no acumula filas)", async () => {
    await setPause(db, { branch: "tandil", until: IN_30_MIN, indefinite: false, message: "uno", nowIso: iso(NOW) });
    await setPause(db, { branch: "tandil", until: null, indefinite: true, message: "dos", nowIso: iso(NOW) });
    const state = await getPause(db, "tandil", NOW);
    assert.deepEqual(state, { paused: true, until: null, message: "dos" });
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM branch_settings").get();
    assert.equal(Number(rows.n), 1);
  });

  it("reanudar limpia el estado completo (flag, hasta cuándo y mensaje)", async () => {
    await setPause(db, { branch: "necochea", until: null, indefinite: true, message: "cocina saturada", nowIso: iso(NOW) });
    await clearPause(db, { branch: "necochea", nowIso: iso(NOW) });
    assert.deepEqual(await getPause(db, "necochea", NOW), { paused: false, until: null, message: "" });
  });

  it("reanudar una sucursal que nunca se pausó no tira error y deja todo abierto", async () => {
    await clearPause(db, { branch: "tandil", nowIso: iso(NOW) });
    assert.deepEqual(await getPause(db, "tandil", NOW), { paused: false, until: null, message: "" });
  });
});

describe("pauseMessage (texto que ve el cliente, hora argentina)", () => {
  it("con vencimiento: base + mensaje del local + hora argentina", () => {
    const msg = pauseMessage({ paused: true, until: AR_1430, message: "Nos quedamos sin cajitas" });
    assert.equal(
      msg,
      "Por el momento no estamos tomando pedidos. Nos quedamos sin cajitas. Volvemos a las 14:30."
    );
  });

  it("sin mensaje del local no queda un hueco", () => {
    const msg = pauseMessage({ paused: true, until: AR_1430, message: "" });
    assert.equal(msg, "Por el momento no estamos tomando pedidos. Volvemos a las 14:30.");
  });

  it("indefinida: sin promesa de hora (no se puede inventar cuándo vuelve)", () => {
    const msg = pauseMessage({ paused: true, until: null, message: "Corte de luz" });
    assert.equal(msg, "Por el momento no estamos tomando pedidos. Corte de luz.");
  });

  it("pedidos programados: aclara que también quedan pausados", () => {
    const msg = pauseMessage({ paused: true, until: AR_1430, message: "" }, { scheduled: true });
    assert.equal(
      msg,
      "Por el momento no estamos tomando pedidos. Volvemos a las 14:30. Esto incluye los pedidos programados."
    );
  });

  it("no está pausada → texto vacío (nunca se muestra un aviso de más)", () => {
    assert.equal(pauseMessage({ paused: false, until: null, message: "" }), "");
  });
});

describe("parsePauseRequest (validación del PUT del panel)", () => {
  it("pausa por minutos", () => {
    assert.deepEqual(parsePauseRequest({ action: "pause", minutes: 30 }), {
      action: "pause",
      minutes: 30,
      indefinite: false,
      message: "",
    });
  });

  it("pausa por minutos con mensaje (se normaliza con trim)", () => {
    const r = parsePauseRequest({ action: "pause", minutes: 60, message: "  sin cajitas  " });
    assert.equal(r.message, "sin cajitas");
    assert.equal(r.minutes, 60);
  });

  it("pausa hasta reanudar (indefinida)", () => {
    assert.deepEqual(parsePauseRequest({ action: "pause", indefinite: true }), {
      action: "pause",
      minutes: null,
      indefinite: true,
      message: "",
    });
  });

  it("reanudar", () => {
    assert.deepEqual(parsePauseRequest({ action: "resume" }), { action: "resume" });
  });

  it("acción inválida o faltante", () => {
    assert.ok(parsePauseRequest({}).error);
    assert.ok(parsePauseRequest({ action: "delete" }).error);
    assert.ok(parsePauseRequest(null).error);
  });

  it("pausar sin duración no pasa", () => {
    assert.ok(parsePauseRequest({ action: "pause" }).error);
  });

  it("minutos y hasta reanudar a la vez no pasan (es una u otra)", () => {
    assert.ok(parsePauseRequest({ action: "pause", minutes: 30, indefinite: true }).error);
  });

  it("minutos: entero dentro del rango", () => {
    assert.ok(parsePauseRequest({ action: "pause", minutes: "30" }).minutes === 30);
    assert.ok(parsePauseRequest({ action: "pause", minutes: 30.5 }).error);
    assert.ok(parsePauseRequest({ action: "pause", minutes: 0 }).error);
    assert.ok(parsePauseRequest({ action: "pause", minutes: -10 }).error);
    assert.ok(parsePauseRequest({ action: "pause", minutes: PAUSE_MIN_MINUTES - 1 }).error);
    assert.ok(parsePauseRequest({ action: "pause", minutes: PAUSE_MAX_MINUTES + 1 }).error);
    assert.ok(parsePauseRequest({ action: "pause", minutes: "abc" }).error);
  });

  it("los límites exactos del rango pasan", () => {
    assert.ok(parsePauseRequest({ action: "pause", minutes: PAUSE_MIN_MINUTES }).minutes === PAUSE_MIN_MINUTES);
    assert.ok(parsePauseRequest({ action: "pause", minutes: PAUSE_MAX_MINUTES }).minutes === PAUSE_MAX_MINUTES);
  });

  it("mensaje: tope de caracteres", () => {
    assert.ok(parsePauseRequest({ action: "pause", minutes: 30, message: "a".repeat(PAUSE_MESSAGE_MAX + 1) }).error);
    assert.ok(parsePauseRequest({ action: "pause", minutes: 30, message: "a".repeat(PAUSE_MESSAGE_MAX) }).message === "a".repeat(PAUSE_MESSAGE_MAX));
  });

  it("mensaje: sin HTML (se muestra a los clientes)", () => {
    assert.ok(parsePauseRequest({ action: "pause", minutes: 30, message: "<b>hola</b>" }).error);
    assert.ok(parsePauseRequest({ action: "pause", minutes: 30, message: "probá > esto" }).error);
  });

  it("mensaje: sin saltos de línea ni caracteres de control (se muestra en una línea)", () => {
    assert.ok(parsePauseRequest({ action: "pause", minutes: 30, message: "una línea\notra" }).error);
    assert.ok(parsePauseRequest({ action: "pause", minutes: 30, message: "tab\there" }).error);
  });

  it("mensaje: tiene que ser texto (un número o un objeto no pasa)", () => {
    assert.ok(parsePauseRequest({ action: "pause", minutes: 30, message: 12345 }).error);
    assert.ok(parsePauseRequest({ action: "pause", minutes: 30, message: { x: 1 } }).error);
  });

  it("mensaje de puros espacios cuenta como vacío", () => {
    const r = parsePauseRequest({ action: "pause", minutes: 30, message: "    " });
    assert.equal(r.message, "");
  });
});
