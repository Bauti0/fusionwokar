import { BRANCHES } from "../src/data/branches.js";
import { hashPassword, normalizeUsername, MIN_PASSWORD_LENGTH } from "./auth.js";

// ============================================================
// FUSIÓN WOK — Cuentas de admin por sucursal (server/admin-users.js)
//
// Solo el superadmin llega acá (los endpoints de /api/admin/users
// exigen requireSuperadmin). El superadmin mismo NO es una cuenta:
// sigue siendo el ADMIN_USER/ADMIN_PASSWORD del .env, y esta tabla
// guarda únicamente los admins de necochea/tandil.
//
// Invariantes que este módulo mantiene (los tests los fijan):
//   - la contraseña NUNCA se guarda en claro: siempre hash scrypt
//   - el username no puede duplicarse ni llamarse igual al del .env
//     (comparación NOCASE: "Tandil1" y "tandil1" son la misma cuenta)
//   - cambiar la contraseña o desactivar la cuenta BORRAN sus tokens:
//     la sesión abierta corta en el request siguiente, no a las 24 h
//   - borrar una cuenta es definitivo: elimina la fila y sus tokens
//     (la sesión abierta cae al instante) y deja el username libre.
//     No toca pedidos, ventas ni cajas: ninguna tabla los une a la
//     cuenta, solo admin_tokens la apunta. Antes no existía el
//     borrado (solo activar/desactivar); ahora sí, a pedido del dueño.
//
// Recibe `db` por parámetro (patrón de coupons.js) para probarse
// contra un SQLite en memoria sin importar el singleton de db.js.
// ============================================================

// Límites de los campos de texto. El de contraseña evita que un login
// con una contraseña de un millón de caracteres pase un minuto
// hasheando en scrypt.
const MAX_USERNAME_LENGTH = 60;
const MAX_PASSWORD_LENGTH = 128;

// Convierte una fila de admin_users en el objeto que viaja al panel.
// NUNCA incluye password_hash: lo que sale de acá se responde por HTTP.
function toAdminUser(row) {
  return {
    id: row.id,
    username: row.username,
    branch: row.branch,
    role: row.role,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

export async function listAdminUsers(db) {
  const rows = await db
    .prepare("SELECT id, username, branch, role, active, created_at FROM admin_users ORDER BY id")
    .all();
  return rows.map(toAdminUser);
}

// Validación compartida por crear y cambiar contraseña. Vacío = sirve.
function passwordProblem(password) {
  const pass = String(password || "");
  if (pass.length < MIN_PASSWORD_LENGTH) {
    return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`;
  }
  if (pass.length > MAX_PASSWORD_LENGTH) return "La contraseña es demasiado larga";
  return "";
}

export async function createAdminUser(db, { username, password, branch }, { envUser, nowIso }) {
  const user = String(username || "").trim();
  if (!user || user.length > MAX_USERNAME_LENGTH) return { error: "Usuario inválido" };
  const passProblem = passwordProblem(password);
  if (passProblem) return { error: passProblem };
  // Las sucursales válidas salen de branches.js (mismo catálogo que el
  // resto de la app): nada de aceptar ids fantasma.
  if (!BRANCHES[branch]) return { error: "Sucursal inválida" };
  // El dueño no puede ser reemplazado por una cuenta con su mismo
  // nombre: habría dos caminos al panel con distinta potencia.
  if (normalizeUsername(user) === normalizeUsername(envUser)) {
    return { error: "No puede llamarse igual al usuario principal" };
  }
  // La tabla compara usernames con COLLATE NOCASE: este chequeo cubre
  // "Tandil1" vs "tandil1" sin lógica extra.
  const dup = await db.prepare("SELECT 1 FROM admin_users WHERE username = ?").get(user);
  if (dup) return { error: "Ya existe una cuenta con ese usuario" };
  const ts = nowIso;
  const r = await db
    .prepare(
      "INSERT INTO admin_users (username, password_hash, role, branch, active, created_at, updated_at) VALUES (?, ?, 'branch_admin', ?, 1, ?, ?)"
    )
    .run(user, hashPassword(password), branch, ts, ts);
  const row = await db
    .prepare("SELECT id, username, branch, role, active, created_at FROM admin_users WHERE id = ?")
    .get(Number(r.lastInsertRowid));
  return { ok: true, user: toAdminUser(row) };
}

// Cambia la contraseña de una cuenta. BORRA los tokens de esa cuenta:
// si el admin de una sucursal entregó su clave, cambiarla tiene que
// cerrar también las sesiones abiertas, no solo las próximas.
export async function setUserPassword(db, id, password, { nowIso }) {
  const passProblem = passwordProblem(password);
  if (passProblem) return { error: passProblem };
  const row = await db.prepare("SELECT id FROM admin_users WHERE id = ?").get(id);
  if (!row) return { error: "Cuenta no encontrada" };
  await db
    .prepare("UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .run(hashPassword(password), nowIso, id);
  await db.prepare("DELETE FROM admin_tokens WHERE admin_user_id = ?").run(id);
  return { ok: true };
}

// Activa/desactiva una cuenta. Desactivar BORRA sus tokens: la sesión
// viva corta al instante (regla del dueño), aunque el token mismo
// no haya vencido.
export async function setUserActive(db, id, active, { nowIso }) {
  const row = await db.prepare("SELECT id FROM admin_users WHERE id = ?").get(id);
  if (!row) return { error: "Cuenta no encontrada" };
  const value = active ? 1 : 0;
  await db.prepare("UPDATE admin_users SET active = ?, updated_at = ? WHERE id = ?").run(value, nowIso, id);
  if (!value) {
    await db.prepare("DELETE FROM admin_tokens WHERE admin_user_id = ?").run(id);
  }
  return { ok: true, active: value === 1 };
}

// Borra una cuenta DEFINITIVAMENTE. Borra también todos sus tokens
// para que la sesión abierta caiga al instante (misma regla que
// desactivar). Los pedidos, ventas y cajas NO se tocan: ninguna tabla
// los une a la cuenta — solo admin_tokens la referencia.
export async function deleteAdminUser(db, id) {
  const row = await db.prepare("SELECT id FROM admin_users WHERE id = ?").get(id);
  if (!row) return { error: "Cuenta no encontrada" };
  await db.prepare("DELETE FROM admin_tokens WHERE admin_user_id = ?").run(id);
  await db.prepare("DELETE FROM admin_users WHERE id = ?").run(id);
  return { ok: true };
}
