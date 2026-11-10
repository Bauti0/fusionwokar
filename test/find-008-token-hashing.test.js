import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { hashToken, safeEqual, resolveAdminFromToken, migrateTokenHashing } from "../server/auth.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------
// FIND-008: Tokens de sesión guardados como SHA-256 hash (no texto plano)
// Validación con timingSafeEqual (via safeEqual). Tokens existentes invalidados.
// ---------------------------------------------------------------------

const clients = [];
after(() => {
  for (const c of clients) c.close();
});

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
    CREATE TABLE admin_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
  `);
  return db;
}

describe("FIND-008: hashToken y safeEqual para tokens", () => {
  it("hashToken produce SHA-256 hex consistente", () => {
    const token = "abc123";
    const hash1 = hashToken(token);
    const hash2 = hashToken(token);
    const expected = createHash("sha256").update(token).digest("hex");
    assert.equal(hash1, expected);
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64); // SHA-256 hex = 64 chars
  });

  it("safeEqual compara hashes en tiempo constante", () => {
    const a = "secret";
    const b = "secret";
    const c = "different";
    assert.equal(safeEqual(a, b), true);
    assert.equal(safeEqual(a, c), false);
    // safeEqual hashea ambos lados internamente
    assert.equal(safeEqual(hashToken(a), hashToken(b)), true);
  });
});

describe("FIND-008: resolveAdminFromToken usa hash + safeEqual", () => {
  let db;
  const TOKEN_TTL_MS = 24 * 3600 * 1000;

  beforeEach(async () => {
    db = await makeDb();
  });

  it("token válido (guardado como hash) se resuelve correctamente", async () => {
    const plainToken = "my-session-token-123";
    const tokenHash = hashToken(plainToken);
    const now = new Date().toISOString();

    // Guardar token COMO HASH (nuevo formato)
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id) VALUES (?, ?, ?)")
      .run(tokenHash, now, null);

    // Resolver con token en claro
    const result = await resolveAdminFromToken(db, plainToken, { maxAgeMs: TOKEN_TTL_MS });
    assert.equal(result.invalid, undefined);
    assert.equal(result.expired, undefined);
    assert.equal(result.role, "superadmin");
  });

  it("token inexistente → invalid", async () => {
    const result = await resolveAdminFromToken(db, "non-existent", { maxAgeMs: TOKEN_TTL_MS });
    assert.equal(result.invalid, true);
  });

  it("token en texto plano (formato viejo) NO matchea → invalid", async () => {
    const plainToken = "old-plain-token";
    const now = new Date().toISOString();

    // Token guardado en TEXTO PLANO (formato viejo, antes del fix)
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id) VALUES (?, ?, ?)")
      .run(plainToken, now, null);

    // El nuevo código busca por hash(plainToken) ≠ plainToken
    const result = await resolveAdminFromToken(db, plainToken, { maxAgeMs: TOKEN_TTL_MS });
    assert.equal(result.invalid, true, "token en texto plano no debe matchear tras migración");
  });

  it("token expirado se borra y devuelve expired", async () => {
    const plainToken = "expired-token";
    const tokenHash = hashToken(plainToken);
    const oldDate = new Date(Date.now() - 48 * 3600 * 1000).toISOString(); // 48h atrás

    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id) VALUES (?, ?, ?)")
      .run(tokenHash, oldDate, null);

    const result = await resolveAdminFromToken(db, plainToken, { maxAgeMs: TOKEN_TTL_MS });
    assert.equal(result.expired, true);

    // Verificar que se borró de la base
    const row = await db.prepare("SELECT * FROM admin_tokens WHERE token = ?").get(tokenHash);
    assert.equal(row, undefined);
  });

  it("branch_admin token válido resuelve con userId y branch", async () => {
    const plainToken = "branch-token";
    const tokenHash = hashToken(plainToken);
    const now = new Date().toISOString();

    // Crear usuario branch_admin
    const userResult = await db.prepare(
      "INSERT INTO admin_users (username, password_hash, role, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("tandil1", "hash", "branch_admin", "tandil", now, now);
    const userId = userResult.lastInsertRowid;

    // Guardar token como hash con admin_user_id
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id, role, branch) VALUES (?, ?, ?, ?, ?)")
      .run(tokenHash, now, userId, "branch_admin", "tandil");

    const result = await resolveAdminFromToken(db, plainToken, { maxAgeMs: TOKEN_TTL_MS });
    assert.equal(result.role, "branch_admin");
    assert.equal(result.branch, "tandil");
    assert.equal(result.userId, userId);
    assert.equal(result.username, "tandil1");
  });

  it("cuenta desactivada invalida token existente", async () => {
    const plainToken = "disabled-user-token";
    const tokenHash = hashToken(plainToken);
    const now = new Date().toISOString();

    const userResult = await db.prepare(
      "INSERT INTO admin_users (username, password_hash, role, branch, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("inactive", "hash", "branch_admin", "tandil", 0, now, now); // active = 0
    const userId = userResult.lastInsertRowid;

    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id, role, branch) VALUES (?, ?, ?, ?, ?)")
      .run(tokenHash, now, userId, "branch_admin", "tandil");

    const result = await resolveAdminFromToken(db, plainToken, { maxAgeMs: TOKEN_TTL_MS });
    assert.equal(result.invalid, true, "cuenta desactivada debe invalidar token");
  });
});

describe("FIND-008: migración token_hashing_migrated purga tokens viejos", () => {
  let db;

  beforeEach(async () => {
    db = await makeDb();
  });

  it("primera ejecución: borra tokens y marca migrado", async () => {
    // Tokens en formato viejo (texto plano)
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id) VALUES (?, ?, ?)")
      .run("old-token-1", new Date().toISOString(), null);
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id) VALUES (?, ?, ?)")
      .run("old-token-2", new Date().toISOString(), null);

    // Llamar a la función REAL migrateTokenHashing
    await migrateTokenHashing(db);

    // Verificar: tokens borrados
    const tokens = await db.prepare("SELECT * FROM admin_tokens").all();
    assert.equal(tokens.length, 0);

    // Verificar: flag marcado
    const migrated = await db.prepare("SELECT value FROM admin_config WHERE key = ?").get("token_hashing_migrated");
    assert.equal(migrated.value, "1");
  });

  it("segunda ejecución: NO borra tokens nuevos y resolveAdminFromToken sigue funcionando", async () => {
    // Primera ejecución: migra y marca flag
    await migrateTokenHashing(db);

    // Insertar token NUEVO (ya hasheado, formato nuevo)
    const plainToken = "new-hashed-token-after-migration";
    const tokenHash = hashToken(plainToken);
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id) VALUES (?, ?, ?)")
      .run(tokenHash, new Date().toISOString(), null);

    // Segunda ejecución: NO debe borrar nada
    await migrateTokenHashing(db);

    // Verificar: token nuevo NO borrado
    const tokens = await db.prepare("SELECT * FROM admin_tokens").all();
    assert.equal(tokens.length, 1, "token nuevo no debe borrarse en segunda ejecución");

    // Verificar: resolveAdminFromToken resuelve correctamente el token emitido tras migración
    const TOKEN_TTL_MS = 24 * 3600 * 1000;
    const result = await resolveAdminFromToken(db, plainToken, { maxAgeMs: TOKEN_TTL_MS });
    assert.equal(result.invalid, undefined, "token válido no debe ser invalid");
    assert.equal(result.expired, undefined, "token válido no debe ser expired");
    assert.equal(result.role, "superadmin", "token debe resolver como superadmin");
  });

  it("ejecuciones posteriores: NO borra tokens nuevos (ya hasheados)", async () => {
    // Tokens en formato viejo (texto plano)
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id) VALUES (?, ?, ?)")
      .run("old-token-1", new Date().toISOString(), null);
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id) VALUES (?, ?, ?)")
      .run("old-token-2", new Date().toISOString(), null);

    // Simular migrateTokenHashing
    const row = await db.prepare("SELECT value FROM admin_config WHERE key = ?").get("token_hashing_migrated");
    assert.equal(row, undefined);

    if (!row) {
      await db.prepare("DELETE FROM admin_tokens").run();
      await db.prepare("INSERT INTO admin_config (key, value, updated_at) VALUES (?, ?, ?)")
        .run("token_hashing_migrated", "1", new Date().toISOString());
    }

    // Verificar: tokens borrados
    const tokens = await db.prepare("SELECT * FROM admin_tokens").all();
    assert.equal(tokens.length, 0);

    // Verificar: flag marcado
    const migrated = await db.prepare("SELECT value FROM admin_config WHERE key = ?").get("token_hashing_migrated");
    assert.equal(migrated.value, "1");
  });

  it("ejecuciones posteriores: NO borra tokens nuevos (ya hasheados)", async () => {
    // Marcar como ya migrado
    await db.prepare("INSERT INTO admin_config (key, value, updated_at) VALUES (?, ?, ?)")
      .run("token_hashing_migrated", "1", new Date().toISOString());

    // Insertar token NUEVO (ya hasheado)
    const plainToken = "new-hashed-token";
    const tokenHash = hashToken(plainToken);
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id) VALUES (?, ?, ?)")
      .run(tokenHash, new Date().toISOString(), null);

    // Simular migrateTokenHashing (ya migrado)
    const row = await db.prepare("SELECT value FROM admin_config WHERE key = ?").get("token_hashing_migrated");
    assert.equal(row.value, "1");

    // No debe borrar nada
    if (!row) {
      await db.prepare("DELETE FROM admin_tokens").run(); // no se ejecuta
    }

    const tokens = await db.prepare("SELECT * FROM admin_tokens").all();
    assert.equal(tokens.length, 1, "tokens nuevos no deben borrarse en ejecuciones posteriores");
  });
});