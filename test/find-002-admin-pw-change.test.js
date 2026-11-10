import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import { checkAdminPasswordChange } from "../server/auth.js";

// ---------------------------------------------------------------------
// FIND-002: Cambio de contraseña del superadmin invalida tokens existentes
// Solución simple: tabla admin_config + fingerprint SHA-256 del password
// Al arrancar, si fingerprint cambió → purga tokens con admin_user_id IS NULL
// ---------------------------------------------------------------------

const clients = [];
after(() => {
  for (const c of clients) c.close();
});

async function makeDb() {
  const client = createClient({ url: "file::memory:" });
  clients.push(client);
  const db = createDb(client);
  // Ejecutar schema mínimo necesario
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
  `);
  return db;
}

describe("FIND-002: cambio de contraseña superadmin invalida tokens (mutation check)", () => {
  let db;

  beforeEach(async () => {
    db = await makeDb();
  });

  it("primera ejecución: guarda fingerprint y NO borra tokens", async () => {
    const password = "SuperSecret123";

    // Insertar un token de superadmin (admin_user_id = NULL)
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id) VALUES (?, ?, ?)")
      .run("token-superadmin-1", new Date().toISOString(), null);
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id) VALUES (?, ?, ?)")
      .run("token-superadmin-2", new Date().toISOString(), null);

    // Llamar a la función REAL checkAdminPasswordChange
    await checkAdminPasswordChange(db, password);

    // Verificar: fingerprint guardado (key es "admin_password_hash")
    const saved = await db.prepare("SELECT value FROM admin_config WHERE key = ?").get("admin_password_hash");
    assert.ok(saved, "debe guardar admin_password_hash");
    // El hash debe coincidir con SHA-256 del password
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update(password).digest("hex");
    assert.equal(saved.value, expected, "fingerprint debe ser SHA-256 del password");

    // Verificar: tokens NO borrados
    const tokens = await db.prepare("SELECT * FROM admin_tokens WHERE admin_user_id IS NULL").all();
    assert.equal(tokens.length, 2, "tokens superadmin NO deben borrarse en primera ejecución");
  });

  it("mismo password: NO borra tokens", async () => {
    const password = "SuperSecret123";

    // Fingerprint ya guardado (simular arranque previo)
    await checkAdminPasswordChange(db, password);

    // Insertar tokens superadmin
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id) VALUES (?, ?, ?)")
      .run("token-1", new Date().toISOString(), null);
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id) VALUES (?, ?, ?)")
      .run("token-2", new Date().toISOString(), null);

    // Llamar a la función REAL con MISMO password
    await checkAdminPasswordChange(db, password);

    // No debe borrar nada
    const tokens = await db.prepare("SELECT * FROM admin_tokens WHERE admin_user_id IS NULL").all();
    assert.equal(tokens.length, 2, "mismo password → tokens conservados");
  });

  it("password DISTINTO: borra SOLO tokens superadmin (admin_user_id IS NULL)", async () => {
    const oldPassword = "OldPass123";
    const newPassword = "NewPass456";

    // Primer arranque con password viejo
    await checkAdminPasswordChange(db, oldPassword);

    // Tokens: 2 superadmin (NULL) + 2 branch_admin (con userId)
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id, role, branch) VALUES (?, ?, ?, ?, ?)")
      .run("super-1", new Date().toISOString(), null, "superadmin", "");
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id, role, branch) VALUES (?, ?, ?, ?, ?)")
      .run("super-2", new Date().toISOString(), null, "superadmin", "");
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id, role, branch) VALUES (?, ?, ?, ?, ?)")
      .run("branch-1", new Date().toISOString(), 1, "branch_admin", "tandil");
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id, role, branch) VALUES (?, ?, ?, ?, ?)")
      .run("branch-2", new Date().toISOString(), 2, "branch_admin", "necochea");

    // Segundo arranque con password NUEVO (simula cambio de password en .env)
    await checkAdminPasswordChange(db, newPassword);

    // Verificar: tokens superadmin borrados
    const superTokens = await db.prepare("SELECT * FROM admin_tokens WHERE admin_user_id IS NULL").all();
    assert.equal(superTokens.length, 0, "tokens superadmin DEBEN borrarse");

    // Verificar: tokens branch_admin CONSERVADOS
    const branchTokens = await db.prepare("SELECT * FROM admin_tokens WHERE admin_user_id IS NOT NULL").all();
    assert.equal(branchTokens.length, 2, "tokens branch_admin NO deben borrarse");
    const branches = branchTokens.map(t => t.branch).sort();
    assert.deepEqual(branches, ["necochea", "tandil"]);

    // Verificar: fingerprint actualizado al nuevo password
    const updated = await db.prepare("SELECT value FROM admin_config WHERE key = ?").get("admin_password_hash");
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update(newPassword).digest("hex");
    assert.equal(updated.value, expected, "fingerprint debe actualizarse al nuevo password");
  });

  it("sin ADMIN_PASSWORD (undefined): no hace nada", async () => {
    // No hay password en env, la función debe salir temprano
    await db.prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id) VALUES (?, ?, ?)")
      .run("token-1", new Date().toISOString(), null);

    // Llamar a la función REAL con undefined
    await checkAdminPasswordChange(db, undefined);

    // Tokens quedan intactos
    const tokensAfter = await db.prepare("SELECT * FROM admin_tokens WHERE admin_user_id IS NULL").all();
    assert.equal(tokensAfter.length, 1, "sin password no debe tocar tokens");
  });
});