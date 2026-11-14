// test/shipping-settings-endpoints.test.js — Endpoints HTTP de configuración de
// envío (GET/PUT /api/admin/shipping-settings, configuración pública).
//
// Corren contra la app real en un puerto temporal y una base de archivo temporal
// (TURSO_DATABASE_URL=file:...). Sin red real ni Turso.
// Cada test comenta el bug o regla que cubre.

process.env.TEST_MODE = "true";
process.env.DEMO_MODE = "true";
process.env.TURSO_DATABASE_URL = "file:test-shipping-settings.db";
process.env.TURSO_AUTH_TOKEN = "";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "fusionwok-endpoints";
process.env.MP_WEBHOOK_SECRET = "x".repeat(40);

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";

const PORT = 34568;
let app, db, server;
let authAdmin, authTan, authNeo;

async function loadServer() {
  const mod = await import("../server/index.js");
  app = mod.app;
  db = mod.db;
}

function baseUrl() {
  return `http://localhost:${PORT}`;
}

function cookieValue(setCookie, name) {
  if (!setCookie) return null;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of list) {
    const m = c.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    if (m) return m[1];
  }
  return null;
}

// Login de admin y devuelve Authorization: Bearer <token>.
// Los Bearer token están exentos de CSRF (middleware de index.js).
async function loginAs(username, password) {
  const res = await fetch(`${baseUrl()}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify({ username, password }),
  });
  assert.ok(res.ok, `login falló para ${username}: ${res.status}`);
  const token = cookieValue(res.headers.get("set-cookie"), "fw_admin_token");
  assert.ok(token, `no se emitió fw_admin_token para ${username}`);
  return { Authorization: `Bearer ${token}` };
}

// Lee el cuerpo UNA sola vez y devuelve { status, json, text }.
async function jres(res) {
  const body = await res.text();
  let json = null;
  try { json = body ? JSON.parse(body) : null; } catch {}
  return { status: res.status, json, text: body };
}

async function get(path, auth) {
  const headers = auth ? { ...auth, Connection: "close" } : { Connection: "close" };
  return jres(await fetch(`${baseUrl()}${path}`, { headers }));
}

async function put(path, body, auth) {
  return jres(await fetch(`${baseUrl()}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...auth, Connection: "close" },
    body: JSON.stringify(body),
  }));
}

const BASE_VALUES = { branch: "tandil", base_cost: 4000, flat_blocks: 20, per_block: 100, max_blocks: 0, auto_enabled: 1 };

describe("endpoints de configuración de envío", () => {
  before(async () => {
    await loadServer();
    server = app.listen(PORT);
    await new Promise((resolve) => server.once("listening", resolve));
    const { hashPassword } = await import("../server/auth.js");
    const ts = new Date().toISOString();
    const hashTan = await hashPassword("tan1234");
    const hashNeo = await hashPassword("neo1234");
    await db.prepare(
      "INSERT OR IGNORE INTO admin_users (username, password_hash, role, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("tan_admin", hashTan, "branch_admin", "tandil", ts, ts);
    authAdmin = await loginAs("admin", "fusionwok-endpoints");
    authTan = await loginAs("tan_admin", "tan1234");
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try { unlinkSync("test-shipping-settings.db"); } catch {}
    try { unlinkSync("test-shipping-settings.db-shm"); } catch {}
    try { unlinkSync("test-shipping-settings.db-wal"); } catch {}
  });

  afterEach(async () => {
    await db.prepare("DELETE FROM branch_shipping_settings").run();
    await db.prepare("DELETE FROM branch_shipping_settings_log").run();
  });

  it("el superadmin sin branch pide 400; con branch=necochea lee la configuración", async () => {
    const r1 = await get("/api/admin/shipping-settings", authAdmin);
    assert.equal(r1.status, 400, `sin branch debe dar 400: ${r1.text}`);

    const rN = await get("/api/admin/shipping-settings?branch=necochea", authAdmin);
    assert.equal(rN.status, 200, rN.text);
    const data = rN.json;
    assert.equal(data.branch, "necochea");
    assert.equal(data.auto_enabled, 1);
    assert.equal(data.base_cost, 4000);
  });

  it("el branch_admin de Tandil no lee Necochea por ?branch= (ignorado)", async () => {
    // El superadmin siembra valores distintos en cada sucursal para diferenciar.
    await put("/api/admin/shipping-settings", { branch: "necochea", base_cost: 9999, flat_blocks: 20, per_block: 100, max_blocks: 0, auto_enabled: 1 }, authAdmin);

    const res = await get("/api/admin/shipping-settings?branch=necochea", authTan);
    assert.equal(res.status, 200, res.text);
    const data = res.json;
    assert.equal(data.branch, "tandil", "el branch_admin lee SU sucursal, no la del ?branch=");
    assert.equal(data.base_cost, 4000, "no leyó el precio de Necochea");
  });

  it("el branch_admin de Tandil no edita Necochea por body.branch", async () => {
    await put("/api/admin/shipping-settings", { branch: "necochea", base_cost: 9999, flat_blocks: 20, per_block: 100, max_blocks: 0, auto_enabled: 1 }, authAdmin);

    const res = await put(
      "/api/admin/shipping-settings",
      { branch: "necochea", base_cost: 7777, flat_blocks: 20, per_block: 100, max_blocks: 0, auto_enabled: 1 },
      authTan
    );
    assert.equal(res.status, 200, res.text);
    // Necochea no cambió (seguía a 9999); Tandil sí fue a 7777 (body.branch ignorado).
    const neo = await get("/api/admin/shipping-settings?branch=necochea", authAdmin);
    assert.equal(neo.json.base_cost, 9999, "Necochea no fue editada por el branch_admin de Tandil");
    const tan = await get("/api/admin/shipping-settings?branch=tandil", authAdmin);
    assert.equal(tan.json.base_cost, 7777, "se editó Tandil (la de la sesión), no Necochea");
  });

  it("validaciones del servidor: precio negativo, lat fuera de Argentina, máximo menor que incluidas", async () => {
    const base = BASE_VALUES;

    let r = await put("/api/admin/shipping-settings", { ...base, base_cost: -500 }, authAdmin);
    assert.equal(r.status, 400, `precio negativo debe dar 400: ${r.text}`);
    assert.equal(r.json.field, "base_cost");

    r = await put("/api/admin/shipping-settings", { ...base, origin_lat: 40.0 }, authAdmin);
    assert.equal(r.status, 400, `lat fuera de Argentina debe dar 400: ${r.text}`);
    assert.equal(r.json.field, "origin_lat");

    r = await put("/api/admin/shipping-settings", { ...base, flat_blocks: 20, max_blocks: 10 }, authAdmin);
    assert.equal(r.status, 400, `máximo menor que incluidas debe dar 400: ${r.text}`);
    assert.equal(r.json.field, "max_blocks");

    r = await put("/api/admin/shipping-settings", { ...base, per_block: 1000001 }, authAdmin);
    assert.equal(r.status, 400, `per_block > 1.000.000 da 400: ${r.text}`);
  });

  it("guardar un cambio válido lo persiste y audita el campo cambiado", async () => {
    const r = await put(
      "/api/admin/shipping-settings",
      { ...BASE_VALUES, base_cost: 5500 },
      authAdmin
    );
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.changed.some((c) => c.field === "precio base" && c.new === "5500"), "auditoría del cambio");
    const cambiado = r.json.changed.find((c) => c.field === "precio base");
    assert.ok(cambiado && cambiado.old !== cambiado.new, "auditoría registra viejo y nuevo");

    const got = await get("/api/admin/shipping-settings?branch=tandil", authAdmin);
    assert.equal(got.json.base_cost, 5500);
  });

  it("configuración pública: solo los campos que necesita la tienda, 404 si la sucursal no existe", async () => {
    const r = await get("/api/shipping-config/necochea");
    assert.equal(r.status, 200, r.text);
    const data = r.json;
    const claves = Object.keys(data).sort();
    assert.deepEqual(claves, ["auto_enabled", "base_cost", "flat_blocks", "max_blocks", "per_block"]);
    assert.ok(!data.origin_lat, "no expone coordenadas del origen");
    assert.ok(!data.updated_by, "no expone auditoría");
    assert.ok(!/ors/i.test(r.text), "no expone la clave de ORS");

    const r404 = await get("/api/shipping-config/desconocida");
    assert.equal(r404.status, 404, "sucursal inexistente da 404");

    const rTan = await get("/api/shipping-config/tandil");
    assert.equal(rTan.status, 200);
    assert.equal(rTan.json.auto_enabled, 1);
  });
});
