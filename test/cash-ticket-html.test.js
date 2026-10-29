import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { openCashRegister, closeCashRegister, getSalesReport } from "../server/admin-queries.js";
import { rowToCashRegister, correctCashRegister } from "../server/cash-register.js";
import { buildCashTicketHtml } from "../src/utils/cashTicketHtml.js";
import { formatPrice } from "../src/utils/format.js";

// ============================================================
// buildCashTicketHtml — ticket del CIERRE DE CAJA para la térmica.
//
// Los inputs NO se arman a mano: el cierre sale de openCashRegister +
// closeCashRegister contra SQLite en memoria y se mapea con la MISMA
// función que usa el endpoint (rowToCashRegister de
// server/cash-register.js: una sola fuente de verdad del mapeo; importar
// server/index.js dispararía las migraciones contra la Turso real). El
// desglose por método de pago sale de getSalesReport, el mismo motor de
// GET /api/admin/sales, sobre pedidos insertados de verdad.
// ============================================================

// Cada createClient abre una conexión NATIVA de libsql. Si nunca se cierra,
// el addon la libera en el GC y el proceso muere con 0xC0000005 al terminar
// (mismo motivo que test/admin-cash.test.js).
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
      order_number TEXT UNIQUE NOT NULL,
      branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      payment_method TEXT NOT NULL DEFAULT 'mercadopago',
      payment_status TEXT NOT NULL DEFAULT 'approved',
      total INTEGER NOT NULL DEFAULT 0,
      refunded_amount INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE cash_registers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL,
      opening_amount INTEGER NOT NULL DEFAULT 0,
      opened_at TEXT NOT NULL,
      closing_counted INTEGER,
      closed_at TEXT,
      expected_amount INTEGER,
      difference INTEGER,
      notes TEXT NOT NULL DEFAULT '',
      corrected_at TEXT,
      deleted_at TEXT,
      deleted_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- Esquema mínimo idéntico al de db.js (correctCashRegister la escribe).
    CREATE TABLE cash_register_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cash_register_id INTEGER NOT NULL,
      admin_user_id INTEGER,
      admin_username TEXT NOT NULL,
      admin_role TEXT NOT NULL,
      admin_branch TEXT NOT NULL DEFAULT '',
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL,
      cash_register_id INTEGER,
      amount INTEGER NOT NULL,
      concept TEXT NOT NULL,
      category TEXT,
      payment_method TEXT NOT NULL DEFAULT 'cash',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_by TEXT,
      deleted_at TEXT,
      deleted_by TEXT
    );
  `);
  return db;
}

// Fechas fijas en UTC. En octubre Argentina va a UTC-3, así que
// T0 = 12/10/2026 11:35 y T2 = 12/10/2026 20:00 en hora del local.
// El ticket formatea con timeZone explícito, así que estos asserts no
// dependen de la TZ de la máquina que corre el test.
const T0 = "2026-10-12T14:35:00.000Z";
const T1 = "2026-10-12T15:00:00.000Z";
const T15 = "2026-10-12T15:30:00.000Z";
const T2 = "2026-10-12T23:00:00.000Z";
let seq = 0;

async function addOrder(db, o = {}) {
  seq += 1;
  const ts = o.at || T1;
  await db
    .prepare(
      `INSERT INTO orders
        (order_number, branch, payment_method, payment_status, status, total, refunded_amount, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `FW-${String(seq).padStart(5, "0")}`,
      o.branch || "tandil",
      o.method || "efectivo",
      o.pay || "approved",
      o.status || "completed",
      o.total ?? 1000,
      o.refunded ?? 0,
      ts,
      ts
    );
}

// El mapeo camelCase que devuelve GET /api/admin/cash-register (y que
// consumen el panel y el ticket) se IMPORTA de server/cash-register.js:
// una sola fuente de verdad, nada de réplicas a mano.

async function arqueoCerrado(db, { counted, notas = "" } = {}) {
  const r = await openCashRegister(db, { branch: "tandil", openingAmount: 10000, nowIso: T0 });
  await addOrder(db, { method: "efectivo", total: 5000 });
  await addOrder(db, { method: "mercadopago", total: 3000 });
  await addOrder(db, { method: "transferencia", total: 2000 });
  await closeCashRegister(db, r.id, { counted, notes: notas, scope: "tandil", nowIso: T2 });
  const row = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(r.id);
  const cash = rowToCashRegister(row);
  const sales = await getSalesReport(db, { fromIso: cash.openedAt, toIso: cash.closedAt, scope: "tandil" });
  return { cash, sales };
}

// El texto del documento sin el HTML: lo que se lee en el papel.
function texto(html) {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Cada fila <tr> por separado, para comprobar que un monto no se separa de
// su rótulo.
function filas(html) {
  return html.match(/<tr[\s\S]*?<\/tr>/g) || [];
}

function filaDe(html, nombre) {
  const fila = filas(html).find((f) => f.includes(nombre));
  assert.ok(fila, `no se encontró la fila de "${nombre}"`);
  return fila;
}

// El monto formateado como llega al papel: formatPrice puede traer un
// espacio duro (U+00A0) entre el $ y el número, que la limpieza del ticket
// convierte en espacio normal.
function monto(n) {
  return formatPrice(n).replace(/\u00A0/g, " ");
}

describe("buildCashTicketHtml", () => {
  it("cierre exacto: encabezado, fechas AR, valores de caja y desglose por método", async () => {
    const db = await makeDb();
    const { cash, sales } = await arqueoCerrado(db, { counted: 15000 });
    const html = buildCashTicketHtml({ cash, sales });
    const t = texto(html);

    // Encabezado con local y sucursal (datos de BRANCHES, no del test)
    assert.ok(t.includes("FUSION WOK"), "falta el nombre del local");
    assert.ok(t.includes("Tandil"), "falta la sucursal");
    assert.ok(t.includes("Chacabuco 660"), "falta la dirección de la sucursal");
    assert.ok(t.includes("CIERRE DE CAJA"), "falta el título");

    // Fechas de apertura y cierre en hora de Argentina (UTC-3 en octubre)
    assert.ok(t.includes("Apertura"), "falta la apertura");
    assert.ok(t.includes("12/10/2026 11:35"), `apertura en hora AR, salió: ${t}`);
    assert.ok(t.includes("12/10/2026 20:00"), "falta la hora de cierre en hora AR");

    // Valores FIJOS del cierre (la caja no recalcula nada)
    assert.ok(filaDe(html, "Fondo inicial").includes(monto(10000)));
    assert.ok(filaDe(html, "Efectivo esperado").includes(monto(15000)));
    assert.ok(filaDe(html, "Efectivo contado").includes(monto(15000)));
    assert.ok(filaDe(html, "Diferencia").includes("Caja exacta"));

    // Desglose por método de pago (del reporte) y totales. ">Efectivo<" apunta
    // al renglón del desglose, no a "Efectivo esperado" de la sección de caja.
    assert.ok(filaDe(html, "Venta bruta").includes(monto(10000)));
    assert.ok(filaDe(html, ">Efectivo<").includes(monto(5000)));
    assert.ok(filaDe(html, "Mercado Pago").includes(monto(3000)));
    assert.ok(filaDe(html, "Transferencia").includes(monto(2000)));
    assert.ok(filaDe(html, "Pedidos").includes("3"));
    assert.ok(filaDe(html, "Venta total").includes(monto(10000)));

    // Sin devoluciones no hay fila de devoluciones ni venta neta
    assert.ok(!t.includes("Devoluciones"), "no debe haber fila de devoluciones");
    assert.ok(!t.includes("Venta neta"), "sin devoluciones va Venta total, no Venta neta");

    // El efectivo del reporte cuadra con el del cierre: sin nota de conflicto
    assert.ok(!t.includes("Desglose calculado"), "no debe haber nota de conflicto");

    // Pie de relleno para que la térmica suelte el papel
    assert.ok(html.includes("height:12mm"), "falta el pie de relleno");
  });

  it("faltante: la diferencia se marca como Falta", async () => {
    const db = await makeDb();
    const { cash, sales } = await arqueoCerrado(db, { counted: 14000 });
    const html = buildCashTicketHtml({ cash, sales });
    const t = texto(html);
    assert.ok(filaDe(html, "Diferencia").includes("Falta"), "debe decir Falta");
    assert.ok(t.includes(monto(1000)), "falta el monto de la diferencia");
    assert.ok(!t.includes("Caja exacta"), "no debe decir Caja exacta");
    assert.ok(!t.includes("Sobra"), "no debe decir Sobra");
  });

  it("sobrante: la diferencia se marca como Sobra", async () => {
    const db = await makeDb();
    const { cash, sales } = await arqueoCerrado(db, { counted: 16000 });
    const t = texto(buildCashTicketHtml({ cash, sales }));
    assert.ok(filaDe(buildCashTicketHtml({ cash, sales }), "Diferencia").includes("Sobra"), "debe decir Sobra");
    assert.ok(t.includes(monto(1000)), "falta el monto de la diferencia");
    assert.ok(!t.includes("Falta"), "no debe decir Falta");
    assert.ok(!t.includes("Caja exacta"), "no debe decir Caja exacta");
  });

  it("reporte fallido: el ticket sale igual con los datos del cierre y la nota", async () => {
    const db = await makeDb();
    const { cash } = await arqueoCerrado(db, { counted: 15000 });
    const t = texto(buildCashTicketHtml({ cash, sales: null }));

    // Los datos del cierre siguen todos
    assert.ok(filaDe(buildCashTicketHtml({ cash, sales: null }), "Fondo inicial").includes(monto(10000)));
    assert.ok(t.includes("Caja exacta"));
    assert.ok(t.includes("12/10/2026 20:00"), "la fecha de cierre sigue");

    // Sin desglose: nota en su lugar
    assert.ok(t.includes("Desglose no disponible"), "falta la nota de desglose no disponible");
    assert.ok(!t.includes("Mercado Pago"), "sin reporte no hay desglose por método");
    assert.ok(!t.includes("Venta total"), "sin reporte no hay totales de venta");
  });

  it("devoluciones: venta bruta, devoluciones y venta neta", async () => {
    const db = await makeDb();
    const r = await openCashRegister(db, { branch: "tandil", openingAmount: 10000, nowIso: T0 });
    await addOrder(db, { method: "efectivo", total: 5000 });
    // Devolución total de un pedido de MP: sale de la venta bruta (payment_status
    // refunded) y su plata queda en devuelto.
    await addOrder(db, { method: "mercadopago", total: 3000 });
    await addOrder(db, { method: "mercadopago", total: 2000, pay: "refunded", refunded: 2000 });
    await closeCashRegister(db, r.id, { counted: 15000, notes: "", scope: "tandil", nowIso: T2 });
    const row = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(r.id);
    const cash = rowToCashRegister(row);
    const sales = await getSalesReport(db, { fromIso: cash.openedAt, toIso: cash.closedAt, scope: "tandil" });

    assert.equal(sales.total, 8000, "bruto sin el pedido devuelto");
    assert.equal(sales.devuelto, 2000);
    assert.equal(sales.net, 6000);

    const html = buildCashTicketHtml({ cash, sales });
    const t = texto(html);
    assert.ok(filaDe(html, "Venta bruta").includes(monto(8000)));
    assert.ok(filaDe(html, "Devoluciones").includes(monto(2000)));
    assert.ok(filaDe(html, "Venta neta").includes(monto(6000)));
    assert.ok(!t.includes("Venta total"), "con devoluciones va Venta neta, no Venta total");
    assert.ok(!t.includes("Desglose calculado"), "el efectivo no está en conflicto");
  });

  it("efectivo en conflicto: una sola cifra (la del cierre) y la nota", async () => {
    const db = await makeDb();
    const { cash } = await arqueoCerrado(db, { counted: 15000 });
    // Pedido manual cargado DESPUÉS del cierre con fecha del turno: el reporte
    // del rango lo incluye (efectivo 7000), el esperado del cierre quedó
    // congelado en 15000 (fondo 10000 + efectivo 5000). Conflicto real.
    await addOrder(db, { method: "efectivo", total: 2000, at: T15 });
    const sales = await getSalesReport(db, { fromIso: cash.openedAt, toIso: cash.closedAt, scope: "tandil" });
    assert.equal(sales.byMethod.find((m) => m.method === "efectivo").total, 7000);

    const html = buildCashTicketHtml({ cash, sales });
    const t = texto(html);
    assert.ok(t.includes("Desglose calculado con datos actuales"), "falta la nota de conflicto");
    // La cifra del reporte NO se pinta: el efectivo del papel es el del cierre
    assert.ok(!html.includes("7.000"), "no debe pintarse el efectivo del reporte en conflicto");
    assert.ok(filaDe(html, ">Efectivo<").includes(monto(5000)), "el desglose muestra el efectivo del cierre");
    // El resto del desglose sigue del reporte
    assert.ok(filaDe(html, "Mercado Pago").includes(monto(3000)));
  });

  it("turno sin ventas: desglose vacío y venta total en cero", async () => {
    const db = await makeDb();
    const r = await openCashRegister(db, { branch: "tandil", openingAmount: 5000, nowIso: T0 });
    await closeCashRegister(db, r.id, { counted: 5000, notes: "", scope: "tandil", nowIso: T2 });
    const row = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(r.id);
    const cash = rowToCashRegister(row);
    const sales = await getSalesReport(db, { fromIso: cash.openedAt, toIso: cash.closedAt, scope: "tandil" });
    assert.equal(sales.count, 0);
    assert.deepEqual(sales.byMethod, []);

    const html = buildCashTicketHtml({ cash, sales });
    const t = texto(html);
    assert.ok(filaDe(html, "Venta total").includes(monto(0)));
    assert.ok(filaDe(html, "Pedidos").includes("0"));
    assert.ok(!t.includes("Mercado Pago"), "sin ventas no hay métodos que mostrar");
  });

  it("la nota del cierre sale limpiada para la térmica y escapada para el HTML", async () => {
    const db = await makeDb();
    const { cash, sales } = await arqueoCerrado(db, { counted: 15000, notas: "Ver ató & cuadró <bien>" });
    const html = buildCashTicketHtml({ cash, sales });
    // La limpieza saca tildes (ató → ato, cuadró → cuadro) y el escapado manda
    // & → & y < → <; la secuencia escapada es la que llega al driver.
    // La secuencia escapada se arma por partes para que este archivo no
    // dependa de entidades crudas en su propio código.
    const escapada = ["Ver ato ", "&", "amp; cuadro ", "&", "lt;bien", "&", "gt;"].join("");
    assert.ok(html.includes(escapada), "la nota sale limpia y escapada");
    assert.ok(!html.includes("ató"), "la térmica no puede imprimir la tilde");
  });

  it("cierre corregido: valores vigentes, renglón Corregido y sin nota de conflicto si el efectivo corregido cuadra con el reporte", async () => {
    const db = await makeDb();
    const { cash: cashOriginal } = await arqueoCerrado(db, { counted: 14000 });

    // Un pedido del turno se cargó DESPUÉS del cierre (efectivo real del
    // turno: 7000; el esperado del cierre quedó congelado con 5000). El
    // admin corrige el efectivo cobrado A MANO al valor correcto.
    await addOrder(db, { method: "efectivo", total: 2000, at: T15 });
    // T3 = 13/10/2026 10:00 en hora del local.
    const T3 = "2026-10-13T13:00:00.000Z";
    const r = await correctCashRegister(db, cashOriginal.id, {
      efectivoCobrado: 7000,
      reason: "Pedido en efectivo cargado tarde",
    }, { scope: "tandil", admin: { role: "superadmin", userId: null }, nowIso: T3 });
    assert.ifError(r.error);

    const row = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(cashOriginal.id);
    const cash = rowToCashRegister(row);
    assert.equal(cash.expectedAmount, 17000, "esperado = fondo 10000 + efectivo corregido 7000");
    assert.equal(cash.difference, 14000 - 17000, "diferencia recalculada");
    assert.equal(cash.correctedAt, T3);

    const sales = await getSalesReport(db, { fromIso: cash.openedAt, toIso: cash.closedAt, scope: "tandil" });
    assert.equal(sales.byMethod.find((m) => m.method === "efectivo").total, 7000);

    const html = buildCashTicketHtml({ cash, sales });
    const t = texto(html);
    // Los valores del papel son los VIGENTES (recalculados por la corrección)
    assert.ok(filaDe(html, "Efectivo esperado").includes(monto(17000)));
    assert.ok(filaDe(html, "Efectivo contado").includes(monto(14000)));
    assert.ok(filaDe(html, "Diferencia").includes("Falta"));
    // La marca de corrección con fecha en hora de Argentina
    assert.ok(filaDe(html, "Corregido").includes("13/10/2026 10:00"), "renglón Corregido con fecha AR");
    // El efectivo corregido cuadra con el reporte: NO va la nota de conflicto
    // y la cifra del desglose es la nueva (coinciden, no hay nada que ocultar).
    assert.ok(!t.includes("Desglose calculado"), "sin conflicto no hay nota");
    assert.ok(filaDe(html, ">Efectivo<").includes(monto(7000)));
  });
});
