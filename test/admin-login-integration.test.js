import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { authenticateAdmin, hashToken, safeEqual, resolveAdminFromToken } from "../server/auth.js";
import { randomBytes } from "node:crypto";

const clients = [];
after(() => {
  for (const c of clients) c.close();
});

function now() {
  return new Date().toISOString();
}

const TOKEN_TTL_MS = 24 * 3600 * 1000;

// Crea una app Express de prueba con el endpoint de login real
function createTestApp({ db, envUser, envPassword, resolveAdminFromTokenFn }) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Cookie parser simplificado para tests (leer cookies del header)
  app.use((req, res, next) => {
    const cookieHeader = req.headers.cookie || "";
    req.cookies = {};
    cookieHeader.split(";").forEach((part) => {
      const [key, ...valParts] = part.trim().split("=");
      if (key) req.cookies[key] = decodeURIComponent(valParts.join("="));
    });
    next();
  });

  // Endpoint real de login (adaptado de index.js)
  app.post("/api/admin/login", async (req, res) => {
    console.log("[TEST SERVER] POST /api/admin/login received", req.body);
    try {
      const { username, password } = req.body || {};
      if (!username || !password) {
        console.log("[TEST SERVER] Missing username/password");
        return res.status(400).json({ error: "Usuario y contraseña requeridos" });
      }

      console.log("[TEST SERVER] Calling authenticateAdmin for:", username);
      const admin = await authenticateAdmin(db, {
        username,
        password,
        envUser,
        envPassword,
      });
      console.log("[TEST SERVER] authenticateAdmin result:", admin);

      if (!admin.ok) {
        console.log("[TEST SERVER] Auth failed");
        return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
      }

      // Higiene: purga sesiones vencidas
      try {
        const cutoff = new Date(Date.now() - TOKEN_TTL_MS).toISOString();
        await db.prepare("DELETE FROM admin_tokens WHERE created_at < ?").run(cutoff);
      } catch (purgeErr) {
        console.error("purga admin_tokens:", purgeErr.message);
      }

      const token = randomBytes(32).toString("hex");
      // FIND-008: guardamos el token como SHA-256 hash, no en texto plano.
      const tokenHash = hashToken(token);
      console.log("[TEST SERVER] Inserting token hash for userId:", admin.userId, "role:", admin.role);

      await db
        .prepare(
          "INSERT INTO admin_tokens (token, created_at, admin_user_id, role, branch) VALUES (?, ?, ?, ?, ?)"
        )
        .run(tokenHash, now(), admin.userId, admin.role, admin.branch);

      // Cookie httpOnly: el token nunca queda en localStorage ni en JS.
      res.cookie("fw_admin_token", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: false, // test en HTTP
        maxAge: TOKEN_TTL_MS,
        path: "/",
      });

      // Token CSRF de doble cookie (NO httpOnly: el front lo lee y lo manda como header X-CSRF-Token)
      res.cookie("fw_admin_csrf", randomBytes(32).toString("hex"), {
        httpOnly: false,
        sameSite: "lax",
        secure: false,
        maxAge: TOKEN_TTL_MS,
        path: "/",
      });

      // El token NO se devuelve en el body: solo vive en la cookie httpOnly
      console.log("[TEST SERVER] Sending success response");
      res.json({ ok: true });
    } catch (err) {
      console.error("[TEST SERVER] POST /api/admin/login ERROR:", err);
      res.status(500).json({ error: "Error al iniciar sesión" });
    }
  });

  // Endpoint /me para verificar que la sesión funciona
  app.get("/api/admin/me", async (req, res) => {
    try {
      const token = req.cookies?.fw_admin_token;
      if (!token) {
        return res.status(401).json({ error: "No autenticado" });
      }
      const result = await resolveAdminFromTokenFn(db, token, { maxAgeMs: TOKEN_TTL_MS });
      if (result.invalid || result.expired) {
        return res.status(401).json({ error: "Sesión inválida o expirada" });
      }
      res.json({
        ok: true,
        user: result.username || envUser,
        role: result.role,
        branch: result.branch,
      });
    } catch (err) {
      console.error("GET /api/admin/me:", err);
      res.status(500).json({ error: "Error interno" });
    }
  });

  // Error handler para catch unhandled rejections en Express 5
  app.use((err, req, res, next) => {
    console.error("Express error handler:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

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
  `);
  return db;
}

describe("FIND-008: login HTTP integration - token guardado como hash SHA-256", () => {
  let db;
  let app;
  let server;
  const PORT = 34568;
  const ENV_USER = "superadmin";
  const ENV_PASSWORD = "SuperSecret123";

  before(async () => {
    db = await makeDb();
  });

  beforeEach(async () => {
    console.log("[TEST] beforeEach starting");
    // Limpiar tokens y config entre tests
    await db.prepare("DELETE FROM admin_tokens").run();
    await db.prepare("DELETE FROM admin_config WHERE key IN ('token_hashing_migrated', 'admin_password_hash')").run();
    // Limpiar usuarios de prueba (excepto los que crea makeDb)
    await db.prepare("DELETE FROM admin_users WHERE username LIKE 'test%' OR username = 'tandil1'").run();

    app = createTestApp({ db, envUser: ENV_USER, envPassword: ENV_PASSWORD, resolveAdminFromTokenFn: resolveAdminFromToken });
    server = app.listen(PORT);
    await new Promise((resolve) => server.once("listening", resolve));
    // Pequeña pausa para asegurar que el server está listo (evita ECONNRESET en Windows)
    await new Promise((r) => setTimeout(r, 50));
    console.log("[TEST] beforeEach done, server listening on", PORT);
  });

  afterEach(async () => {
    console.log("[TEST] afterEach closing server");
    await new Promise((resolve) => server.close(resolve));
    console.log("[TEST] afterEach server closed");
  });

  it("POST /api/admin/login con superadmin del .env guarda token como hash de 64 chars hex en DB", async () => {
    // Hacer login
    const loginRes = await fetch(`http://localhost:${PORT}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ENV_USER, password: ENV_PASSWORD }),
      credentials: "include",
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

    // Extraer el token de la cookie (formato: fw_admin_token=valor; ...)
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
    const { hashPassword } = await import("../server/auth.js");
    const passwordHash = hashPassword("branchpass123");
    await db.prepare(
      "INSERT INTO admin_users (username, password_hash, role, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("tandil1", passwordHash, "branch_admin", "tandil", now(), now());

    // Hacer login como branch_admin
    const loginRes = await fetch(`http://localhost:${PORT}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "tandil1", password: "branchpass123" }),
      credentials: "include",
    }).catch((err) => {
      console.error("Fetch error:", err);
      throw err;
    });

    const loginBody = await loginRes.text().catch((err) => {
      console.error("Read body error:", err);
      throw err;
    });
    console.log("Login response:", loginRes.status, loginBody);
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
});