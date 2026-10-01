import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

// ============================================================
// FUSIÓN WOK — Autenticación del panel admin
//
// Acá vive todo lo que se puede probar sin arrancar el server:
//   - hashPassword/verifyPassword: contraseñas de las cuentas de la
//     tabla admin_users (admins por sucursal). Se usa scrypt nativo
//     de node:crypto, sin dependencias nuevas, con salt aleatorio
//     por usuario. El superadmin del .env no pasa por acá: se
//     compara en texto plano como siempre (safeEqual).
//   - safeEqual: comparación en tiempo constante (movida de index.js
//     para poder reusarla sin importar el server entero).
//   - authenticateAdmin / resolveAdminFromToken: resuelven QUIÉN es
//     el que llama (rol + sucursal) a partir de las credenciales o
//     del token de sesión. El resto del server no vuelve a tocar
//     admin_tokens/admin_users: le pide a este módulo.
//
// Este módulo recibe `db` por parámetro (patrón de coupons.js) para
// poder probarse contra un SQLite en memoria sin importar el
// singleton de db.js (que dispararía las migraciones contra la base
// real).
// ============================================================

// Regla del dueño: mínimo de contraseña para crear cuentas de sucursal.
export const MIN_PASSWORD_LENGTH = 8;

// Parámetros de scrypt. Con N=16384, r=8, p=1 usa ~16 MB de memoria
// por hash: lo bastante caro para que romper una base filtrada no
// sea trivial, sin volver lento el login del panel.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

// Comparación en tiempo constante para credenciales. Se hashean ambos
// lados a longitud fija (SHA-256) antes de timingSafeEqual: así no se
// filtra ni el contenido ni el largo del secreto por diferencias de
// tiempo. La usa el middleware CSRF y el login del superadmin.
export function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

// Hashea una contraseña: "scrypt$N$r$p$<saltHex>$<hashHex>". El salt viaja
// adentro del string guardado, así que no hace falta otra columna ni otro
// registro de qué parámetros se usaron para cada usuario.
export function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(String(password), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

// Verifica una contraseña contra el hash guardado. Cualquier cosa rara
// (formato corrupto, parámetros absurdos, un hash de otra época)
// responde false SIN lanzar: el login nunca puede caerse por una fila
// vieja de la base.
export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], "hex");
    const expected = Buffer.from(parts[5], "hex");
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    if (N <= 0 || r <= 0 || p <= 0 || salt.length === 0 || expected.length === 0) return false;
    const actual = scryptSync(String(password), salt, expected.length, { N, r, p });
    // Longitudes distintas = contraseñas distintas; timingSafeEqual
    // exigiría buffers iguales, así que se corta acá sin lanzar.
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Normaliza un nombre de usuario para comparar: sin espacios y en
// minúsculas. Sirve para que "Tandil1" y "tandil1" sean la misma
// cuenta (no puede haber duplicados que se diferencien por mayúsculas).
export function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

// ============================================================
// Login y sesión.
//
// authenticateAdmin resuelve UNA credencial contra las dos fuentes
// que existen: el superadmin del .env (como siempre, en texto plano
// y tiempo constante) y las cuentas de sucursal de admin_users
// (hash scrypt). Todos los fallos devuelven exactamente { ok: false }:
// distinguir "no existe" de "contraseña mal" o "desactivado" le
// regalaría a un atacante un oráculo de qué usuarios son reales.
//
// El username se busca con la collation NOCASE de la tabla, así que
// "Tandil1" y "tandil1" son la misma cuenta también al loguear.
// ============================================================
export async function authenticateAdmin(db, { username, password, envUser, envPassword }) {
  // Superadmin del .env primero, idéntico al login de hoy.
  if (envUser && envPassword && safeEqual(username, envUser) && safeEqual(password, envPassword)) {
    return { ok: true, role: "superadmin", branch: "", userId: null };
  }
  const row = await db
    .prepare("SELECT id, password_hash, role, branch, active FROM admin_users WHERE username = ?")
    .get(String(username || "").trim());
  if (!row) return { ok: false };
  if (!verifyPassword(password, row.password_hash)) return { ok: false };
  // Una cuenta desactivada no puede iniciar sesión, aunque la
  // contraseña sea la correcta.
  if (row.active !== 1) return { ok: false };
  return { ok: true, role: row.role, branch: row.branch, userId: row.id };
}

// ============================================================
// Resuelve QUIÉN hace cada request a partir del token de sesión.
//
// Este es el único lugar donde se decide la identidad del admin:
// el resto del server recibe req.admin de acá y nunca vuelve a
// confiar en un parámetro del cliente.
//
// Tres salidas, mutuamente excluyentes:
//   { role, branch, userId, username } → sesión válida (username es
//     null para el superadmin del env: su nombre lo completa index.js
//     con ADMIN_USER).
//   { invalid: true }  → token desconocido o cuenta desactivada
//     (mismo 401 para las dos: no se confirma que el token existió).
//   { expired: true }  → token vencido; se purga de la tabla acá
//     mismo, como hacía requireAdmin.
//
// Los tokens anteriores al deploy tienen admin_user_id NULL: sin esa
// salvedad, el dueño quedaría afuera del panel en el primer deploy
// con este cambio.
// ============================================================
export async function resolveAdminFromToken(db, token, { maxAgeMs }) {
  const value = String(token || "");
  if (!value) return { invalid: true };
  const row = await db
    .prepare("SELECT created_at, admin_user_id FROM admin_tokens WHERE token = ?")
    .get(value);
  if (!row) return { invalid: true };
  const age = Date.now() - new Date(row.created_at).getTime();
  if (age > maxAgeMs) {
    await db.prepare("DELETE FROM admin_tokens WHERE token = ?").run(value);
    return { expired: true };
  }
  if (row.admin_user_id == null) {
    return { role: "superadmin", branch: "", userId: null, username: null };
  }
  const user = await db
    .prepare("SELECT username, role, branch, active FROM admin_users WHERE id = ?")
    .get(row.admin_user_id);
  // La cuenta puede haberse desactivado DESPUÉS de emitir el token:
  // la sesión abierta tiene que cortar en el request siguiente.
  if (!user || user.active !== 1) return { invalid: true };
  return { role: user.role, branch: user.branch, userId: row.admin_user_id, username: user.username };
}
