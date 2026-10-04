// ============================================================
// FUSIÓN WOK — Barrido periódico de reconciliación de pagos (PAY-04)
//
// Por qué existe: el webhook de Mercado Pago es un solo punto de falla.
// Si se pierde (caída de red, MP que no reintenta) y el cliente cierra la
// pestaña, un pago APROBADO queda en la base como pending_payment y el
// local nunca lo ve. La única red que había era la reconciliación perezosa
// del polling (loadPublicOrder → shouldReconcile → reconcilePendingOrder
// en index.js), que solo corre si ALGUIEN consulta el pedido — y
// MyOrders.jsx deja de mostrar los pending_payment viejos, así que a las
// horas normalmente nadie lo consulta.
//
// Este módulo ES el orquestador del barrido masivo: recorre los candidatos
// (MP, pendientes, con order de MP, de 10 min a 24 h) y les aplica el
// estado REAL que reporta MP, del más viejo al más nuevo y con tope, para
// no aplastar a la API. El disparo lo hacen el timer interno de 15 min de
// index.js y el cron externo (POST /api/cron/reconcile).
//
// Puro y testeable con el patrón de coupons.js/refunds.js: `db`, `getOrder`
// y `applyState` llegan por parámetro, así el test corre contra un SQLite
// en memoria con un getOrder mockeado, sin importar el singleton de db.js
// (que dispararía las migraciones contra la base real) ni hacer requests.
//
// No implementa lógica de estados propia: `applyState` ES applyMpOrderState
// y el filtro fino `shouldReconcile` ES el del polling (ambos de index.js,
// inyectados por el wiring). Acá solo se decide QUÉ revisar, en qué orden
// y qué contar. Por eso no hay UPDATEs de estado en este archivo.
// ============================================================

import { safeEqual } from "./auth.js";
import { cronSecretProblem } from "./config.js";

// Ventana de candidatos, separada a propósito de la de la expiración
// (expireAbandonedPayments corta a las 24 h):
//   - más fresco que 10 min: el webhook y el polling del cliente todavía
//     tienen la pelota; consultar antes es quemar requests al pedo;
//   - más viejo que 24 h: ya es territorio de la expiración. El barrido
//     corre SIEMPRE antes en el ciclo del timer, así que en la práctica un
//     pedido solo llega a las 24 h si MP dijo "pendiente" (o falló todo).
export const SWEEP_MIN_AGE_MS = 10 * 60 * 1000;
export const SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Tope de pedidos por corrida: barre de a tandas chicas para no castigar a
// la API de MP (ni a Turso) en un día flojo con decenas de pendientes.
export const SWEEP_DEFAULT_LIMIT = 20;

// Un barrido de los pedidos pendientes de MP contra el estado real.
//
// Dependencias (todas por parámetro, ver el wiring en index.js):
//   db              → capa SQL (server/db.js en prod, createDb en tests)
//   getOrder(id)    → trae la order de MP (mp.js en prod, mock en tests)
//   applyState(row, mpOrder) → aplica el estado a la BD y devuelve el
//                     payment_status que quedó (applyMpOrderState en prod)
//   shouldReconcile → filtro fino OPCIONAL por fila (el del polling)
//   isAuthBroken()  → OPORUNO: si devuelve true, aborta sin gastar requests
//   now()           → reloj, para poder congelar las edades en tests
//   limit           → tope de pedidos por corrida
//
// Devuelve contadores SOLO: { revisados, aprobados, rechazados, sinCambios,
// errores, aborted }. Nunca datos de clientes ni ids de MP: viajan al log
// del server y a la respuesta del endpoint de cron.
//
// Idempotente por construcción: reusa applyMpOrderState (que solo promueve
// pending_payment → received y no pisa el avance del admin) y sus UPDATEs
// condicionales; un pedido que ya cambió de estado deja de ser candidato
// del SELECT. Correrlo dos veces no duplica eventos, no pisa al admin ni
// libera el cupón dos veces.
export async function sweepPendingPayments({
  db,
  getOrder,
  applyState,
  shouldReconcile = null,
  isAuthBroken = null,
  now = Date.now,
  limit = SWEEP_DEFAULT_LIMIT,
} = {}) {
  const counts = { revisados: 0, aprobados: 0, rechazados: 0, sinCambios: 0, errores: 0, aborted: false };

  // Credenciales de MP ya marcadas como rotas: ni gastamos una request.
  // El flag se re-chequea antes de cada pedido porque el token puede
  // vencer a mitad del barrido.
  if (isAuthBroken && isAuthBroken()) {
    counts.aborted = true;
    return counts;
  }

  const t = now();
  const desde = new Date(t - SWEEP_MAX_AGE_MS).toISOString();
  const hasta = new Date(t - SWEEP_MIN_AGE_MS).toISOString();

  let rows;
  try {
    // SELECT directo: la ventana y el orden son parte del contrato del
    // barrido (el más viejo primero, tope incluido). El SQL de candidatos
    // espeja el criterio del polling (shouldReconcile) pero con la ventana
    // del barrido; el filtro fino se aplica después, por fila.
    rows = await db
      .prepare(
        `SELECT * FROM orders
         WHERE payment_method = 'mercadopago'
           AND status = 'pending_payment'
           AND payment_status = 'pending'
           AND mp_order_id IS NOT NULL AND mp_order_id != ''
           AND created_at >= ? AND created_at <= ?
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(desde, hasta, limit);
  } catch (err) {
    // El barrido es oportunista: un fallo local (tabla, red hacia Turso) no
    // puede tumbar el timer ni el endpoint. Se cuenta como error para que
    // el ciclo trate este barrido como fallido: no sabemos nada de MP, así
    // que la expiración tampoco cancela pedidos con mp_order_id.
    console.error("sweepPendingPayments:", err.message);
    counts.errores = 1;
    return counts;
  }

  for (const row of rows) {
    counts.revisados++;
    try {
      if (isAuthBroken && isAuthBroken()) {
        // El token se rompió en vivo (el polling lo marca): parar acá es
        // no quemar una request por pedido.
        counts.aborted = true;
        break;
      }
      if (shouldReconcile && !shouldReconcile(row)) {
        counts.sinCambios++;
        continue;
      }
      const mpOrder = await getOrder(row.mp_order_id);
      const status = await applyState(row, mpOrder);
      if (status === "approved") counts.aprobados++;
      else if (status === "rejected" || status === "cancelled") counts.rechazados++;
      else counts.sinCambios++;
    } catch (err) {
      // Un error en UN pedido no corta el barrido: se cuenta y se sigue
      // con el siguiente. Excepción: un rechazo de credenciales, donde
      // seguir sería quemar una request por pedido.
      counts.errores++;
      if (err && err.isAuthError) {
        counts.aborted = true;
        break;
      }
    }
  }
  return counts;
}

// ¿La expiración de este ciclo tiene que saltear los pedidos con mp_order_id?
//
// Es la mitad del fix de PAY-04: el ciclo del timer corre PRIMERO el
// barrido y DESPUÉS la expiración, y solo cancela pedidos con mp_order_id
// cuando el barrido pudo hablar con MP. Si abortó (credenciales rotas) o
// hubo errores de red, un "pendiente" puede ser un pago APROBADO con el
// webhook perdido — cancelarlo es regalarle la comida a alguien que pagó,
// y applyMpOrderState no resucita un cancelled. Esos pedidos quedan para
// el próximo ciclo; los que no tienen mp_order_id (nunca hubo un pago
// posible) se cancelan igual.
export function sweepFailed(result) {
  return !!result && (!!result.aborted || (result.errores || 0) > 0);
}

// Autenticación del endpoint de cron: true solo si el secret está
// ENCENDIDO (configurado con el largo mínimo) y el header coincide en
// tiempo constante (safeEqual de auth.js, igual que el superadmin).
//
// Ausente, incorrecto, corto o sin CRON_SECRET → false, y el endpoint
// responde el MISMO 404 que una ruta inexistente: no se confirma que la
// ruta exista ni se regala un oráculo de qué tan cerca estaba el secret.
export function cronRequestAuthorized({ secret, header } = {}) {
  if (cronSecretProblem(secret)) return false;
  return safeEqual(String(header || ""), String(secret));
}
