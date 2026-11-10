import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { hashToken, hashPassword } from "../server/auth.js";
import { unlinkSync } from "node:fs";

// Configurar TEST_MODE ANTES de importar server/index.js
process.env.TEST_MODE = "true";
process.env.DEMO_MODE = "true";
process.env.TURSO_DATABASE_URL = "file:test-admin-login.db";
process.env.TURSO_AUTH_TOKEN = "";
process.env.MP_WEBHOOK_SECRET = "secreto-de-prueba-del-webhook-fusionwok";
process.env.ADMIN_USER = "superadmin";
process.env.ADMIN_PASSWORD = "SuperSecret123";

let app, db, testMocks, authenticateAdmin, resolveAdminFromToken;

async function loadServer() {
  const mod = await import("../server/index.js");
  app = mod.app;
  db = mod.db;
  testMocks = mod.testMocks;
  authenticateAdmin = mod.authenticateAdmin;
  resolveAdminFromToken = mod.resolveAdminFromToken;
}

const clients = [];
after(() => {
  for (const c of clients) c.close();
  // Limpiar archivo de base de datos de prueba
  try { unlinkSync("test-admin-login.db"); } catch {}
  try { unlinkSync("test-admin-login.db-shm"); } catch {}
  try { unlinkSync("test-admin-login.db-wal"); } catch {}
});

function now() {
  return new Date().toISOString();
}

const PORT = 34568;
const ENV_USER = "superadmin";
const ENV_PASSWORD = "SuperSecret123";

async function makeDb() {
  const client = createClient({ url: "file::memory:" });
  clients.push(client);
  const db = createDb(client);
  await db.exec(`
    CREATE TABLE admin_tokens (
      token TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      admin_user_id INTEGER,
      role TEXT NOT NULL DEFAULT 'superadmin',
      branch TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'branch_admin',
      branch TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE admin_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE webhook_requests (
      request_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

async function addBranchAdmin(db, username = "tandil1", password = "branchpass123", branch = "tandil") {
  const passwordHash = hashPassword(password);
  await db.prepare(
    "INSERT OR IGNORE INTO admin_users (username, password_hash, role, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(username, passwordHash, "branch_admin", branch, now(), now());
}

describe("FIND-008: login HTTP integration - token guardado como hash SHA-256 (app real)", () => {
  let server;

  before(async () => {
    await loadServer();
    await makeDb();
    // Crear superadmin del .env en la base (simula migración)
    const passwordHash = hashPassword(ENV_PASSWORD);
    await db.prepare(
      "INSERT OR IGNORE INTO admin_users (username, password_hash, role, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(ENV_USER, passwordHash, "superadmin", "", now(), now());
  });

  beforeEach(async () => {
    // Limpiar tokens y config entre tests
    await db.prepare("DELETE FROM admin_tokens").run();
    await db.prepare("DELETE FROM admin_config WHERE key IN ('token_hashing_migrated', 'admin_password_hash')").run();

    server = app.listen(PORT);
    await new Promise((resolve) => server.once("listening", resolve));
    await new Promise((r) => setTimeout(r, 50));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    testMocks.refundOrder = undefined;
    testMocks.isDemoMode = undefined;
    await db.prepare("DELETE FROM orders").run();
  });

  it("POST /api/admin/login con superadmin del .env guarda token como hash de 64 chars hex en DB", async () => {
    // Hacer login
    const loginRes = await fetch(`http://localhost:${PORT}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ENV_USER, password: ENV_PASSWORD }),
    });

    const loginBody = await loginRes.text();
    assert.equal(loginRes.status, 200, `Login falló: ${loginBody}`);
    const loginData = JSON.parse(loginBody);
    assert.equal(loginData.ok, true);

    // Verificar que la cookie fw_admin_token se estableció (token en texto plano)
    const setCookie = loginRes.headers.get("set-cookie");
    assert.ok(setCookie, "debe haber header Set-Cookie");
    assert.ok(setCookie.includes("fw_admin_token="), "debe incluir cookie fw_admin_token");
    assert.ok(setCookie.includes("HttpOnly"), "cookie debe ser HttpOnly");
    assert.ok(setCookie.includes("Path=/"), "cookie debe tener Path=/");

    // Extraer el token de la cookie
    const tokenMatch = setCookie.match(/fw_admin_token=([^;]+)/);
    assert.ok(tokenMatch, "debe poder extraer el token de la cookie");
    const cookieToken = tokenMatch[1];
    assert.equal(cookieToken.length, 64, "token en cookie debe ser 64 chars hex (32 bytes)");

    // VERIFICACIÓN CLAVE FIND-008: en la base de datos se guarda el HASH SHA-256 (64 chars hex)
    // NO el token en texto plano
    const rows = await db.prepare("SELECT token FROM admin_tokens").all();
    assert.equal(rows.length, 1, "debe haber exactamente un token en la tabla");

    const storedToken = rows[0].token;
    assert.equal(storedToken.length, 64, "token en DB debe ser 64 chars hex (SHA-256)");
    assert.ok(/^[0-9a-f]{64}$/i.test(storedToken), "token en DB debe ser hex válido");

    // El token en DB DEBE ser el hash SHA-256 del token de la cookie, NO el token en claro
    const expectedHash = hashToken(cookieToken);
    assert.equal(storedToken, expectedHash, "token en DB debe ser hashToken(cookieToken)");

    // Verificar que NO es el mismo valor (no se guarda en texto plano)
    assert.notEqual(storedToken, cookieToken, "token en DB NO debe ser igual al de la cookie (no texto plano)");

    // Verificar que /api/admin/me funciona con la cookie (sesión válida)
    const meRes = await fetch(`http://localhost:${PORT}/api/admin/me`, {
      headers: { Cookie: setCookie },
    });
    assert.equal(meRes.status, 200, `/me falló: status ${meRes.status}`);
    const meData = await meRes.json();
    assert.equal(meData.ok, true);
    assert.equal(meData.role, "superadmin");
  });

  it("POST /api/admin/login con branch_admin guarda token como hash con userId, role y branch", async () => {
    // Crear un usuario branch_admin
    await addBranchAdmin(db, "tandil1", "branchpass123", "tandil");

    // Hacer login como branch_admin
    const loginRes = await fetch(`http://localhost:${PORT}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "tandil1", password: "branchpass123" }),
    });

    const loginBody = await loginRes.text();
    assert.equal(loginRes.status, 200, `Login falló: ${loginBody}`);
    const loginData = JSON.parse(loginBody);
    assert.equal(loginData.ok, true);

    // Verificar cookie
    const setCookie = loginRes.headers.get("set-cookie");
    assert.ok(setCookie, "debe haber header Set-Cookie");
    const tokenMatch = setCookie.match(/fw_admin_token=([^;]+)/);
    const cookieToken = tokenMatch[1];

    // Verificar en DB: token guardado como hash, con userId, role y branch
    const rows = await db.prepare("SELECT token, admin_user_id, role, branch FROM admin_tokens").all();
    assert.equal(rows.length, 1);

    const stored = rows[0];
    assert.equal(stored.token.length, 64, "token en DB debe ser 64 chars hex");
    assert.equal(stored.role, "branch_admin");
    assert.equal(stored.branch, "tandil");
    assert.ok(stored.admin_user_id, "debe tener admin_user_id");

    // Verificar hash
    const expectedHash = hashToken(cookieToken);
    assert.equal(stored.token, expectedHash, "token en DB debe ser hashToken(cookieToken)");
    assert.notEqual(stored.token, cookieToken, "token en DB NO debe ser texto plano");

    // Verificar que /me resuelve correctamente
    const meRes = await fetch(`http://localhost:${PORT}/api/admin/me`, {
      headers: { Cookie: setCookie },
    });
    assert.equal(meRes.status, 200);
    const meData = await meRes.json();
    assert.equal(meData.role, "branch_admin");
    assert.equal(meData.branch, "tandil");
    assert.equal(meData.user, "tandil1");
  });

  it("login fallido NO crea token en la base de datos", async () => {
    const loginRes = await fetch(`http://localhost:${PORT}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "wrong", password: "wrong" }),
    });

    const loginBody = await loginRes.text();
    assert.equal(loginRes.status, 401, `Expected 401, got ${loginRes.status}: ${loginBody}`);

    const rows = await db.prepare("SELECT * FROM admin_tokens").all();
    assert.equal(rows.length, 0, "login fallido no debe crear token");
  });

  it("cookie fw_admin_token tiene atributos de seguridad correctos", async () => {
    const loginRes = await fetch(`http://localhost:${PORT}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ENV_USER, password: ENV_PASSWORD }),
    });

    const setCookie = loginRes.headers.get("set-cookie");
    assert.ok(setCookie.includes("HttpOnly"));
    assert.ok(setCookie.includes("SameSite=Lax"));
    assert.ok(setCookie.includes("Path=/"));
    assert.ok(setCookie.includes("Max-Age="));
    // En test (HTTP) NO debe tener Secure
    assert.ok(!setCookie.includes("Secure"), "en HTTP no debe tener Secure");
  });

  // MUTATION TEST: verifica que el FIX guarda el token como hash (no en texto plano).
  // Si se revierte el fix, este test FALLA porque el token se guardaría en plano.
  it("MUTATION TEST: login guarda token como hash (fix)", async () => {
    // Hacer login
    const loginRes = await fetch(`http://localhost:${PORT}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ENV_USER, password: ENV_PASSWORD }),
    });

    const loginBody = await loginRes.text();
    assert.equal(loginRes.status, 200, `Login falló: ${loginBody}`);
    const loginData = JSON.parse(loginBody);
    assert.equal(loginData.ok, true);

    // Verificar cookie
    const setCookie = loginRes.headers.get("set-cookie");
    const tokenMatch = setCookie.match(/fw_admin_token=([^;]+)/);
    const cookieToken = tokenMatch[1];

    // Verificar en DB: con FIX guarda hashToken(cookieToken)
    // Con BUG guardaría el token plano (igual a cookieToken)
    const rows = await db.prepare("SELECT token FROM admin_tokens").all();
    assert.equal(rows.length, 1);
    const storedToken = rows[0].token;

    // Con el FIX: storedToken === hashToken(cookieToken) (64 chars hex)
    // Con el BUG: storedToken === cookieToken (texto plano)
    const isHashed = storedToken === hashToken(cookieToken);
    const isPlaintext = storedToken === cookieToken;

    // Con el fix aplicado, el token DEBE ser hash (no texto plano)
    assert.equal(isHashed, true, "MUTATION TEST: token debe guardarse como hash (isHashed=true). Si falla, se revirtió el fix FIND-008.");
    assert.equal(isPlaintext, false, "MUTATION TEST: token NO debe guardarse en texto plano (isPlaintext=false). Si falla, se revirtió el fix FIND-008.");
  });
});