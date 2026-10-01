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
export async function createOrder({ orderNumber, total, title, description, backUrls }) {
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
    items: [
      {
        title: title || `Pedido Fusión Wok ${orderNumber}`,
        unit_price: amount,
        quantity: 1,
      },
    ],
    config: {
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
  // TEMP-DIAG: remover tras diagnóstico
  diagWebhook(req);
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

// ============================================================
// TEMP-DIAG: remover tras diagnóstico
// Diagnóstico del rechazo de firma del webhook. SOLO lee el request y escribe
// una línea JSON por request. NO cambia la verificación: no toca el manifest
// que usa la función real, no altera el retorno y va envuelto en un try/catch
// que no puede propagar errores.
//
// Reglas de este bloque: jamás imprimir el secret, el v1 recibido ni ningún
// HMAC calculado (ni entero, ni prefijo/sufijo). Solo booleanos, largos,
// nombres de campo y los tres valores que la doc de MP ya expone en claro
// (ts, x-request-id y data.id). Si algo no se puede calcular se emite null,
// para no confundir "no calculé" con "no coincide".
// ============================================================

const DIAG_PREFIJO = "[MP-WEBHOOK-DIAG]";

// Separa `ts=...,v1=...` en pares [nombre, valor]. Tolera coma y punto y coma,
// y no propaga si el header no es string.
function diagParseSignature(raw) {
  if (raw == null) return { presentes: false, componentes: [], largoPorValor: {}, ts: null, v1EsHex: null, ocurrenciasTs: 0 };
  const texto = Array.isArray(raw) ? raw.join(",") : String(raw);
  const componentes = [];
  const largoPorValor = {};
  let ts = null;
  for (const trozo of texto.split(/[,;]/)) {
    const eq = trozo.indexOf("=");
    if (eq <= 0) continue;
    const nombre = trozo.slice(0, eq).trim();
    const valor = trozo.slice(eq + 1).trim();
    componentes.push(nombre);
    largoPorValor[nombre] = valor.length;
    // Se guarda el PRIMER ts: es el que toma el regex de la verificación real.
    if (nombre === "ts" && ts == null) ts = valor;
  }
  const v1 = texto.match(/v1=([a-f0-9]+)/i);
  return {
    presentes: true,
    componentes,
    largoPorValor,
    ts,
    v1EsHex: v1 ? /^[a-f0-9]+$/i.test(v1[1]) : null,
    // Duplicado real = más de un "ts=" en el header. No se cuenta la coma,
    // porque la coma es el separador legítimo entre ts y v1 de MP.
    ocurrenciasTs: (texto.match(/ts=/g) || []).length,
  };
}

// Calcula el HMAC de una variante del manifest y compara contra el v1 recibido.
// Devuelve un booleano; NO devuelve ni registra el hash.
function diagMatch(manifest, secret, v1Recibido) {
  if (!secret || !v1Recibido || !manifest) return null;
  const hmac = createHmac("sha256", secret).update(manifest).digest("hex");
  return hmac === String(v1Recibido).toLowerCase();
}

// TEMP-DIAG: remover tras diagnóstico
// Reproduce la construcción del manifest TAL CUAL la hace
// verifyWebhookSignature (mismos regex, mismo dataIdForManifest, mismas
// condicionales), sin tocar esa función. Si no se puede reproducir devuelve
// null: o el header x-signature no es string (la verificación real reventaría
// en .match) o no hay ts= (la verificación real corta ahí).
function diagManifiestoReal(req, rawSignature, rawRequestId) {
  try {
    if (typeof rawSignature !== "string") return null;
    const tsMatch = rawSignature.match(/ts=(\d+)/);
    if (!tsMatch) return null;
    const requestId = rawRequestId || "";
    const dataId = dataIdForManifest(req);
    return {
      ts: tsMatch[1],
      requestId,
      dataId,
      manifest: [
        dataId ? `id:${dataId};` : "",
        requestId ? `request-id:${requestId};` : "",
        `ts:${tsMatch[1]};`,
      ].join(""),
    };
  } catch {
    return null;
  }
}

// TEMP-DIAG: remover tras diagnóstico
// Devuelve { a..i: true|false|null }. null = la variante no se pudo calcular
// porque el request no trae el dato que necesita.
function diagVariantes({ secret, v1, real, queryId, bodyDataId, bodyTopId }) {
  const nulas = { a: null, b: null, c: null, d: null, e: null, f: null, g: null, h: null, i: null };
  if (!real) return nulas; // sin ts= o header no string: no hay manifest que probar
  const { ts, requestId, dataId } = real;
  const lc = (v) => (v == null || v === "" ? null : String(v).toLowerCase());
  const partes = (id) => {
    const pedazos = [];
    if (id) pedazos.push(`id:${id};`);
    if (requestId) pedazos.push(`request-id:${requestId};`);
    pedazos.push(`ts:${ts};`);
    return pedazos.join("");
  };
  const out = {};
  // A: el manifest LITERAL que arma la verificación real, sin reconstruirlo.
  // Por construcción, a:true implica que la verificación devuelve true.
  out.a = diagMatch(real.manifest, secret, v1);
  // B: id del body.data, en minúsculas.
  out.b = diagMatch(partes(lc(bodyDataId)), secret, v1);
  // C: id del query tal cual, sin minúsculas.
  out.c = diagMatch(partes(queryId || null), secret, v1);
  // D: id del body.data tal cual.
  out.d = diagMatch(partes(bodyDataId || null), secret, v1);
  // E: id del body.id de primer nivel, en minúsculas.
  out.e = diagMatch(partes(lc(bodyTopId)), secret, v1);
  // F: id del body.id de primer nivel, tal cual.
  out.f = diagMatch(partes(bodyTopId || null), secret, v1);
  // G: sin el campo id (solo request-id y ts).
  out.g = diagMatch(partes(null), secret, v1);
  // H: sin request-id (id de la variante actual + ts).
  out.h = diagMatch(`${dataId ? `id:${dataId};` : ""}ts:${ts};`, secret, v1);
  // I: solo ts.
  out.i = diagMatch(`ts:${ts};`, secret, v1);
  return out;
}

// TEMP-DIAG: remover tras diagnóstico
export function diagWebhook(req) {
  try {
    const headers = req?.headers || {};
    const rawSignature = headers["x-signature"];
    const rawRequestId = headers["x-request-id"];
    const firma = diagParseSignature(rawSignature);

    // Query: solo se leen data.id, type y topic. Ningún otro valor.
    let url = { path: "", queryNames: [], dataId: null, type: null, topic: null };
    try {
      const parsed = new URL(req?.originalUrl || req?.url || "", "http://mp.local");
      url = {
        path: parsed.pathname,
        queryNames: [...parsed.searchParams.keys()],
        dataId: parsed.searchParams.get("data.id"),
        type: parsed.searchParams.get("type"),
        topic: parsed.searchParams.get("topic"),
      };
    } catch {
      /* URL ilegible: se deja el objeto vacío */
    }

    const body = req?.body && typeof req.body === "object" ? req.body : {};
    const bodyData = body.data && typeof body.data === "object" ? body.data : null;
    const queryId = url.dataId;
    const bodyDataId = bodyData?.id ?? null;
    const bodyTopId = body?.id ?? null;
    // Mismo manifest que arma la verificación real, para que la variante A
    // sea esa misma cadena y no una reconstrucción parecida.
    const real = diagManifiestoReal(req, rawSignature, rawRequestId);
    const manifestId = real?.dataId ?? null;

    // De qué fuente salió el id que el server usa hoy.
    const fuente =
      manifestId == null
        ? "vacio"
        : queryId && String(queryId).toLowerCase() === manifestId
          ? "query"
          : bodyDataId && String(bodyDataId).toLowerCase() === manifestId
            ? "body.data.id"
            : "otro";

    const requestId = Array.isArray(rawRequestId) ? rawRequestId[0] : rawRequestId;
    const v1 = (String(Array.isArray(rawSignature) ? rawSignature.join(",") : rawSignature || "").match(
      /v1=([a-f0-9]+)/i
    ) || [])[1];

    const payload = {
      signature: {
        presente: firma.presentes,
        comoArray: Array.isArray(rawSignature),
        duplicado: (firma.ocurrenciasTs ?? 0) > 1,
        largo: rawSignature == null ? 0 : String(rawSignature).length,
        componentes: firma.componentes,
        largoPorValor: firma.largoPorValor,
        v1EsHex: firma.v1EsHex,
        ts: firma.ts,
      },
      requestId: {
        presente: requestId != null && requestId !== "",
        comoArray: Array.isArray(rawRequestId),
        valor: requestId ?? null,
        largo: requestId == null ? 0 : String(requestId).length,
      },
      headersX: Object.keys(headers)
        .filter((h) => h.toLowerCase().startsWith("x-"))
        .sort(),
      contentType: headers["content-type"] ?? null,
      url,
      body: {
        keys: Object.keys(body).sort(),
        tieneData: bodyData != null,
        tieneDataId: bodyDataId != null,
        dataId: bodyDataId ?? null,
        dataIdLargo: bodyDataId == null ? 0 : String(bodyDataId).length,
        id: bodyTopId ?? null,
        idLargo: bodyTopId == null ? 0 : String(bodyTopId).length,
        type: body.type ?? null,
        action: body.action ?? null,
      },
      manifest: {
        id: manifestId ?? null,
        fuente,
        // Con qué ts y con qué request-id armó el manifest la verificación real.
        tsUsadoPorLaVerificacion: real?.ts ?? null,
        requestIdUsadoPorLaVerificacion:
          real?.requestId == null ? null : String(real.requestId),
        queryCoincideBody:
          queryId != null && bodyDataId != null ? String(queryId) === String(bodyDataId) : null,
      },
      variantes: diagVariantes({
        secret: process.env.MP_WEBHOOK_SECRET,
        v1,
        real,
        queryId,
        bodyDataId,
        bodyTopId,
      }),
    };

    console.log(`${DIAG_PREFIJO} ${JSON.stringify(payload)}`);
  } catch {
    // El diagnóstico nunca puede romper el webhook.
  }
}
