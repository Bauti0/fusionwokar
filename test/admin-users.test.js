import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createDb } from "../server/sqlite.js";
import {
  hashPassword,
  verifyPassword,
  authenticateAdmin,
  resolveAdminFromToken,
} from "../server/auth.js";
import {
  listAdminUsers,
  createAdminUser,
  setUserPassword,
  setUserActive,
  deleteAdminUser,
} from "../server/admin-users.js";

// ============================================================
// admin-users.js — gestión de cuentas de sucursal (solo la usa el
// superadmin).
//
// Contra un SQLite real en memoria (file::memory:), igual que
// coupons.test.js: lo que importa son los UPDATE/DELETE que cortan
// sesiones, y eso depende del motor.
//
// Reglas del dueño que este archivo fija:
//   - no puede llamarse igual a ADMIN_USER ni duplicarse (NOCASE)
//   - contraseña mínima de 8
//   - cambiar la contraseña o desactivar BORRAN los tokens abiertos:
//     la sesión viva tiene que cortar al instante, no a las 24 h
//   - borrar una cuenta es DEFINITIVO: elimina la fila y sus tokens
//     (la sesión abierta cae al instante), deja el username libre y
//     no toca pedidos, ventas ni cajas — ninguna tabla los une a la
//     cuenta, solo admin_tokens la apunta.
//     Hasta acá este archivo afirmaba "no hay borrado de cuentas: solo
//     activar/desactivar": el dueño pidió poder borrarlas de verdad.
// ============================================================

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

// Inserta una cuenta SIN pasar por createAdminUser: para probar los
// duplicados y el estado inicial hace falta "ensuciar" la base a mano.
async function rawAddUser(db, { username = "tandil1", password = "clave-segura-123", branch = "tandil", active = 1 } = {}) {
  const ts = iso();
  const r = await db
    .prepare(
      "INSERT INTO admin_users (username, password_hash, role, branch, active, created_at, updated_at) VALUES (?, ?, 'branch_admin', ?, ?, ?, ?)"
    )
    .run(username, hashPassword(password), branch, active, ts, ts);
  return Number(r.lastInsertRowid);
}

async function addToken(db, { token = "tok", userId = null } = {}) {
  await db
    .prepare("INSERT INTO admin_tokens (token, created_at, admin_user_id, role, branch) VALUES (?, ?, ?, ?, ?)")
    .run(token, iso(), userId, "branch_admin", "tandil");
}

async function countTokens(db, userId = null) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM admin_tokens WHERE admin_user_id IS ?")
    .get(userId);
  return Number(row.n);
}

async function getHash(db, id) {
  const row = await db.prepare("SELECT password_hash FROM admin_users WHERE id = ?").get(id);
  return row.password_hash;
}

const ENV = { envUser: "admin", nowIso: iso() };
const CRED = { username: "tandil1", password: "clave-segura-123", branch: "tandil" };

describe("listAdminUsers", () => {
  it("lista vacía al principio", async () => {
    const db = await makeDb();
    assert.deepEqual(await listAdminUsers(db), []);
  });

  it("devuelve las cuentas SIN el hash de la contraseña", async () => {
    const db = await makeDb();
    const { user } = await createAdminUser(db, CRED, ENV);
    const list = await listAdminUsers(db);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, user.id);
    assert.equal(list[0].username, "tandil1");
    assert.equal(list[0].branch, "tandil");
    assert.equal(list[0].active, true);
    assert.ok(!("password_hash" in list[0]), "el hash no puede salir del server");
    assert.ok(!JSON.stringify(list[0]).includes("scrypt"), "nada con pinta de hash en la respuesta");
  });
});

describe("createAdminUser", () => {
  it("crea la cuenta con la contraseña hasheada (nunca en claro)", async () => {
    const db = await makeDb();
    const r = await createAdminUser(db, CRED, ENV);
    assert.equal(r.ok, true);
    assert.equal(r.user.username, "tandil1");
    const hash = await getHash(db, r.user.id);
    assert.ok(!hash.includes("clave-segura-123"), "la contraseña en claro no puede estar en la base");
    assert.equal(verifyPassword("clave-segura-123", hash), true);
  });

  it("rechaza un usuario duplicado, aunque cambien las mayúsculas", async () => {
    const db = await makeDb();
    await createAdminUser(db, CRED, ENV);
    // Exacto...
    let r = await createAdminUser(db, { ...CRED, branch: "necochea" }, ENV);
    assert.match(r.error, /Ya existe una cuenta con ese usuario/);
    // ...y con mayúsculas distintas: "Tandil1" y "tandil1" son la misma cuenta.
    r = await createAdminUser(db, { ...CRED, username: "TANDIL1" }, ENV);
    assert.match(r.error, /Ya existe una cuenta con ese usuario/);
  });

  it("rechaza un usuario igual al principal del .env (sin distinguir mayúsculas)", async () => {
    const db = await makeDb();
    let r = await createAdminUser(db, { ...CRED, username: "admin" }, ENV);
    assert.match(r.error, /No puede llamarse igual al usuario principal/);
    r = await createAdminUser(db, { ...CRED, username: " Admin " }, ENV);
    assert.match(r.error, /No puede llamarse igual al usuario principal/);
  });

  it("rechaza un usuario vacío o demasiado largo", async () => {
    const db = await makeDb();
    assert.match((await createAdminUser(db, { ...CRED, username: "" }, ENV)).error, /Usuario inválido/);
    assert.match((await createAdminUser(db, { ...CRED, username: "   " }, ENV)).error, /Usuario inválido/);
    assert.match(
      (await createAdminUser(db, { ...CRED, username: "x".repeat(61) }, ENV)).error,
      /Usuario inválido/
    );
  });

  it("rechaza una contraseña de menos de 8 caracteres", async () => {
    const db = await makeDb();
    const r = await createAdminUser(db, { ...CRED, password: "siete77" }, ENV);
    assert.match(r.error, /al menos 8/);
    // y no deja basura en la base
    assert.equal((await listAdminUsers(db)).length, 0);
  });

  it("rechaza una sucursal que no sea necochea/tandil", async () => {
    const db = await makeDb();
    assert.match((await createAdminUser(db, { ...CRED, branch: "" }, ENV)).error, /Sucursal inválida/);
    assert.match((await createAdminUser(db, { ...CRED, branch: "bahiablanca" }, ENV)).error, /Sucursal inválida/);
    // las dos válidas crean sin problema
    assert.equal((await createAdminUser(db, { ...CRED, branch: "necochea" }, ENV)).ok, true);
  });
});

describe("setUserPassword", () => {
  it("cambia la contraseña: la vieja deja de servir y la nueva verifica", async () => {
    const db = await makeDb();
    const id = await rawAddUser(db);
    const r = await setUserPassword(db, id, "nueva-clave-456", { nowIso: iso() });
    assert.equal(r.ok, true);
    const hash = await getHash(db, id);
    assert.equal(verifyPassword("nueva-clave-456", hash), true);
    assert.equal(verifyPassword("clave-segura-123", hash), false);
  });

  it("borra los tokens de ESA cuenta (la sesión abierta corta al instante)", async () => {
    const db = await makeDb();
    const id = await rawAddUser(db);
    await addToken(db, { token: "suya", userId: id });
    await setUserPassword(db, id, "nueva-clave-456", { nowIso: iso() });
    assert.equal(await countTokens(db, id), 0, "su token se borra");
    assert.equal((await resolveAdminFromToken(db, "suya", { maxAgeMs: 24 * 3600 * 1000 })).invalid, true);
  });

  it("no toca los tokens de las OTRAS cuentas", async () => {
    const db = await makeDb();
    const a = await rawAddUser(db, { username: "a", branch: "necochea" });
    const b = await rawAddUser(db, { username: "b" });
    await addToken(db, { token: "de-a", userId: a });
    await setUserPassword(db, b, "nueva-clave-456", { nowIso: iso() });
    assert.equal(await countTokens(db, a), 1, "el token de la otra cuenta sigue vivo");
  });

  it("exige el mínimo de 8 y avisa si la cuenta no existe", async () => {
    const db = await makeDb();
    const id = await rawAddUser(db);
    assert.match((await setUserPassword(db, id, "corta", { nowIso: iso() })).error, /al menos 8/);
    assert.match((await setUserPassword(db, 999, "nueva-clave-456", { nowIso: iso() })).error, /Cuenta no encontrada/);
  });
});

describe("setUserActive", () => {
  it("desactivar corta el acceso: el token muere y el login se rechaza", async () => {
    const db = await makeDb();
    const id = await rawAddUser(db);
    await addToken(db, { token: "suya", userId: id });
    const r = await setUserActive(db, id, false, { nowIso: iso() });
    assert.equal(r.ok, true);
    assert.equal(await countTokens(db, id), 0, "su token se borra");
    assert.equal((await resolveAdminFromToken(db, "suya", { maxAgeMs: 24 * 3600 * 1000 })).invalid, true);
    const login = await authenticateAdmin(db, {
      username: "tandil1",
      password: "clave-segura-123",
      envUser: "admin",
      envPassword: "otra",
    });
    assert.equal(login.ok, false, "una cuenta desactivada no puede iniciar sesión");
  });

  it("reactivar devuelve el acceso con la MISMA contraseña", async () => {
    const db = await makeDb();
    const id = await rawAddUser(db);
    await setUserActive(db, id, false, { nowIso: iso() });
    await setUserActive(db, id, true, { nowIso: iso() });
    const login = await authenticateAdmin(db, {
      username: "tandil1",
      password: "clave-segura-123",
      envUser: "admin",
      envPassword: "otra",
    });
    assert.equal(login.ok, true, "reactivar habilita el login de nuevo");
  });

  it("avisa si la cuenta no existe", async () => {
    const db = await makeDb();
    assert.match((await setUserActive(db, 999, false, { nowIso: iso() })).error, /Cuenta no encontrada/);
  });
});

describe("deleteAdminUser", () => {
  it("borra la fila y sus tokens: la sesión abierta deja de ser válida", async () => {
    const db = await makeDb();
    const id = await rawAddUser(db);
    await addToken(db, { token: "suya", userId: id });
    const r = await deleteAdminUser(db, id);
    assert.equal(r.ok, true);
    assert.equal((await listAdminUsers(db)).length, 0, "la fila desaparece del listado");
    assert.equal(await countTokens(db, id), 0, "sus tokens se borran");
    assert.equal(
      (await resolveAdminFromToken(db, "suya", { maxAgeMs: 24 * 3600 * 1000 })).invalid,
      true,
      "la sesión abierta cae al instante"
    );
  });

  it("borrar un id inexistente da error", async () => {
    const db = await makeDb();
    assert.match((await deleteAdminUser(db, 999)).error, /Cuenta no encontrada/);
  });

  it("borrar una cuenta no afecta a las OTRAS (ni sus tokens)", async () => {
    const db = await makeDb();
    const a = await rawAddUser(db, { username: "a", branch: "necochea" });
    const b = await rawAddUser(db, { username: "b" });
    await addToken(db, { token: "de-a", userId: a });
    await addToken(db, { token: "de-b", userId: b });
    const r = await deleteAdminUser(db, b);
    assert.equal(r.ok, true);
    const list = await listAdminUsers(db);
    assert.equal(list.length, 1, "la otra cuenta sigue en la base");
    assert.equal(list[0].username, "a");
    assert.equal(await countTokens(db, a), 1, "el token de la otra cuenta sigue vivo");
  });

  it("el username borrado se puede volver a crear", async () => {
    const db = await makeDb();
    const { user } = await createAdminUser(db, CRED, ENV);
    assert.equal((await deleteAdminUser(db, user.id)).ok, true);
    const re = await createAdminUser(db, CRED, ENV);
    assert.equal(re.ok, true, "el username queda libre después del borrado");
    assert.equal(re.user.username, "tandil1");
  });
});
