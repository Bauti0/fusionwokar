import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import {
  hashPassword,
  verifyPassword,
  normalizeUsername,
  MIN_PASSWORD_LENGTH,
  authenticateAdmin,
  resolveAdminFromToken,
} from "../server/auth.js";

// ============================================================
// auth.js — primitivas de contraseñas y usuarios del panel.
//
// Hoy el panel compara ADMIN_PASSWORD en texto plano contra el .env.
// Con cuentas por sucursal la contraseña pasa a vivir en la base
// (tabla admin_users) y tiene que guardarse hasheada, nunca en claro.
// scrypt es nativo de node:crypto (no suma dependencias) y la
// verificación compara en tiempo constante (timingSafeEqual), igual
// que el resto de las credenciales del server.
// ============================================================

describe("hashPassword / verifyPassword", () => {
  it("verifica la contraseña correcta", () => {
    const hash = hashPassword("una-clave-larga");
    assert.equal(verifyPassword("una-clave-larga", hash), true);
  });

  it("rechaza una contraseña distinta", () => {
    const hash = hashPassword("una-clave-larga");
    assert.equal(verifyPassword("otra-clave", hash), false);
  });

  it("el hash no contiene la contraseña en claro", () => {
    const hash = hashPassword("secreto-visible");
    assert.ok(!hash.includes("secreto-visible"));
  });

  it("dos hashes de la misma contraseña difieren (salt aleatorio por usuario)", () => {
    const a = hashPassword("misma-clave");
    const b = hashPassword("misma-clave");
    assert.notEqual(a, b, "mismo hash = mismo salt = los dos usuarios atacables con una tabla");
    // y los dos verifican igual: el salt viaja adentro del hash guardado
    assert.equal(verifyPassword("misma-clave", a), true);
    assert.equal(verifyPassword("misma-clave", b), true);
  });

  it("un hash corrupto o de otro formato devuelve false sin lanzar", () => {
    // La base puede tener filas viejas o corruptas: verifyPassword no puede
    // tumbar el login con una excepción, tiene que responder false.
    assert.equal(verifyPassword("x", ""), false);
    assert.equal(verifyPassword("x", "no-es-un-hash"), false);
    assert.equal(verifyPassword("x", "scrypt$salt$hash"), false);
  });
});

describe("normalizeUsername", () => {
  it("recorta espacios y pasa a minúsculas", () => {
    assert.equal(normalizeUsername("  Admin "), "admin");
  });

  it("con null o undefined devuelve cadena vacía", () => {
    assert.equal(normalizeUsername(null), "");
    assert.equal(normalizeUsername(undefined), "");
  });
});

describe("MIN_PASSWORD_LENGTH", () => {
  it("es 8 (regla del dueño: mínimo de contraseña para cuentas nuevas)", () => {
    assert.equal(MIN_PASSWORD_LENGTH, 8);
  });
});

// ---------------------------------------------------------------------
// authenticateAdmin / resolveAdminFromToken
//
// Contra un SQLite real en memoria (file::memory:), no mocks: lo que
// importa es cómo resuelve las filas de admin_users/admin_tokens, y
// eso depende del motor. El DDL espeja el que crea server/db.js.
//
// authenticateAdmin mantiene el invariante del login de HOY: una sola
// respuesta para cualquier fallo. No distingue "no existe" de
// "contraseña mal" ni de "cuenta desactivada": distinguir le regala a
// un atacante un oráculo de qué usuarios existen.
// ---------------------------------------------------------------------

function iso(offsetMin = 0) {
  return new Date(Date.now() + offsetMin * 60000).toISOString();
}

// DDL espejo de server/db.js (admin_users + admin_tokens con identidad)
async function makeDb() {
  const client = createClient({ url: "file::memory:" });
  const db = createDb(client);
  await db.exec(`
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
    CREATE TABLE admin_tokens (
      token TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      admin_user_id INTEGER,
      role TEXT NOT NULL DEFAULT 'superadmin',
      branch TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

async function addUser(
  db,
  { username = "tandil1", password = "clave-segura-123", branch = "tandil", active = 1, role = "branch_admin" } = {}
) {
  const ts = iso();
  const r = await db
    .prepare(
      "INSERT INTO admin_users (username, password_hash, role, branch, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(username, hashPassword(password), role, branch, active, ts, ts);
  return Number(r.lastInsertRowid);
}

async function addToken(
  db,
  { token = "tok-1", userId = null, role = "superadmin", branch = "", ageMin = 0 } = {}
) {
  await db
    .prepare(
      "INSERT INTO admin_tokens (token, created_at, admin_user_id, role, branch) VALUES (?, ?, ?, ?, ?)"
    )
    .run(token, iso(-ageMin), userId, role, branch);
}

async function countTokens(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM admin_tokens").get();
  return Number(row.n);
}

const ENV = { envUser: "admin", envPassword: "clave-del-env" };

describe("authenticateAdmin", () => {
  let db;
  beforeEach(async () => {
    db = await makeDb();
  });

  it("las credenciales del .env loguean al superadmin, sin tocar la tabla", async () => {
    const r = await authenticateAdmin(db, {
      username: "admin",
      password: "clave-del-env",
      ...ENV,
    });
    assert.deepEqual(
      { ok: r.ok, role: r.role, branch: r.branch, userId: r.userId },
      { ok: true, role: "superadmin", branch: "", userId: null }
    );
  });

  it("la contraseña del env incorrecta no loguea (aunque el usuario sea el del env)", async () => {
    const r = await authenticateAdmin(db, { username: "admin", password: "cualquiera", ...ENV });
    assert.equal(r.ok, false);
  });

  it("un admin de sucursal loguea con el hash guardado y resuelve su branch", async () => {
    const id = await addUser(db);
    const r = await authenticateAdmin(db, {
      username: "tandil1",
      password: "clave-segura-123",
      ...ENV,
    });
    assert.deepEqual(
      { ok: r.ok, role: r.role, branch: r.branch, userId: r.userId },
      { ok: true, role: "branch_admin", branch: "tandil", userId: id }
    );
  });

  it("la contraseña incorrecta no loguea", async () => {
    await addUser(db);
    const r = await authenticateAdmin(db, {
      username: "tandil1",
      password: "otra-clave",
      ...ENV,
    });
    assert.equal(r.ok, false);
  });

  it("una cuenta desactivada no puede iniciar sesión (aunque la contraseña sea correcta)", async () => {
    // Regla del dueño: desactivar corta el acceso. El login también lo
    // tiene que frenar, no solo el requireAdmin de las requests.
    await addUser(db, { active: 0 });
    const r = await authenticateAdmin(db, {
      username: "tandil1",
      password: "clave-segura-123",
      ...ENV,
    });
    assert.equal(r.ok, false);
  });

  it("un usuario que no existe no loguea", async () => {
    const r = await authenticateAdmin(db, {
      username: "fantasma",
      password: "clave-segura-123",
      ...ENV,
    });
    assert.equal(r.ok, false);
  });

  it("todos los fallos son indistinguibles: la respuesta no revela la causa", async () => {
    // Un atacante no tiene que poder distinguir "usuario existe pero
    // contraseña mal" de "usuario no existe": todas dan lo mismo.
    // activo=0 da lo mismo que los otros dos fallos
    await addUser(db);
    const respuestas = await Promise.all([
      authenticateAdmin(db, { username: "nadie", password: "x", ...ENV }), // usuario inexistente
      authenticateAdmin(db, { username: "tandil1", password: "x", ...ENV }), // contraseña mal
      authenticateAdmin(db, { username: "", password: "x", ...ENV }), // username vacío
    ]);
    // activo=0 da lo mismo que los otros dos fallos
    await db.prepare("UPDATE admin_users SET active = 0").run();
    respuestas.push(await authenticateAdmin(db, { username: "tandil1", password: "clave-segura-123", ...ENV }));
    const serializadas = respuestas.map((r) => JSON.stringify(r));
    assert.ok(serializadas.every((s) => s === serializadas[0]), `respuestas distintas: ${serializadas}`);
  });
});

describe("resolveAdminFromToken", () => {
  let db;
  beforeEach(async () => {
    db = await makeDb();
  });

  it("un token sin admin_user_id es el superadmin (tokens previos al deploy siguen andando)", async () => {
    // Al agregar las columnas, los tokens vivos quedan con
    // admin_user_id NULL. Si esto no resolviera como superadmin, el
    // dueño quedaría fuera del panel en el primer deploy.
    await addToken(db, { token: "viejo", userId: null, role: "superadmin", branch: "" });
    const r = await resolveAdminFromToken(db, "viejo", { maxAgeMs: 24 * 3600 * 1000 });
    assert.deepEqual(
      { role: r.role, branch: r.branch, userId: r.userId },
      { role: "superadmin", branch: "", userId: null }
    );
  });

  it("un token de un admin de sucursal resuelve su rol, branch y username", async () => {
    const id = await addUser(db);
    await addToken(db, { token: "suc", userId: id, role: "branch_admin", branch: "tandil" });
    const r = await resolveAdminFromToken(db, "suc", { maxAgeMs: 24 * 3600 * 1000 });
    assert.equal(r.role, "branch_admin");
    assert.equal(r.branch, "tandil");
    assert.equal(r.userId, id);
    assert.equal(r.username, "tandil1");
  });

  it("una cuenta desactivada invalida su token en el request siguiente", async () => {
    // La sesión "ya abierta" tiene que dejar de funcionar apenas se
    // desactiva la cuenta, no cuando venza el token (24 h).
    const id = await addUser(db);
    await addToken(db, { token: "suc", userId: id, role: "branch_admin", branch: "tandil" });
    await db.prepare("UPDATE admin_users SET active = 0").run();
    const r = await resolveAdminFromToken(db, "suc", { maxAgeMs: 24 * 3600 * 1000 });
    assert.equal(r.invalid, true);
  });

  it("un token vencido responde expired y se borra de la tabla", async () => {
    const id = await addUser(db);
    await addToken(db, { token: "venc", userId: id, role: "branch_admin", branch: "tandil", ageMin: 60 });
    const r = await resolveAdminFromToken(db, "venc", { maxAgeMs: 10 * 60000 });
    assert.equal(r.expired, true);
    assert.equal(await countTokens(db), 0, "el token vencido se purga");
  });

  it("un token inexistente (o vacío) es inválido", async () => {
    await addUser(db);
    assert.equal((await resolveAdminFromToken(db, "no-esta", { maxAgeMs: 24 * 3600 * 1000 })).invalid, true);
    assert.equal((await resolveAdminFromToken(db, "", { maxAgeMs: 24 * 3600 * 1000 })).invalid, true);
  });
});
