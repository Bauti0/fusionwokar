// ============================================================
// FUSIÓN WOK — Idempotencia de la creación de pedidos
//
// El problema: si la respuesta de POST /api/orders se pierde (se cae la red,
// el server reinicia en un deploy, un 5xx de un proxy), el cliente NO sabe si
// el pedido se guardó. La pantalla "No pudimos confirmar" le ofrece "Reintentar
// el pedido", y ese reintento creaba un SEGUNDO pedido y consumía un SEGUNDO
// uso del cupón.
//
// La solución: el cliente manda una clave por intento (`clientRequestId`, un
// UUID) y la REUSA en cada reintento del mismo intento. El server guarda esa
// clave en la fila del pedido, junto con una huella (sha256) del contenido. Si
// llega una clave ya registrada con la MISMA huella, el pedido ya existe: se
// devuelve tal cual, sin insertar, sin reservar cupón y sin volver a llamar a
// Mercado Pago.
//
// Tres reglas, y las tres importan:
//
//  1. La clave se REUSA solo mientras el intento es el mismo. Si cambia el
//     carrito, el método de pago, el cupón o cualquier otra cosa del pedido, el
//     cliente manda una clave nueva (ver src/utils/orders.js) y se crea un
//     pedido de verdad.
//  2. La MISMA clave con otro contenido NO devuelve el pedido que ya existe:
//     responde 409. Si devolviera, alguien podría adivinar una clave y
//     recibir los datos (y el número) de un pedido ajeno.
//  3. La fila que se devuelve es la del pedido, no la del request: nunca se
//     devuelve lo que vino en el body del reintento, así que un reintento no
//     puede "cambiar" un pedido ya guardado.
//
// Pura + SQL, sin imports del server: recibe `db` por parámetro (el patrón de
// coupons.js) para que los tests la corran contra un SQLite en memoria. No
// importa server/db.js porque al cargarse dispara las migraciones contra la
// Turso real.
// ============================================================

import { createHash } from "node:crypto";
import { releaseOrphanReservation } from "./coupons.js";

// Largo máximo de la clave. Un UUID son 36 caracteres; el corte evita que
// alguien mande una cadena enorme que después haya que guardar y comparar
// entera (y que se coma la fila con una asignación enorme).
export const CLIENT_REQUEST_ID_MAX = 36;

// Forma de un UUID (8-4-4-4-12 en hex). No se exige la versión 4 para no ser
// frágil con otros clientes: lo que importa es que sea un identificador
// imposible de adivinar, y un UUID v1 (con MAC y timestamp) también lo es.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mensajes de error: literales estáticos, porque van tanto a la respuesta al
// cliente como a la línea de log (server/order-log.js loguea siempre el mismo
// texto que se le respondió).
const INVALID_ID_ERROR = "El identificador del intento de pedido no es válido.";
export const CONFLICT_ERROR =
  "Ese intento de pedido ya se usó con otros datos. Revisá el carrito y confirmá de nuevo.";

// Normaliza y valida la clave que viene en el body.
//
//   { id: "" }            → el cliente no mandó clave (compatibilidad: el
//                           frontend viejo y la carga manual del panel siguen
//                           creando pedidos como siempre)
//   { id: "a1b2…", }      → clave válida, en minúsculas (un UUID en
//                           mayúsculas y otro en minúsculas son el mismo
//                           intento, no dos)
//   { error: "…", }       → formato inválido → el endpoint responde 400
export function parseClientRequestId(value) {
  if (value == null) return { id: "" };
  if (typeof value !== "string") return { error: INVALID_ID_ERROR };
  const id = value.trim().toLowerCase();
  if (!id) return { id: "" }; // "" o solo espacios = sin clave
  if (id.length > CLIENT_REQUEST_ID_MAX || !UUID_RE.test(id)) return { error: INVALID_ID_ERROR };
  return { id };
}

// Huella (sha256) del CONTENIDO del pedido, atada a la clave.
//
// Se calcula sobre el body CRUDO y no sobre los datos ya validados, a
// propósito: el chequeo de la clave tiene que correr ANTES de validar el
// pedido (si el primer intento quemó el último uso del cupón, validar de nuevo
// daría un 400 falso en lugar de devolverle al cliente su pedido).
//
// Los campos son los que hacen que un pedido sea DISTINTO de otro. Quedan
// afuera a propósito:
//
//   - notes / items[].notes: texto libre del cliente. Corregir una coma o
//     escribir "dejálo sin cebolla" no puede convertir un reintento legítimo en
//     un 409.
//   - shipping: lo cotiza y reescribe el server (shipping.js); que una
//     cotización derive no puede invalidar un reintento.
//   - items[].name: es una etiqueta; el precio y el producto ya están.
//   - identification (DNI): dato sensible que ni se persiste; no puede ser parte
//     de algo que se guarda en la base.
//
// El resultado es un hash de una sola vía de 64 hex: no se devuelve al cliente,
// no se loguea y no se puede revertir a los datos del pedido. Lo que sí se
// guarda es una huella de datos personales (nombre/teléfono/dirección), pero
// exactamente los mismos datos que ya están en columnas de la misma fila y que
// el panel muestra: no agrega ninguna exposición nueva.
export function orderFingerprint(body) {
  const b = body && typeof body === "object" ? body : {};
  const items = (Array.isArray(b.items) ? b.items : []).map((it) =>
    JSON.stringify([
      String(it?.productId ?? ""),
      Number(it?.qty) || 0,
      Number(it?.unitPrice) || 0,
      (Array.isArray(it?.extras) ? it.extras : [])
        .map((e) => `${String(e?.id ?? "")}:${Number(e?.price) || 0}`)
        .sort()
        .join("|"),
    ])
  );
  // El carrito se ordena: el mismo pedido con las líneas en otro orden es el
  // mismo pedido, y una diferencia de orden no puede ser motivo de 409.
  items.sort();
  const src = {
    branch: String(b.branch ?? ""),
    orderMode: String(b.orderMode ?? ""),
    paymentMethod: String(b.paymentMethod ?? ""),
    couponCode: String(b.couponCode ?? "").trim().toUpperCase(),
    scheduledFor: String(b.scheduledFor ?? ""),
    address: String(b.address ?? "").trim().toLowerCase(),
    // Solo dígitos: el server normaliza el teléfono igual (validateOrderBody) y
    // "2262 55-5555" y "2262555555" son el mismo cliente.
    phone: String(b.customer?.phone ?? "").replace(/\D/g, ""),
    total: Number(b.total) || 0,
    items,
  };
  return createHash("sha256").update(JSON.stringify(src)).digest("hex");
}

// ¿El error es el choque del índice único de client_requestId?
//
// El endpoint no lo deduce del mensaje: mira el código y el texto, porque el
// driver (@libsql/client) cambia el uno o el otro según la versión. Un UNIQUE de
// cualquier otra columna NO cuenta: en ese caso el error se propaga como antes.
export function isClientRequestConflict(err) {
  const text = `${err?.code || ""} ${err?.message || ""}`;
  return /UNIQUE constraint failed: orders\.client_request_id/i.test(text);
}

// Busca el pedido de una clave de intento. `SELECT *` a propósito: el que
// responde el replay necesita los mismos campos que la fila original (estado,
// total, envío, método de pago) y quien lo responde ya los conoce.
export async function findOrderByClientRequestId(db, id) {
  if (!id) return undefined;
  return await db.prepare("SELECT * FROM orders WHERE client_request_id = ?").get(id);
}

// ¿La fila corresponde al MISMO intento que este request? Solo compara huellas:
// si la fila no tiene huella guardada (no debería pasar: el INSERT siempre la
// escribe cuando hay clave) NO coincide, y el pedido no se devuelve.
export function sameAttempt(row, fingerprint) {
  return Boolean(row && fingerprint && row.client_request_fingerprint === fingerprint);
}

// Corre el batch del INSERT del pedido y decide qué hacer con la clave de
// idempotencia.
//
// El batch (INSERT + número definitivo + evento) se lo arma el endpoint porque
// es quien sabe qué columnas van; lo que vive acá es la decisión de qué hacer
// con la clave. Devuelve:
//
//   { inserted: true, lastInsertRowid }  → se creó el pedido, seguir normal
//   { replay: fila }                      → otro request con la misma clave ya lo
//                                          creó: se devuelve ESA fila
//   { conflict: true }                    → la clave existe pero con otra huella:
//                                          otro pedido, no se devuelve nada de él
//
// El error de cualquier otra causa se propaga (lo atiende el catch del
// endpoint, como antes).
export async function insertOrderWithIdempotency(
  db,
  { stmts, clientRequestId = "", fingerprint = "", couponCode = "", branch = "", couponReserved = false }
) {
  try {
    const results = await db.batch(stmts, "write");
    return { inserted: true, lastInsertRowid: Number(results[0].lastInsertRowid) };
  } catch (err) {
    const collision = Boolean(clientRequestId) && isClientRequestConflict(err);
    // El batch es atómico: si falló, el pedido NO se creó, así que la reserva de
    // cupón que este request llegó a hacer hay que devolverla en TODOS los
    // caminos (o la respuesta es el pedido del otro request, o es un error).
    // Sin esto el uso se quema sin venta: es el mismo motivo del catch que
    // rodeaba al INSERT antes de este cambio.
    if (couponReserved) await releaseOrphanReservation(db, couponCode, branch);
    if (!collision) throw err;
    const row = await findOrderByClientRequestId(db, clientRequestId);
    // Si la fila no aparece no se de quién es la clave: el error original dice
    // más que un replay inventado.
    if (!row) throw err;
    if (!sameAttempt(row, fingerprint)) return { conflict: true };
    return { replay: row };
  }
}

// Cuerpo de la respuesta cuando el pedido ya existía.
//
// MISMA forma que el éxito de la creación (el frontend no distingue un camino
// del otro) y sin NADA de datos personales: ni nombre, ni teléfono, ni email,
// ni dirección, ni notas del cliente. Todo lo que sale sale de la fila del
// pedido, no del body del reintento. Por eso no hay ningún item para redactar:
// acá no se serializa `customer` ni `address` en ningún caso.
//
// `status` sale de la fila (la verdad) y no del literal del camino feliz: entre
// el intento y el reintento el pedido puede haber avanzado (pagado) o haber sido
// cancelado desde el panel, y el cliente tiene que ver dónde está.
export function replayPayload(row, { demo = false, demoToken = "", checkoutUrl = null } = {}) {
  return {
    ok: true,
    orderId: Number(row.id),
    orderNumber: row.order_number,
    demo,
    demoToken,
    checkoutUrl,
    status: row.status,
    total: row.total,
    discount: row.discount || 0,
    couponCode: row.coupon_code || "",
    scheduledFor: row.scheduled_for || "",
    shipping: { cost: row.shipping || 0, blocks: row.shipping_km || 0, pending: !!row.shipping_pending },
  };
}
