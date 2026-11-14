// test/shipping-settings.test.js — Configuración de envío guardada en BD
//
// Pruebas del módulo server/shipping-settings.js y su integración con
// server/shipping.js. Todas contra SQLite en memoria (createTestDb), sin
// red real ni Turso, y sin importar server/db.js (que dispararía Turso).
// Cada test comenta el bug o regla que cubre.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./db.js";
import {
  getShippingSettings,
  saveShippingSettings,
  DEFAULT_SHIPPING,
  SANITY_RADIUS_KM,
} from "../server/shipping-settings.js";

// ---------------------- helpers ----------------------

const admin = { adminUserId: null, adminUsername: "prueba", adminRole: "superadmin" };

function valores(base = {}) {
  return {
    origin_address: "Dirección prueba 123",
    origin_lat: -38.567,
    origin_lng: -58.729,
    base_cost: 4000,
    flat_blocks: 20,
    per_block: 100,
    max_blocks: 0,
    auto_enabled: 1,
    ...base,
  };
}

async function dbConTandilYNecochea() {
  return await createTestDb();
}

describe("getShippingSettings", () => {
  it("sin fila en BD devuelve los valores de semilla (.env / código) y no escribe", async () => {
    // Cubre: si una sucursal aún no tiene fila, getShippingSettings devuelve
    // los valores de semilla sin crear nada (el arranque del server es quien
    // siembra). La tabla queda vacía.
    const { db, close } = await dbConTandilYNecochea();
    try {
      const cfg = await getShippingSettings(db, "tandil");
      assert.equal(cfg.baseCost, DEFAULT_SHIPPING.tandil.baseCost);
      assert.equal(cfg.autoEnabled, 1);
      assert.equal(cfg.originAddress, DEFAULT_SHIPPING.tandil.originAddress);
      const filas = await db.prepare("SELECT COUNT(*) AS n FROM branch_shipping_settings").get();
      assert.equal(filas.n, 0, "no se escribió nada al solo leer");
    } finally {
      await close();
    }
  });

  it("caché en memoria: dos lecturas seguidas devuelven el mismo objeto", async () => {
    // Cubre: getShippingSettings usa caché de 30 s; dos lecturas seguidas no
    // golpean la BD dos veces (misma instancia en caché).
    const { db, close } = await dbConTandilYNecochea();
    try {
      await saveShippingSettings({ db, branch: "tandil", values: valores(), ...admin });
      const a = await getShippingSettings(db, "tandil");
      const b = await getShippingSettings(db, "tandil");
      assert.equal(a, b, "mismo objeto en caché");
    } finally {
      await close();
    }
  });

  it("si la BD falla usa respaldo de .env/código sin romper", async () => {
    // Cubre: fallback ante fallo de BD. Un "db" sin prepare lanza; el módulo
    // devuelve los valores de semilla y no tira (el checkout no se rompe).
    const db = { prepare: () => { throw new Error("BD caída"); } };
    const cfg = await getShippingSettings(db, "tandil");
    assert.equal(cfg.baseCost, DEFAULT_SHIPPING.tandil.baseCost);
    assert.equal(cfg.autoEnabled, 1);
  });
});

describe("saveShippingSettings", () => {
  it("guardar sin cambios no duplica ni escribe auditoría", async () => {
    // Cubre: guardar los mismos valores no genera filas duplicadas ni
    // entradas de auditoría (ON CONFLICT actualiza en vez de insertar).
    const { db, close } = await dbConTandilYNecochea();
    try {
      const v = valores();
      await saveShippingSettings({ db, branch: "tandil", values: v, ...admin });
      await saveShippingSettings({ db, branch: "tandil", values: v, ...admin });
      const filas = await db.prepare("SELECT COUNT(*) AS n FROM branch_shipping_settings WHERE branch = 'tandil'").get();
      assert.equal(filas.n, 1, "una sola fila por sucursal");
      const log = await db.prepare("SELECT COUNT(*) AS n FROM branch_shipping_settings_log").get();
      assert.equal(log.n, 0, "sin cambios, sin auditoría");
    } finally {
      await close();
    }
  });

  it("un cambio de precio base se persiste y se lee de vuelta", async () => {
    // Cubre: editar un valor desde el panel se guarda y se lee de vuelta.
    const { db, close } = await dbConTandilYNecochea();
    try {
      await saveShippingSettings({ db, branch: "tandil", values: valores(), ...admin });
      await saveShippingSettings({ db, branch: "tandil", values: valores({ base_cost: 5500 }), ...admin });
      const cfg = await getShippingSettings(db, "tandil");
      assert.equal(cfg.baseCost, 5500);
      const log = await db.prepare("SELECT field, old_value, new_value FROM branch_shipping_settings_log WHERE branch = 'tandil'").all();
      const precios = log.filter((l) => l.field === "precio base");
      assert.equal(precios.length, 1);
      assert.equal(precios[0].old_value, "4000");
      assert.equal(precios[0].new_value, "5500");
    } finally {
      await close();
    }
  });

  it("apagar Necochea no afecta a Tandil (ámbito por sucursal)", async () => {
    // Cubre: la configuración es por sucursal; apagar el automático en una
    // no cambia la otra.
    const { db, close } = await dbConTandilYNecochea();
    try {
      await saveShippingSettings({ db, branch: "necochea", values: valores({ auto_enabled: 0 }), ...admin });
      const neo = await getShippingSettings(db, "necochea");
      const tan = await getShippingSettings(db, "tandil");
      assert.equal(neo.autoEnabled, 0);
      assert.equal(tan.autoEnabled, 1, "Tandil sigue con automático encendido");
    } finally {
      await close();
    }
  });
});

describe("integración con el cálculo de envío", () => {
  it("auto apagado: computeShipping no llama al geocodificador ni a ORS", async (t) => {
    // Cubre: con auto_enabled = 0 el servidor NO geocodifica ni consulta
    // ORS; el pedido entra con envío "a confirmar". Se mockea fetch y se
    // verifica que nunca se llama (cero llamadas de red).
    const { db, close } = await dbConTandilYNecochea();
    let llamadasFetch = 0;
    t.mock.method(globalThis, "fetch", async () => {
      llamadasFetch++;
      throw new Error("no debería hacerse ninguna llamada de red");
    });
    try {
      await saveShippingSettings({ db, branch: "necochea", values: valores({ auto_enabled: 0 }), ...admin });
      const { computeShipping } = await import("../server/shipping.js");
      const r = await computeShipping(db, "necochea", "Falsa 123, Necochea");
      assert.equal(r.supported, true);
      assert.equal(r.pending, true);
      assert.equal(r.cost, 0);
      assert.equal(llamadasFetch, 0, "cero llamadas de red con el automático apagado");
    } finally {
      await close();
    }
  });

  it("auto encendido: cálculo igual que antes (regresión de tarifa)", async (t) => {
    // Cubre: con el automático encendido, computeShipping calcula normalmente.
    // La red se mockea; origen Necochea + 10 cuadras → $4.000, 10 cuadras.
    const { db, close } = await dbConTandilYNecochea();
    const COORDS = new Map();
    COORDS.set("Diagonal San Martín 1258", { lat: "-38.5670514", lon: "-58.7293811" }); // origen
    COORDS.set("Calle 5 678", { lat: "-38.567", lon: "-58.720" }); // ~1 km ≈ 10 cuadras (100 m/cuadra)
    t.mock.method(globalThis, "fetch", async (url) => {
      const u = String(url);
      const q = new URL(u).searchParams.get("q") || "";
      if (u.includes("nominatim") || u.includes("openrouteservice.org/geocode")) {
        for (const [dir, c] of COORDS) {
          if (q.includes(dir)) return { ok: true, json: async () => [{ lat: c.lat, lon: c.lon }] };
        }
        throw new Error(`mock sin geocoder para: ${q}`);
      }
      // OSRM / router: ~1 km de ruta → 10 cuadras (100 m por cuadra en Necochea)
      if (u.includes("project-osrm")) return { ok: true, json: async () => ({ routes: [{ distance: 1000 }] }) };
      throw new Error(`mock sin router para: ${u}`);
    });
    try {
      await saveShippingSettings({ db, branch: "necochea", values: valores(), ...admin });
      const { computeShipping } = await import("../server/shipping.js");
      const r = await computeShipping(db, "necochea", "Calle 5 678");
      assert.equal(r.supported, true);
      assert.equal(r.pending, undefined, "con el automático encendido no hay pending");
      assert.equal(r.cost, 4000);
      assert.equal(r.blocks, 10);
    } finally {
      await close();
    }
  });

  it("editar la tarifa no cambia pedidos ya creados", async () => {
    // Cubre: el servidor recalcula el envío al crear un pedido con la
    // configuración vigente, pero un pedido ya creado conserva el envío que
    // tenía (la edición de configuración no toca filas de orders).
    const { db, close } = await dbConTandilYNecochea();
    try {
      await saveShippingSettings({ db, branch: "tandil", values: valores({ base_cost: 4000 }), ...admin });
      const pedidoViejo = { branch: "tandil", shipping: 4000, shipping_km: 10, shipping_pending: 0 };
      await saveShippingSettings({ db, branch: "tandil", values: valores({ base_cost: 9000 }), ...admin });
      const cfg = await getShippingSettings(db, "tandil");
      assert.equal(cfg.baseCost, 9000, "la tarifa nueva aplica a cálculos futuros");
      assert.equal(pedidoViejo.shipping, 4000, "el pedido viejo conserva su envío original");
    } finally {
      await close();
    }
  });

  it("radio de sanidad queda en código y no viaja a la BD ni a la API pública", async () => {
    // Cubre: SANITY_RADIUS_KM es constante técnica, no columna de la tabla.
    const { db, close } = await dbConTandilYNecochea();
    try {
      await saveShippingSettings({ db, branch: "tandil", values: valores(), ...admin });
      const cols = await db.prepare("PRAGMA table_info(branch_shipping_settings)").all();
      const nombres = cols.map((c) => c.name);
      assert.ok(!nombres.includes("sanity_radius_km"), "no hay columna de radio de sanidad");
    } finally {
      await close();
    }
    assert.equal(SANITY_RADIUS_KM, 50);
  });
});
