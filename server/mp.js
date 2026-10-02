// ============================================================
// FUSIÓN WOK — Cliente de la API de Mercado Pago (Argentina)
// Checkout Pro vía **Orders API** (POST /v1/orders). La "order"
// agrupa todo el ciclo del pago y habilita captura, reembolso y
// cancelación nativos (antes se usaba la API de Preferencias,
// que MP marca como legacy: sin features nuevas).
//
// Todas las llamadas se hacen desde el servidor con el Access
// Token privado; el frontend solo recibe el checkout_url y el
// estado público del pedido.
//
// Modo demo: si no hay MP_ACCESS_TOKEN o DEMO_MODE=true, no se
// llama a la API real y se simulan las respuestas para poder
// probar el flujo completo sin credenciales.
// ============================================================

import { createHmac } from "node:crypto";

const MP_API = "https://api.mercadopago.com";
// Cortamos la llamada si MP no responde: sin esto el pedido queda retenido
// indefinidamente y el cliente se queda esperando (y agota el rate limit).
const MP_TIMEOUT_MS = 15000;

export function getMpToken() {
  return process.env.MP_ACCESS_TOKEN || "";
}

export function isDemoMode() {
  return process.env.DEMO_MODE === "true" || !process.env.MP_ACCESS_TOKEN;
}

// Error de Mercado Pago con lo que el servidor necesita para decidir qué
// mostrarle al cliente y si tiene sentido reintentar:
//
//  - 401/403 → el ACCESS TOKEN está revocado/caducado o sin la policy necesaria
//    (típico: "At least one policy returned UNAUTHORIZED"). Es un problema de
//    configuración: reintentar no lo arregla, hay que regenerar el token.
//  - 400/404/422 → la operación está mal (no se reintenta).
//  - 429/5xx/red/timeout → transitorio: vale la pena reintentar.
//
// Un Error pelado no distinguía estos casos y el caller terminaba respondiendo
// 502 "Bad Gateway" a todo, que además sugiere "reintentá" cuando no sirve.
export class MpError extends Error {
  constructor(message, { status = 0, mpCode = "", retryable = false } = {}) {
    super(message);
    this.name = "MpError";
    this.status = status;
    this.mpCode = mpCode;
    this.retryable = retryable;
  }

  // El token fue rechazado: la app no puede cobrar hasta que se arregle el env.
  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }
}

function mpHeaders(idempotencyKey) {
  const headers = {
    Authorization: `Bearer ${getMpToken()}`,
    "Content-Type": "application/json",
  };
  // Obligatorio en /v1/orders: sin él MP rechaza con 400. Se manda uno
  // estable por pedido (el número de pedido) para que reintentar la misma
  // operación nunca cree dos orders ni dos cobros.
  if (idempotencyKey) headers["X-Idempotency-Key"] = String(idempotencyKey);
  return headers;
}

// MP devuelve el detalle del error en `message` + `cause[]`, o en `errors[]`
// (Orders). Seprioriza la causa concreta para que el error que ve el admin
// sea accionable ("refund_amount_exceeds") y no un genérico 400.
function mpErrorMessage(data, status) {
  const causes = [
    ...(Array.isArray(data?.cause) ? data.cause : []),
    ...(Array.isArray(data?.errors) ? data.errors : []),
  ];
  const detail = causes
    .map((c) => c.description || c.message || c.code)
    .filter(Boolean)
    .join(" · ");
  return detail || data?.message || `Error de Mercado Pago (${status})`;
}

async function mpFetch(path, { method = "GET", body, idempotencyKey } = {}) {
  let res;
  try {
    res = await fetch(`${MP_API}${path}`, {
      method,
      headers: mpHeaders(idempotencyKey),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(MP_TIMEOUT_MS),
    });
  } catch (err) {
    // Red caída o timeout: no sabemos si MP recibió la operación. Se marca
    // retryable y se delega la deduplicación a la clave de idempotencia.
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw new MpError(
      timeout
        ? `Mercado Pago no respondió a los ${MP_TIMEOUT_MS / 1000}s`
        : "No pudimos conectar con Mercado Pago",
      { retryable: true }
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new MpError(mpErrorMessage(data, res.status), {
      status: res.status,
      mpCode: data?.code || data?.error || "",
      retryable,
    });
  }
  return data;
}

// Verifica que el access token sea aceptado por MP. Se usa al arrancar (para
// avisar de un token revocado antes de que llegue un cliente) y por el health
// del panel. Lanza MpError con isAuthError=true si MP rechaza el token.
export async function checkMpCredentials() {
  if (isDemoMode()) return { ok: true, demo: true };
  const data = await mpFetch("/users/me");
  return { ok: true, id: data?.id ?? null, nickname: data?.nickname || "" };
}

// El error que se tira cuando YA sabemos que el token no sirve (el probe del
// arranque lo marcó). Es el mismo que devolvería MP, pero sin gastar una
// request ni esperar el timeout de 15s, que es lo que hace el admin esperar
// con el cursor girando antes de ver el error.
//
// Vive acá y no duplicado en cada call site: si el checkout y la devolución
// lo escribieran a mano, uno terminaría diciendo "no reintentes" y el otro
// "reintentá", y el panel mostraría dos mensajes para la misma causa.
export function mpAuthError() {
  return new MpError("Credenciales de Mercado Pago inválidas: regenerá el MP_ACCESS_TOKEN", {
    status: 401,
    mpCode: "credentials_invalid",
    retryable: false,
  });
}

// Crea la order de Checkout Pro para un pedido. Devuelve el checkout_url:
// el comprador es redirigido ahí, paga en el entorno de MP y vuelve a
// backUrls. El total va como string ("15000"), que es lo que espera Orders.
//
// El armado del body vive en buildOrderBody (función pura, testeada en
// test/mp-order.test.js) para fijar el contrato con la API sin red ni
// credenciales; createOrder solo agrega el envío a MP.
export async function createOrder({ orderNumber, total, title, description, backUrls, payer, additionalInfo, items }) {
  const body = buildOrderBody({ orderNumber, total, title, description, backUrls, payer, additionalInfo, items });

  // El número de pedido es único y estable → sirve de clave de idempotencia.
  const data = await mpFetch("/v1/orders", { method: "POST", body, idempotencyKey: orderNumber });
  if (!data.id || !data.checkout_url) {
    // MP respondió bien pero sin link: no hay a dónde mandar al cliente. Es
    //Retryable (se puede reintentar) y NO es un problema de credenciales.
    throw new MpError("Mercado Pago no devolvió el link de pago", { retryable: true });
  }
  return {
    id: data.id,
    checkoutUrl: data.checkout_url || null,
    status: data.status,
    statusDetail: data.status_detail,
  };
}

// Limpia el texto que aparece en el resumen de la tarjeta del comprador
// (config.statement_descriptor). La doc oficial fija el límite: "This
// parameter accepts a text of up to 13 characters" (Configure invoice
// description, checkout-pro-orders). Solo ASCII alfanumérico y espacio:
// cualquier otra cosa (tildes, guiones, símbolos) se elimina, no se
// reemplaza, para no inventar un texto que el dueño no escribió.
export function sanitizeStatementDescriptor(value) {
  const FALLBACK = "FUSION WOK";
  const clean = String(value || "")
    .replace(/[^A-Za-z0-9 ]/g, "") // fuera ASCII alfanumérico y espacio
    .replace(/\s+/g, " ") // espacios múltiples → uno
    .trim();
  if (!clean) return FALLBACK;
  return clean.slice(0, 13); // límite documentado del resumen de tarjeta
}

// Arma el body de POST /v1/orders (Checkout Pro). Pura: nada de fetch ni
// process.env más allá de la lectura puntual de MP_STATEMENT_DESCRIPTOR.
// Los campos de comportamiento del pago (type/processing_mode/capture_mode)
// son EXACTAMENTE los de antes: este cambio solo agrega datos, no toca
// cómo se procesa el pago.
export function buildOrderBody({ orderNumber, total, title, description, backUrls, payer, additionalInfo, items }) {
  const amount = String(Math.round(Number(total) || 0));
  const body = {
    type: "online",
    // Checkout Pro siempre es "manual": el cobro se dispara en el checkout
    // de MP, no al crear la order. capture_mode "automatic" = se acredita
    // apenas se aprueba (lo que ya pasaba con la preferencia anterior).
    processing_mode: "manual",
    capture_mode: "automatic",
    total_amount: amount,
    external_reference: orderNumber,
    description: description || `Pedido Fusión Wok ${orderNumber}`,
    items: mpItemsFor({ orderNumber, total, title, items }),
    config: {
      // Nombre del comercio en el resumen de la tarjeta del comprador.
      // Hermano de "online" (así lo muestra el ejemplo oficial de Create
      // order). Siempre se manda: con la variable sin configurar cae al
      // fallback "FUSION WOK".
      statement_descriptor: sanitizeStatementDescriptor(process.env.MP_STATEMENT_DESCRIPTOR),
      online: {
        success_url: backUrls.success,
        failure_url: backUrls.failure,
        pending_url: backUrls.pending,
        // "all" y no "approved": al cliente lo traemos de vuelta siempre,
        // también cuando el pago fue rechazado, para que vea el resultado.
        auto_return: "all",
      },
    },
  };
  // payer es opcional para MP, pero si viene el objeto, exige email adentro
  // ("If the object is included, payer.email is required within it"). Se
  // arma solo con las claves que tienen valor: nada de campos vacíos.
  // identification es dato sensible: pasa directo al body y no se guarda
  // en la base ni se loguea (ver createOrder).
  if (payer && payer.email) {
    const p = { email: payer.email };
    if (payer.firstName) p.first_name = payer.firstName;
    if (payer.lastName) p.last_name = payer.lastName;
    if (payer.identification && payer.identification.type && payer.identification.number) {
      p.identification = {
        type: payer.identification.type,
        number: payer.identification.number,
      };
    }
    body.payer = p;
  }
  // Datos adicionales de antifraude. La doc de Orders usa claves PLANAS:
  // "additional_info": { "payer.registration_date": "2020-01-15T..." }.
  // registration_date es la fecha del primer pedido del comprador.
  if (additionalInfo && additionalInfo.registrationDate) {
    body.additional_info = { "payer.registration_date": additionalInfo.registrationDate };
  }
  return body;
}

// Categoría de los ítems para MP. "food" es la categoría de comidas de la
// lista de MP y se probó contra la API de prueba con 201 (2026-10-02).
const ITEM_CATEGORY_ID = "food";

// Límite real de items[].description: la doc de Orders no lo publica, pero la
// API lo valida con "length must be <= 256" (probado con 2000 chars contra
// la API de prueba → 400 property_value, 2026-10-02). Se trunca acá y en el
// cleanItem que arma el server, por las dos puntas.
const ITEM_DESCRIPTION_MAX = 256;

// Mapea los ítems REALES del carrito (los cleanItems que guarda el pedido:
// name, unitPrice, extras[], notes, qty) al array items de la order.
//
// REGLA CRÍTICA de la API (documentada y probada: 400
// order_items_total_amount_mismatch): total_amount tiene que ser IGUAL a la
// suma de unit_price × quantity de TODOS los ítems. Por eso:
//   - el envío viaja como ítem propio ("Envío", quantity 1);
//   - el descuento de cupón se RESTA de los unit_price de los productos,
//     porque MP rechaza precios negativos (probado: 400 invalid_items).
//
// El descuento se reparte de la línea de MAYOR subtotal hacia abajo: cada
// línea absorbe lo que pueda manteniendo (subtotal − share) divisible por
// qty, para que el unit_price quede entero y > 0 (MP tampoco acepta 0).
// Si el reparto exacto es imposible, devuelve null y el caller manda el
// ítem único de siempre: nunca sale una order inconsistente.
//
// Casos que devuelven null (documentados):
//   1. total ≤ 0 o carrito vacío (MP no cobra cero ni items sin datos);
//   2. precio/cantidad ilegibles en algún ítem;
//   3. descuento mayor que el subtotal de los productos;
//   4. descuento que no se puede repartir en unit_prices enteros
//      (ej: cupón de $333 sobre una única línea de 2× $5000);
//   5. el reparto dejaría algún unit_price en 0;
//   6. aserción final: la suma no da EXACTO el total.
export function buildOrderItems({ items, total, discount = 0, shippingCost = 0 }) {
  const cart = Array.isArray(items) ? items : [];
  const t = Math.round(Number(total) || 0);
  const disc = Math.max(0, Math.round(Number(discount) || 0));
  const ship = Math.max(0, Math.round(Number(shippingCost) || 0));
  if (t <= 0 || cart.length === 0) return null; // caso 1

  const lines = [];
  for (const it of cart) {
    const unitPrice = Math.round(Number(it.unitPrice) || 0);
    const qty = Math.round(Number(it.qty) || 0);
    const extras = Array.isArray(it.extras) ? it.extras : [];
    const extrasTotal = extras.reduce((s, e) => s + Math.round(Number(e.price) || 0), 0);
    if (unitPrice <= 0 || qty <= 0) return null; // caso 2
    lines.push({ item: it, unit: unitPrice + extrasTotal, qty, share: 0 });
  }
  const baseSubtotal = lines.reduce((s, l) => s + l.unit * l.qty, 0);
  if (disc > baseSubtotal) return null; // caso 3

  // Reparto: cada línea absorbe lo que pueda manteniendo su unit_price
  // entero y > 0 (share ≡ subtotal, módulo qty). Un solo orden de recorrido
  // pierde repartos alcanzables: de mayor a menor deja residuos que la
  // línea chica no puede absorber (y al revés pasa igual), así que se
  // prueban AMBOS órdenes y se queda con el primero que reparta TODO.
  // Si ninguno puede, no se puede cuadrar la suma → null.
  const reparto = (ordenLineas) => {
    for (const l of lines) l.share = 0; // cada pasada arranca de cero
    let remaining = disc;
    for (const line of ordenLineas) {
      if (remaining <= 0) break;
      const subtotal = line.unit * line.qty;
      let share = Math.min(remaining, subtotal - line.qty); // deja ≥ 1 por unidad
      // share ≡ subtotal (módulo qty), bajando de a uno si hace falta.
      while (share > 0 && (subtotal - share) % line.qty !== 0) share--;
      if (subtotal - share === 0) share = 0; // nunca unit_price 0
      line.share = share;
      remaining -= share;
    }
    return remaining === 0;
  };
  const porSubtotalDesc = [...lines].sort((a, b) => b.unit * b.qty - a.unit * a.qty);
  const porSubtotalAsc = [...porSubtotalDesc].reverse();
  if (!reparto(porSubtotalDesc) && !reparto(porSubtotalAsc)) return null;

  const mpItems = lines.map((line) => {
    const extras = Array.isArray(line.item.extras) ? line.item.extras : [];
    const extrasLabels = extras.map((e) => String(e.label || "")).filter(Boolean).join(", ");
    const title = extrasLabels
      ? `${line.item.name} (${extrasLabels})`.slice(0, 120)
      : String(line.item.name || "Producto").slice(0, 120);
    // description: la del PRODUCTO si existe; si no, el título (que ya
    // lleva los extras entre paréntesis). Límite real de la API: 256 chars
    // — la API de prueba lo rechaza con property_value "'$.items[N].
    // description' - length must be <= 256" (probado 2026-10-02).
    // Pedidos guardados antes de este cambio no traen description en su
    // JSON: caen al título sin romper nada.
    const description =
      String(line.item.description || "").trim().slice(0, ITEM_DESCRIPTION_MAX) || title;
    return {
      title,
      description,
      unit_price: String((line.unit * line.qty - line.share) / line.qty), // entero por (c)
      quantity: line.qty,
      category_id: ITEM_CATEGORY_ID,
    };
  });
  if (ship > 0) {
    mpItems.push({
      title: "Envío",
      description: "Costo de envío a domicilio",
      unit_price: String(ship),
      quantity: 1,
      category_id: ITEM_CATEGORY_ID,
    });
  }

  // Aserción final (caso 6): sin suma exacta, no hay items que mandar.
  const suma = mpItems.reduce((s, it) => s + Number(it.unit_price) * it.quantity, 0);
  if (suma !== t) return null;
  return mpItems;
}

// Decide el array items del body: los reales si cuadran EXACTO con el total,
// o el ítem único de siempre si no (nunca una order inconsistente). Es la
// segunda aserción (la primera es la de buildOrderItems): protege contra
// cualquier caller que mande items sin pasar por buildOrderItems.
function mpItemsFor({ orderNumber, total, title, items }) {
  const amount = String(Math.round(Number(total) || 0));
  const fallbackTitle = title || `Pedido Fusión Wok ${orderNumber}`;
  const fallback = [
    {
      title: fallbackTitle,
      // El ítem único también lleva description: sin descripción de
      // producto que aplicar, es el propio título (regla del resto de
      // los ítems). No toca precio ni cantidad: la suma no cambia.
      description: fallbackTitle,
      unit_price: amount,
      quantity: 1,
    },
  ];
  if (!Array.isArray(items) || items.length === 0) return fallback;
  const suma = items.reduce(
    (s, it) => s + Math.round(Number(it.unit_price) || 0) * Math.round(Number(it.quantity) || 0),
    0
  );
  if (suma !== Math.round(Number(total) || 0)) {
    // La suma de los items que mandó el caller no cuadra: caer al ítem
    // único cobra lo mismo y evita el 400 order_items_total_amount_mismatch.
    console.warn(
      `[MP] pedido ${orderNumber}: la suma de los items (${suma}) no cuadra con el total (${amount}); se envia el item unico`
    );
    return fallback;
  }
  return items;
}

// Fecha en el formato del ejemplo oficial de Create order:// "payer.registration_date": "2020-01-15T00:00:00.000-03:00" (ISO 8601 con
// milisegundos y offset). Argentina es UTC-3 fijo (sin horario de verano
// desde 2009), así que el offset se puede escribir directo. Recibe un Date
// o un ISO (como el created_at que sale de la base) y devuelve "" si la
// fecha no se puede leer — el caller omite el campo en ese caso.
export function toRegistrationDate(date) {
  if (date == null) return ""; // new Date(null) sería epoch, no un error
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return "";
  const shifted = new Date(d.getTime() - 3 * 3600 * 1000); // UTC → -03:00
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
    `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}` +
    `.${p(shifted.getUTCMilliseconds(), 3)}-03:00`
  );
}

// Consulta el estado real de la order (webhook + panel para refrescar el
// estado antes de devolver dinero).
export async function getOrder(orderId) {
  const data = await mpFetch(`/v1/orders/${encodeURIComponent(orderId)}`);
  const payments = (data.transactions?.payments || []).map((p) => ({
    id: p.id,
    status: p.status,
    statusDetail: p.status_detail,
    amount: Number(p.amount || 0),
    paidAmount: Number(p.paid_amount || 0),
  }));
  const refunds = (data.transactions?.refunds || []).map((r) => ({
    id: r.id,
    amount: Number(r.amount || 0),
    status: r.status,
  }));
  return {
    id: data.id,
    status: data.status, // created | processed | processing | action_required | canceled
    statusDetail: data.status_detail, // accredited | partially_refunded | refunded | in_process…
    externalReference: data.external_reference,
    payments,
    refunds,
    refundedAmount: refunds.reduce((sum, r) => sum + r.amount, 0),
  };
}

// Devuelve dinero. Sin `amount` devuelve TODO lo que quede de la order; con
// `amount` devuelve una parte, y entonces MP exige el id de la transacción.
//
// `idempotencyKey` es la clave que MP usa para NO repetir la operación. La
// arma el caller con lo que hace único a ESTA devolución (pedido + cuánto
// faltaba devolver + monto): así un doble clic se deduplica, pero dos
// devoluciones del mismo monto en momentos distintos sí se ejecutan.
export async function refundOrder(orderId, { transactionId, amount, idempotencyKey } = {}) {
  const body =
    amount == null ? {} : { transactions: [{ id: transactionId, amount: String(Math.round(amount)) }] };
  const data = await mpFetch(`/v1/orders/${encodeURIComponent(orderId)}/refund`, {
    method: "POST",
    body,
    idempotencyKey: idempotencyKey || `ref-${orderId}-${amount == null ? "full" : amount}`,
  });
  return {
    id: data.id,
    status: data.status,
    statusDetail: data.status_detail,
    refunds: (data.transactions?.refunds || []).map((r) => ({
      id: r.id,
      transactionId: r.transaction_id,
      amount: Number(r.amount || 0),
      status: r.status,
    })),
  };
}

// Compatibilidad transitoria: los pedidos creados con la integración de
// Preferencias (previo a la migración a Orders) siguen notificando con
// type="payment" y data.id = id de pago. Se atienden para que un cliente que
// paga un pedido pendiente antes del deploy igual quede confirmado.
export async function getPayment(paymentId) {
  const data = await mpFetch(`/v1/payments/${encodeURIComponent(paymentId)}`);
  return {
    id: data.id,
    status: data.status, // approved | pending | rejected | in_process | cancelled
    status_detail: data.status_detail,
    external_reference: data.external_reference,
  };
}

// Verifica la firma del webhook (requiere MP_WEBHOOK_SECRET configurado).
// Sin secret la firma NO se puede verificar → se rechaza. (Antes devolvía true
// "por comodidad en demo", lo que dejaba el webhook abierto a que cualquiera
// marcara pagos como aprobados. En demo no llegan webhooks reales, así que
// rechazar es seguro: el flujo demo se simula por el endpoint /demo con token.)
export function verifyWebhookSignature(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return false; // firma no verificable → inválida
  const signature = req.headers["x-signature"] || "";
  const requestId = req.headers["x-request-id"] || "";
  const tsMatch = signature.match(/ts=(\d+)/);
  const v1Match = signature.match(/v1=([a-f0-9]+)/i);
  if (!tsMatch || !v1Match) return false;
  // El id del recurso viaja en el QUERY (?data.id=ORD...) y, en Orders, en
  // mayúsculas: el manifest exige minúsculas. Se lee del originalUrl para no
  // depender de cómo Express parseó el query. Si no viniera, se cae al body
  // (notificaciones viejas de Preferences). Los campos ausentes se omiten
  // del manifest, según la doc de MP.
  const dataId = dataIdForManifest(req);
  const manifest = [
    dataId ? `id:${dataId};` : "",
    requestId ? `request-id:${requestId};` : "",
    `ts:${tsMatch[1]};`,
  ].join("");
  const hmac = createHmac("sha256", secret).update(manifest).digest("hex");
  return hmac === v1Match[1].toLowerCase();
}

// Id del recurso notificado, ya en minúsculas (para el manifest de la firma).
export function dataIdForManifest(req) {
  const fromQuery = new URL(req.originalUrl || req.url || "", "http://mp.local").searchParams.get("data.id");
  const raw = fromQuery != null ? fromQuery : req.body?.data?.id;
  return raw == null || raw === "" ? null : String(raw).toLowerCase();
}
