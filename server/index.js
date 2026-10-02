import "dotenv/config";
import express from "express";
import cors from "cors";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHmac } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import {
  db,
  toPublicOrder,
  toPublicOrderPublic,
  formatOrderNumber,
  saveProductImage,
  getProductImage,
  deleteProductImage,
  toProduct,
  toCategory,
  seedProducts,
  seedCategories,
} from "./db.js";
import {
  createOrder,
  getOrder,
  refundOrder,
  getPayment,
  isDemoMode,
  checkMpCredentials,
  mpAuthError,
  MpError,
  verifyWebhookSignature,
  toRegistrationDate,
  buildOrderItems,
} from "./mp.js";
import { MENUS } from "../src/data/menus.js";
import { enhanceHtml } from "./seo.js";
import { isOpenAtTime, toWallclock } from "../src/utils/schedule.js";
import { computeShipping } from "./shipping.js";
import {
  applyCoupon,
  reserveCoupon,
  releaseOrderCoupon,
  releaseOrphanReservation,
  releaseStaleCouponReservations,
} from "./coupons.js";
import { applyRefunds, refundableAmount } from "./refunds.js";
import {
  listOrders,
  getOrderScoped,
  effectiveBranch,
  getStats,
  getSalesReport,
  listCustomers,
  getCashRegisterState,
  openCashRegister,
  closeCashRegister,
  listMenuForAdmin,
  getScopedProduct,
  getScopedCategory,
  listCoupons,
  getScopedCoupon,
  isCouponCodeTaken,
} from "./admin-queries.js";
import { validateConfig } from "./config.js";
import { authenticateAdmin, resolveAdminFromToken, safeEqual } from "./auth.js";
import { listAdminUsers, createAdminUser, setUserPassword, setUserActive, deleteAdminUser } from "./admin-users.js";
import { isValidPhone, isValidEmail, isValidIdentification } from "../src/utils/validation.js";

// ============================================================
// FUSIÓN WOK — API + servidor de producción
// Endpoints:
//   POST  /api/orders                       → crea pedido (WhatsApp o MP)
//   POST  /api/orders/:id/payment-link      → reintenta generar el link de MP
//   GET   /api/orders/:id                   → estado público de un pedido (polling)
//   GET   /api/orders/number/:orderNumber   → tracking del cliente
//   GET   /api/orders/by-phone/:phone       → pedidos del cliente por teléfono
//   GET   /api/menu/:branchId               → menú de una sucursal (desde la BD)
//   POST  /api/events                       → registro de eventos (analytics)
//   POST  /api/coupons/validate             → validar cupón de descuento
//   POST  /api/shipping/quote               → calcular costo de envío (Tandil)
//   POST  /api/webhooks/mercadopago         → webhook de pago (verifica + actualiza)
//   POST  /api/payments/demo/:id/:action    → simular aprobación/rechazo (solo demo)
//   POST  /api/admin/login                  → login del panel (cookie httpOnly)
//   POST  /api/admin/logout                 → cierre de sesión
//   GET   /api/admin/me                     → sesión del panel
//   GET   /api/admin/orders                 → listado con filtros y paginación
//   GET   /api/admin/orders/:id             → detalle
//   GET   /api/admin/stats                  → estadísticas y embudo (período)
//   PATCH /api/admin/orders/:id/status      → cambiar estado (devuelve link wa.me)
//   POST  /api/admin/orders/:id/refund      → devolver dinero (total o parcial)
//   GET   /api/admin/products               → productos (edición de menú)
//   POST  /api/admin/products               → crear producto
//   PUT   /api/admin/products/:id           → editar producto
//   PATCH /api/admin/products/:id/available → ocultar/mostrar producto
//   DELETE /api/admin/products/:id          → eliminar producto
//   POST  /api/admin/products/:id/move      → reordenar producto (↑/↓)
//   POST  /api/admin/categories             → crear categoría
//   PUT   /api/admin/categories/:id         → renombrar categoría
//   DELETE /api/admin/categories/:id        → eliminar categoría (+ productos)
//   POST  /api/admin/categories/:id/move    → reordenar categoría (↑/↓)
//   PUT   /api/admin/groups                 → renombrar grupo
//   DELETE /api/admin/groups                → eliminar grupo (+ productos)
//   GET   /api/admin/coupons                → listar cupones
//   POST  /api/admin/coupons                → crear cupón
//   PATCH /api/admin/coupons/:id            → activar/desactivar cupón
//   PUT   /api/admin/coupons/:id            → editar cupón
//   DELETE /api/admin/coupons/:id           → eliminar cupón
//   POST  /api/admin/upload                 → subir imagen de producto
//   GET   /api/admin/customers               → clientes agrupados por teléfono
//   GET   /api/admin/sales                   → ventas por período + medios de pago
//   GET   /api/admin/cash-register           → caja abierta + historial de arqueos
//   POST  /api/admin/cash-register/open      → abrir caja
//   POST  /api/admin/cash-register/:id/close → cerrar caja (calcula diferencia)
//   POST  /api/admin/orders/manual           → cargar pedido de WhatsApp/mostrador
//   GET   /api/admin/users                  → cuentas de admin de sucursal (solo superadmin)
//   POST  /api/admin/users                  → crear cuenta de sucursal
//   PUT   /api/admin/users/:id/password     → cambiar contraseña de una cuenta
//   PATCH /api/admin/users/:id              → activar/desactivar una cuenta
//   DELETE /api/admin/users/:id             → borrar una cuenta (definitivo; 404 si no existe)
// ============================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const app = express();

// Estamos detrás del proxy de Render (terminación TLS). Sin esto, req.ip es la
// IP del proxy: TODOS los rate limits y el bloqueo progresivo de login se
// llavearían con la MISMA clave → un atacante agota los buckets de todos
// (DoS global). Con 1 salto confiado, Express lee la X-Forwarded-For real.
app.set("trust proxy", 1);

// ---------- validación de configuración (fail-fast en producción) ----------
// La validación vive en server/config.js (función pura) para poder probarla
// sin arrancar el server ni tocar la base real. Acá solo se ejecuta: imprime
// el informe y, si en producción hay algo que va a romper el arranque, corta.
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "fusionwok";

function runConfigCheck() {
  const report = validateConfig(process.env);
  for (const w of report.warnings) console.warn(`⚠️  ${w}`);
  if (!report.problems.length) {
    console.log(report.warnings.length ? "✅ Configuración válida (con advertencias)" : "✅ Configuración válida");
    return;
  }
  for (const p of report.problems) console.error(`❌ ${p}`);
  if (report.fatal) {
    console.error(
      "\n❌ Configuración inválida: el server NO arranca. Arreglá el .env (o las variables del panel de Render) y volvé a desplegar.\n" +
        "   Para probar en local sin credenciales: DEMO_MODE=true y NODE_ENV distinto de production."
    );
    process.exit(1);
  }
}
runConfigCheck();

// Siembra el menú y las categorías en la BD (solo la primera vez).
// Va DESPUÉS de la validación: si el .env está roto no tiene sentido que
// escribamos 97 productos en la base antes de descubrirlo.
await seedProducts(MENUS);
await seedCategories(MENUS);

// ---------- salud de las credenciales de Mercado Pago ----------
// MP_ACCESS_TOKEN "estar presente" no significa "ser válido": un token revocado,
// caducado o sin la policy de Orders pasa la validación de arriba y recién
// falla cuando un cliente intenta pagar. Se chequea una vez al arrancar para
// que el operador se entere al deployar y no con el primer pedido del día.
//
// NO es fatal: el sitio sigue vivo y los pedidos por efectivo/transferencia/
// WhatsApp funcionan igual. Solo el pago con MP queda caido hasta que se
// regenere el token (el proceso no se reinicia solo: Render lo reiniciaría en
// bucle sin resolver la causa).
let mpAuthBroken = false;

async function probeMpCredentials() {
  if (isDemoMode()) return;
  try {
    const info = await checkMpCredentials();
    console.log(`✅ Mercado Pago: credenciales válidas${info.nickname ? ` (${info.nickname})` : ""}`);
  } catch (err) {
    if (err instanceof MpError && err.isAuthError) {
      mpAuthBroken = true;
      // 403 + PolicyAgent NO es "el token venció": el token fue reconocido y lo
      // rechazó una policy de la cuenta (MP documenta este caso como cuenta
      // bloqueada con las API keys revocadas). Decir "regenerá el token" ahí
      // manda al operador a una tarea que no lo arregla.
      const byPolicies = err.status === 403 && String(err.mpCode).startsWith("PA_UNAUTHORIZED");
      console.error(
        byPolicies
          ? "❌ Mercado Pago rechazó las credenciales por PolicyAgent (" + err.mpCode + ").\n" +
              "   El token es válido pero la cuenta no pasó la validación de policies: MP\n" +
              "   documenta este caso como cuenta bloqueada con las API keys revocadas.\n" +
              "   Se resuelve con el Soporte de Mercado Pago (o completando los datos de la\n" +
              "   cuenta en el panel); REGENERAR EL TOKEN EN EL PANEL NO LO ARREGLA.\n" +
              "   Mientras tanto, efectivo/transferencia/WhatsApp siguen funcionando."
          : "❌ Mercado Pago rechazó el MP_ACCESS_TOKEN (" + (err.mpCode || err.status) + ").\n" +
              "   El checkout con Mercado Pago NO va a funcionar hasta que se regenere el token:\n" +
              "   Panel de MP → tu app → Credenciales → copiar el Access Token nuevo.\n" +
              "   Mientras tanto, los pedidos por efectivo/transferencia/WhatsApp siguen funcionando."
      );
    } else {
      console.warn(
        `⚠️  No pudimos verificar las credenciales de Mercado Pago (${err.message}). ` +
          "Puede ser una caída puntual de MP: los pagos se reintentarán."
      );
    }
  }
}
probeMpCredentials().catch(() => {});

// Crea la order de MP para un pedido ya guardado, o lanza MpError. Si el token
// quedó marcado como roto se corta acá: es el mismo error que devolvería MP,
// pero sin gastar una request ni esperar el timeout.
// `payer` lleva los datos del comprador que viajan al body de la order
// (email, firstName/lastName, identification). `additionalInfo` lleva el
// dato antifraude (fecha del primer pedido del comprador). Se arman del
// request en el checkout y de la fila de la base en el reintento del
// payment-link, así ambos caminos mandan lo mismo que tienen a mano.
async function createMpOrderForOrder({ orderNumber, total, description, base, payer, additionalInfo, mpItems }) {
  if (mpAuthBroken) throw mpAuthError();
  return createOrder({
    orderNumber,
    total,
    title: `Pedido Fusión Wok ${orderNumber}`,
    description,
    backUrls: {
      success: `${base}/?pago=aprobado&pedido=${orderNumber}`,
      failure: `${base}/?pago=rechazado&pedido=${orderNumber}`,
      pending: `${base}/?pago=pendiente&pedido=${orderNumber}`,
    },
    payer,
    additionalInfo,
    items: mpItems,
  });
}

// Items REALES del carrito para la order de MP, o null si la suma exacta no
// se puede construir (buildOrderItems es pura y fija la regla: el fallback
// se decide acá para que el warn quede en el log del server). El que no
// cuadra pierde el detalle pero cobra exactamente igual.
function mpItemsForCart({ orderNumber, cartItems, total, discount, shippingCost }) {
  const items = buildOrderItems({ items: cartItems, total, discount, shippingCost });
  if (!items) {
    console.warn(
      `[MP] pedido ${orderNumber}: los items del carrito no cuadran con el total (${total}, descuento ${discount}, envio ${shippingCost}); se envia el item unico`
    );
  }
  return items;
}

// Fecha del primer pedido de un teléfono, en el formato ISO 8601 con offset
// que usa additional_info["payer.registration_date"]. La query corre DESPUÉS
// del INSERT del pedido nuevo y eso es intencional: para un cliente nuevo,
// el pedido recién insertado ES su primer pedido, así que MIN(created_at)
// cae en "ahora", justo lo que pide la doc de MP; para uno que ya compró,
// devuelve su primer pedido de verdad. Es best-effort: si la query falla se
// devuelve "" y el campo simplemente no viaja (nunca rompe un cobro por un
// dato antifraude).
async function registrationDateFor(phone) {
  try {
    const first = await db
      .prepare("SELECT MIN(created_at) AS first FROM orders WHERE customer_phone = ?")
      .get(phone);
    return toRegistrationDate(first?.first || now());
  } catch {
    return "";
  }
}

// CORS: solo orígenes permitidos (mismo origen por defecto)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : false }));
app.use(express.json({ limit: "6mb" }));

// Compresión gzip para respuestas de texto (JSON, HTML, JS, CSS).
// No usamos el paquete `compression` porque con Express 5 se corrompe
// (marca Content-Encoding: gzip pero envía el cuerpo sin comprimir).
// Este middleware bufferiza el body y lo comprime al final:
// - Solo respuestas de texto (nunca imágenes/descargas/304).
// - No comprime cuerpos menores a 1 KB (umbral).
// - Negocia por Accept-Encoding y avisa con Vary.
// Los cuerpos compatibles son chicos (CSS 62KB, JS ≤250KB, JSON); bufferizar
// no es un problema acá, y evita los bugs de streaming/backpressure.
const GZIP_THRESHOLD = 1024;
function isCompressible(type) {
  return (
    type.startsWith("text/") ||
    type.startsWith("application/json") ||
    type.startsWith("application/javascript") ||
    type.startsWith("application/xml") ||
    type.startsWith("image/svg+xml")
  );
}
app.use((req, res, next) => {
  const acceptsGzip = /\bgzip\b/i.test(req.headers["accept-encoding"] || "");
  if (!acceptsGzip) return next();
  if (res.headersSent) return next();

  let buffering = false; // true → estamos acumulando y vamos a comprimir
  let chunks = [];
  let size = 0;
  const write = res.write.bind(res);
  const end = res.end.bind(res);

  function finish() {
    const body = Buffer.concat(chunks, size);
    if (size <= GZIP_THRESHOLD || !isCompressible(String(res.getHeader("Content-Type") || ""))) {
      res.setHeader("Content-Length", size);
      write(body);
      return end();
    }
    const zipped = gzipSync(body, { level: 6 });
    res.removeHeader("Content-Length");
    res.setHeader("Content-Encoding", "gzip");
    if (res.getHeader("Vary")) res.append("Vary", "Accept-Encoding");
    else res.setHeader("Vary", "Accept-Encoding");
    write(zipped);
    return end();
  }

  res.write = function (chunk, encoding, callback) {
    if (!buffering) {
      // Primera escritura: si el Content-Type ya está definido y es texto,
      // absorbemos el body (si el header llega más tarde, res.end bufferiza).
      const type = String(res.getHeader("Content-Type") || "");
      buffering = isCompressible(type);
    }
    let buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    chunks.push(buf);
    size += buf.length;
    if (typeof callback === "function") callback();
    return true;
  };
  res.end = function (chunk, encoding, callback) {
    if (!buffering) {
      // Sin writes previos: decidimos ahora por el header ya fijado.
      const type = String(res.getHeader("Content-Type") || "");
      buffering = isCompressible(type);
    }
    if (chunk !== undefined && chunk !== null && chunk !== "") {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
      size += chunks[chunks.length - 1].length;
    }
    finish();
    if (typeof callback === "function") callback();
    return res;
  };
  next();
});

// Headers de seguridad básicos
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  // HSTS: los navegadores solo lo honran en respuestas HTTPS (Render lo es);
  // en HTTP plano (dev local) el header se ignora sin romper nada.
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

// Las API nunca deben cachearse (datos en vivo: pedidos, menú, admin).
// Se registra ANTES de las rutas para que aplique a todas las respuestas.
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});

// Protección CSRF para las mutaciones del panel (doble capa):
//  1) Origin check: solo orígenes permitidos (mismo host, ALLOWED_ORIGINS o dev).
//  2) Token de doble cookie: el header X-CSRF-Token debe coincidir con la
//     cookie fw_admin_csrf que se emite en el login. Un sitio ajeno no puede
//     leer esa cookie (same-origin policy): cubre DNS rebinding y peticiones
//     cross-site sin Origin, aunque el Host coincida con el nuestro.
// /api/admin/login queda exento: el primer login todavía no tiene cookie CSRF.
app.use("/api/admin", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.originalUrl === "/api/admin/login") return next();
  const origin = req.headers.origin;
  if (origin) {
    let allowed = false;
    try {
      const o = new URL(origin);
      // Mismo host directo (producción: todo detrás del mismo dominio)
      if (o.host === req.headers.host) allowed = true;
      // Orígenes habilitados vía ALLOWED_ORIGINS (p. ej. el front servido
      // desde otro puerto/dominio que el backend)
      else if (allowedOrigins.includes(o.origin)) allowed = true;
      // En desarrollo el proxy de Vite reescribe el Host (changeOrigin), así
      // que el origen del navegador es localhost:5173 y el host llega como
      // localhost:3001. Se acepta localhost/127.0.0.1 en cualquier puerto.
      else if (
        process.env.NODE_ENV !== "production" &&
        ["localhost", "127.0.0.1"].includes(o.hostname)
      ) {
        allowed = true;
      }
    } catch {
      return res.status(403).json({ error: "Origen inválido" });
    }
    if (!allowed) return res.status(403).json({ error: "Origen no permitido" });
  }
  // Doble cookie CSRF: header debe igualar la cookie emitida en el login.
  const cookieToken = readCookie(req, "fw_admin_csrf");
  const headerToken = String(req.headers["x-csrf-token"] || "").trim();
  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    return res.status(403).json({ error: "Token CSRF inválido" });
  }
  return next();
});

// ---------- utilidades ----------
// Base URL para canonical/og:image/sitemap. Si PUBLIC_BASE_URL está seteado
// se usa tal cual (importante con tu dominio propio). Si no, se deriva del
// request (Host + proto) → funciona sin config en el subdominio *.onrender.com
// y en cualquier dominio que apunte al servicio.
const ENV_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
if (process.env.NODE_ENV === "production" && !ENV_BASE_URL) {
  console.warn(
    "⚠️  PUBLIC_BASE_URL no está definido: las URLs canónicas, el sitemap y los " +
      "back_urls de Mercado Pago se derivarán del header Host (residual de host " +
      "header injection). Fijalo en el dashboard de Render."
  );
}
// Host header injection (canonical/sitemap/back_urls de MP): solo se confía en
// hosts con forma plausible de hostname[:puerto]. Cualquier carácter raro
// (/, \, espacios, %) cae al default local. La solución completa es fijar
// PUBLIC_BASE_URL en el entorno de producción.
function safeHostForBaseUrl(req) {
  const host = String(req.headers.host || "").trim();
  if (!host) return "";
  return /^[A-Za-z0-9.-]+(?::\d{2,5})?$/.test(host) ? host : "";
}
function requestBaseUrl(req) {
  if (ENV_BASE_URL) return ENV_BASE_URL;
  const host = safeHostForBaseUrl(req);
  if (!host) return `http://localhost:${PORT}`;
  const proto = req.headers["x-forwarded-proto"];
  return `${proto && String(proto).includes("https") ? "https" : "http"}://${host}`;
}
const TOKEN_TTL_MS = Number(process.env.ADMIN_TOKEN_TTL_MS || 24 * 3600 * 1000); // 24h por defecto

// Parsea un :id de ruta de forma estricta (solo dígitos). Number() acepta
// notaciones raras ("1e3", "0x10") que no son ids canónicos.
function paramId(value) {
  const s = String(value || "").trim();
  return /^\d+$/.test(s) ? Number(s) : NaN;
}

// Carpeta de imágenes de producto (servida como /uploads)
const uploadsDir = path.join(__dirname, "..", "public", "uploads", "products");
mkdirSync(uploadsDir, { recursive: true });
// Las imágenes tienen nombres únicos (timestamp + random), así que pueden
// cachearse por un tiempo sin riesgo (nunca se sobreescribe la misma URL).
app.use(
  "/uploads",
  express.static(path.join(__dirname, "..", "public", "uploads"), {
    maxAge: "7d",
    immutable: false,
  })
);

function now() {
  return new Date().toISOString();
}

// Argentina NO usa horario de verano: UTC fijo -03:00. El frontend manda las
// fechas elegidas como datetime-local ("YYYY-MM-DDTHH:mm", sin zona). Si acá
// se usara `new Date(s)` el resultado dependería de la zona del servidor
// (UTC en Render, -03:00 en dev), corriendo la hora hasta ~3h. Este helper
// las interpreta SIEMPRE en hora argentina para guardar el instante correcto.
const LOCAL_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
function parseArLocal(s) {
  if (typeof s !== "string" || !LOCAL_DT_RE.test(s)) return new Date(NaN);
  return new Date(`${s}:00-03:00`);
}

function getClientIp(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

// Lee el token del admin desde la cookie httpOnly o el header Authorization
function getAdminToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const cookie = req.headers.cookie || "";
  for (const part of cookie.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === "fw_admin_token") {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

// Lee una cookie puntual del header Cookie (sin librerías)
function readCookie(req, name) {
  const cookie = req.headers.cookie || "";
  for (const part of cookie.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

// La cookie de sesión solo debe viajar por HTTPS. Se marca Secure cuando:
//  - NODE_ENV=production (Render lo define por defecto), o
//  - la request llegó por TLS (req.secure usa X-Forwarded-Proto con trust proxy), o
//  - hay credenciales reales de MP (nunca cookies por HTTP plano).
function isSecureRequest(req) {
  return process.env.NODE_ENV === "production" || !!req.secure || !isDemoMode();
}

// ---------- rate limiting simple (en memoria) ----------
const rateBuckets = new Map();
function rateLimit({ windowMs = 60000, max = 30, name = "api" } = {}) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const key = `${name}:${ip}`;
    const nowTime = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.reset < nowTime) {
      rateBuckets.set(key, { count: 1, reset: nowTime + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).json({ error: "Demasiadas solicitudes, intentá más tarde" });
    }
    return next();
  };
}

// Rate limit con clave custom (p. ej. teléfono+IP) para casos como by-phone,
// donde varios clientes pueden compartir IP (NAT) o uno solo usar varias.
const keyedBuckets = new Map();
function rateLimitByKey(keyFn, { windowMs = 10 * 60 * 1000, max = 8, name = "keyed" } = {}) {
  return (req, res, next) => {
    const key = `${name}:${keyFn(req)}`;
    const nowTime = Date.now();
    const bucket = keyedBuckets.get(key);
    if (!bucket || bucket.reset < nowTime) {
      keyedBuckets.set(key, { count: 1, reset: nowTime + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).json({ error: "Demasiadas solicitudes, intentá más tarde" });
    }
    return next();
  };
}

// ---------- catálogo de productos (para validar precios server-side) ----------
// La BD es la fuente de verdad del menú. Se siembra desde los archivos
// estáticos la primera vez y luego se edita desde el panel admin.
async function buildCatalog() {
  // Object.create(null): una branch llamada "__proto__" (admitida por el regex
  // del panel) no puede contaminar la cadena de prototipos de este mapa.
  const catalog = Object.create(null);
  const rows = await db.prepare("SELECT * FROM products ORDER BY sort_order").all();
  for (const row of rows) {
    const p = toProduct(row);
    if (!catalog[row.branch]) catalog[row.branch] = {};
    catalog[row.branch][p.id] = {
      price: p.price,
      available: p.available,
      // Descripción del producto: se guarda acá para que validateOrderBody
      // la copie a los cleanItems y llegue a MP como items[].description.
      description: p.description || "",
      extras: new Map((p.extras || []).map((e) => [e.id, e.price])),
    };
  }
  return catalog;
}
let CATALOG = await buildCatalog();

// El menú público es casi estático: se cachea por sucursal para no golpear la
// DB en cada carga de la tienda. Se invalida ante cualquier edición de
// productos/categorías/grupos (invalidateMenuCache) y además expira solo (TTL)
// como red de seguridad frente a cambios hechos por fuera de los handlers.
const MENU_TTL_MS = 30 * 1000;
const menuCache = new Map(); // branchId -> { at, menu }

function invalidateMenuCache() {
  menuCache.clear();
}

// Devuelve el menú de una sucursal en formato tienda (categorías → grupos → productos)
async function getMenuFromDb(branchId) {
  const cached = menuCache.get(branchId);
  if (cached && Date.now() - cached.at < MENU_TTL_MS) return cached.menu;
  const rows = await db
    .prepare(
      `SELECT p.* FROM products p
       LEFT JOIN categories c ON c.branch = p.branch AND c.category_id = p.category_id
       WHERE p.branch = ? AND p.available = 1
       ORDER BY COALESCE(c.sort_order, 999999), p.sort_order`
    )
    .all(branchId);
  const categories = [];
  const catIndex = new Map();
  for (const row of rows) {
    const p = toProduct(row);
    if (!catIndex.has(row.category_id)) {
      const cat = { id: row.category_id, name: row.category_name || row.category_id, groups: [] };
      catIndex.set(row.category_id, cat);
      categories.push(cat);
    }
    const cat = catIndex.get(row.category_id);
    let group = cat.groups.find((g) => g.name === row.group_name);
    if (!group) {
      group = { name: row.group_name || null, products: [] };
      cat.groups.push(group);
    }
    group.products.push(p);
  }
  const menu = { branchId, categories, topProductIds: await getTopProductIds(branchId) };
  menuCache.set(branchId, { at: Date.now(), menu });
  return menu;
}

// Productos más pedidos de una sucursal: cantidad de pedidos confirmados
// (no cancelados) en los últimos 30 días que incluyen cada producto.
// Se muestra en la tienda con un badge "🔥 Más pedido" (mínimo 5 pedidos).
async function getTopProductIds(branchId) {
  try {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const rows = await db
      .prepare(
        `SELECT id, items FROM orders
         WHERE branch = ? AND payment_status = 'approved' AND status != 'cancelled'
           AND created_at >= ?`
      )
      .all(branchId, since);
    const byProduct = new Map(); // productId -> Set(orderId)
    for (const row of rows) {
      let items;
      try { items = JSON.parse(row.items); } catch { continue; }
      for (const it of items) {
        const id = typeof it.productId === "string" ? it.productId : "";
        if (!id) continue;
        if (!byProduct.has(id)) byProduct.set(id, new Set());
        byProduct.get(id).add(row.id);
      }
    }
    return Array.from(byProduct.entries())
      .filter(([, ordersWith]) => ordersWith.size >= 5)
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, 3)
      .map(([id]) => id);
  } catch (err) {
    console.error("getTopProductIds:", err.message);
    return [];
  }
}

// Slugs únicos por sucursal (para nuevos productos)
function slugify(text) {
  return (
    String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "producto"
  );
}

async function uniqueProductId(branchId, base) {
  let id = slugify(base);
  let n = 1;
  while (await db.prepare("SELECT 1 FROM products WHERE branch = ? AND product_id = ?").get(branchId, id)) {
    n += 1;
    id = `${slugify(base)}-${n}`;
  }
  return id;
}


// Valida y normaliza el cuerpo del pedido (evita manipulación de precios,
// cantidades negativas, productos inexistentes y pedidos falsos).
async function validateOrderBody(body, { requireEmail = false } = {}) {
  const { branch, customer, orderMode, paymentMethod, items, notes, scheduledFor, couponCode } = body || {};
  if (!CATALOG[branch]) return { error: "Sucursal inválida" };
  // Nombre del cliente: el canal web manda name + firstName/lastName; el
  // manual solo name. Con cualquiera de los dos alcanza.
  const hasName =
    typeof customer?.name === "string" && customer.name.trim() && customer.name.trim().length <= 100;
  const hasFirstLast =
    typeof customer?.firstName === "string" &&
    customer.firstName.trim() &&
    typeof customer?.lastName === "string" &&
    customer.lastName.trim();
  if (!hasName && !hasFirstLast) {
    return { error: "Faltan datos del cliente" };
  }
  const phone = String(customer.phone || "").trim();
  // Mismo regex que el front (isValidPhone): el server valida igual y además
  // NORMALIZA el teléfono a solo dígitos (sin espacios/guiones/paréntesis),
  // para que "Mis pedidos" (búsqueda por teléfono) coincida sin importar el
  // formato con que el cliente lo tipeó al cargar el pedido.
  if (!isValidPhone(phone)) return { error: "Falta un teléfono válido" };
  const normalizedPhone = phone.replace(/\D/g, "");
  // Email del comprador: MP lo exige dentro de payer en el checkout online
  // (si viene el objeto payer, la doc de Orders requiere payer.email). Se
  // exige SOLO cuando el pago es con Mercado Pago; en efectivo/transferencia
  // el campo ni aparece en el checkout. En la carga manual del panel es
  // opcional (el admin rara vez tiene el email de un cliente que escribió
  // por WhatsApp), pero si viene se valida igual. Se normaliza a minúsculas
  // sin espacios, como pide la validación compartida con el front.
  const email = String(customer.email || "").trim().toLowerCase();
  if (requireEmail && !email) return { error: "Ingresá tu email para confirmar el pedido." };
  if (email && !isValidEmail(email)) return { error: "El email no parece válido. Revisalo y volvé a intentar." };
  // Nombre y apellido: el checkout web los manda separados (MP los quiere así
  // para el payer); la carga manual del panel sigue mandando el name único.
  // Nunca se "parte" un nombre compuesto: si el canal no manda first/last se
  // usa el name tal cual, que es el comportamiento que ya existía.
  const firstName = String(customer.firstName || "").trim().slice(0, 100);
  const lastName = String(customer.lastName || "").trim().slice(0, 100);
  if ((firstName || lastName) && !(firstName && lastName)) {
    return { error: "Completá tu nombre y apellido." };
  }
  // Identificación del comprador (opcional, DATO SENSIBLE): solo se valida y
  // se pasa a MP como payer.identification; nunca se persiste en la base ni
  // se loguea. A medias (solo tipo o solo número) se rechaza para no mandar
  // a MP un dato adivinado.
  let identification = null;
  const idType = customer.identification ? String(customer.identification.type || "").trim() : "";
  const idNumber = customer.identification ? String(customer.identification.number || "").trim() : "";
  if (idType || idNumber) {
    if (!idType || !idNumber) return { error: "Completá el tipo y el número de documento, o dejá los dos vacíos." };
    if (!isValidIdentification(idType, idNumber)) {
      return { error: "El número de documento no parece válido para ese tipo. Revisalo." };
    }
    identification = { type: idType, number: idNumber.replace(/[\s.-]/g, "") };
  }
  if (!["delivery", "pickup"].includes(orderMode)) return { error: "Modalidad inválida" };
  if (!["mercadopago", "efectivo", "transferencia"].includes(paymentMethod)) {
    return { error: "Método de pago inválido" };
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
    return { error: "Faltan productos" };
  }
  // Fecha programada (opcional): entre 10 min y 7 días. El checkout puede
  // enviar la hora local del DateTimePicker ("YYYY-MM-DDTHH:mm") o ya
  // convertida a ISO ("...T00:00:00.000Z"). Se aceptan ambos, pero la ventana
  // de apertura se evalúa siempre en hora local argentina.
  let scheduled = "";
  if (scheduledFor) {
    const iso = LOCAL_DT_RE.test(scheduledFor) ? parseArLocal(scheduledFor) : new Date(scheduledFor);
    if (isNaN(iso.getTime())) return { error: "Fecha programada inválida" };
    const t = iso.getTime();
    if (t < Date.now() + 10 * 60000) {
      return { error: "La fecha programada debe ser al menos 10 minutos en el futuro" };
    }
    if (t > Date.now() + 7 * 86400000) {
      return { error: "La fecha programada no puede superar los 7 días" };
    }
    // El pedido programado debe caer dentro de la apertura de la sucursal
    // (ventanas definidas en src/data/branches.js, hora local argentina)
    if (!isOpenAtTime(branch, toWallclock(iso, "America/Argentina/Buenos_Aires"))) {
      return {
        error:
          "Elegí una fecha y hora dentro de nuestros horarios. Si querés, podés pedir " +
          (branch === "tandil" ? "todos los días de 11:30 a 15:30 y de 19:00 a 23:00" : "todos los días de 11:00 a 15:00 y de 19:30 a 23:30") +
          ".",
      };
    }
    scheduled = iso.toISOString();
  }
  const menu = CATALOG[branch];
  const cleanItems = [];
  let total = 0;
  for (const it of items) {
    const product = menu[it.productId];
    if (!product) return { error: "Producto inexistente" };
    if (!product.available) return { error: "Producto no disponible" };
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) return { error: "Cantidad inválida" };
    if (Number(it.unitPrice) !== product.price) {
      const name = String(it.name || "").trim() || "de un producto";
      return {
        error: `El precio de "${name}" cambió a $${product.price}. Actualizá el pedido para ver los precios actuales.`,
      };
    }
    const extras = [];
    for (const e of it.extras || []) {
      const extraPrice = product.extras.get(e.id);
      if (extraPrice === undefined) return { error: "Extra inválido" };
      extras.push({ id: e.id, label: String(e.label || "").slice(0, 80), price: extraPrice });
    }
    const extrasTotal = extras.reduce((a, e) => a + e.price, 0);
    total += (product.price + extrasTotal) * qty;
    cleanItems.push({
      key: String(it.key || `${it.productId}-${extras.map((x) => x.id).sort().join(",")}`).slice(0, 120),
      productId: it.productId,
      name: String(it.name || "").slice(0, 120),
      // Descripción del PRODUCTO (del catálogo): viaja a MP como
      // items[].description. Límite real de la API: 256 chars (probado
      // contra la API de prueba: "length must be <= 256").
      description: String(product.description || "").trim().slice(0, 256),
      unitPrice: product.price,
      extras,
      notes: String(it.notes || "").slice(0, 300),
      qty,
    });
  }
  const address = orderMode === "delivery" ? String(body.address || "").trim() : "";
  if (orderMode === "delivery" && !address) return { error: "Falta la dirección de entrega" };

  // Cupón de descuento (opcional): se valida contra la BD y se recalcula.
  // `branch` es la sucursal del pedido: un cupón local de la otra sucursal
  // no aplica acá (T14).
  let discount = 0;
  let appliedCoupon = "";
  if (couponCode) {
    const coupon = await applyCoupon(db, couponCode, total, branch);
    if (coupon.error) return { error: coupon.error };
    discount = coupon.discount;
    appliedCoupon = coupon.code;
  }
  // Envío (solo delivery en Tandil por ahora): se recalcula server-side para
  // que nadie pueda trucar el costo desde el cliente.
  let shipping = { cost: 0, blocks: 0, supported: branch === "tandil" };
  if (orderMode === "delivery" && branch === "tandil") {
    try {
      shipping = await computeShipping(branch, address);
    } catch (err) {
      const code = err && err.code;
      // Errores DEFINITIVOS (fuera de zona / dirección no encontrada): se
      // rechazan igual para todos los medios de pago. Antes, efectivo y
      // transferencia pasaban con envío "pendiente" y se aceptaban direcciones
      // fuera de la zona de reparto.
      if (code === "zone" || code === "unknown") {
        return { error: err.message };
      }
      // Fallo TRANSITORIO (proveedores caídos) o inesperado:
      //  - Mercado Pago → se bloquea (no se puede cobrar sin saber el costo),
      //    pero se marca `code: shipping_unavailable` + contactWhatsApp para que
      //    el checkout ofrezca hablar con el local en vez de dejar al cliente
      //    sin salida. El `code` es lo que permite distinguir este fallo del de
      //    "no se pudo generar el link de pago": ambos son WhatsApp, pero son
      //    cosas distintas y el mensaje tiene que decirlo.
      //  - Efectivo/transferencia → el pedido pasa igual con envío "pendiente";
      //    el costo se confirma por WhatsApp antes de salir (badge en el panel).
      if (paymentMethod === "mercadopago") {
        const msg = code === "transient" ? err.message : "No pudimos calcular el envío. Escribinos por WhatsApp.";
        return { error: msg, code: "shipping_unavailable", contactWhatsApp: true };
      }
      shipping = { cost: 0, blocks: 0, supported: true, pending: true };
    }
  }
  return {
    data: {
      branch,
      customer: {
        // Con first/last, el nombre guardado es "Nombre Apellido" (lo que ya
        // esperan el panel, el ticket y el mensaje de WhatsApp); sin ellos,
        // el name que mandó el canal (manual), tal cual. Mismo tope de 100
        // caracteres que siempre tuvo customer.name.
        name: (
          firstName && lastName ? `${firstName} ${lastName}` : customer.name.trim()
        ).slice(0, 100),
        phone: normalizedPhone,
        email,
        firstName,
        lastName,
        identification,
      },
      orderMode,
      paymentMethod,
      address: address.slice(0, 200),
      items: cleanItems,
      notes: String(notes || "").slice(0, 300),
      total: total - discount + shipping.cost,
      discount,
      couponCode: appliedCoupon,
      scheduledFor: scheduled,
      shipping,
    },
  };
}

// Registra un evento de analytics (sin datos personales)
async function recordEvent(type, branch) {
  if (!EVENT_TYPES.includes(type)) return;
  await db.prepare("INSERT INTO events (type, branch, created_at) VALUES (?, ?, ?)").run(
    type,
    typeof branch === "string" && CATALOG[branch] ? branch : "",
    now()
  );
}

// Autenticación del admin (cookie httpOnly o token en tabla admin_tokens).
// resolveAdminFromToken resuelve QUIÉN llama: rol y sucursal salen del
// token (y de admin_users, la fuente de verdad), nunca del cliente.
// El resto de los endpoints lee req.admin y no vuelve a tocar las
// credenciales.
async function requireAdmin(req, res, next) {
  try {
    const token = getAdminToken(req);
    const admin = await resolveAdminFromToken(db, token, { maxAgeMs: TOKEN_TTL_MS });
    // invalid y expired devuelven los mismos textos que antes: el
    // frontend cierra la sesión del panel dependiendo de ellos.
    if (admin.invalid) return res.status(401).json({ error: "No autorizado" });
    if (admin.expired) return res.status(401).json({ error: "Sesión expirada" });
    req.admin = {
      role: admin.role,
      branch: admin.branch,
      userId: admin.userId,
      username: admin.username,
    };
    return next();
  } catch (err) {
    console.error("requireAdmin:", err.message);
    return res.status(500).json({ error: "Error al validar la sesión" });
  }
}

// Solo el superadmin (el dueño) pasa. Se encadena DESPUÉS de requireAdmin,
// que es quien completa req.admin.
function requireSuperadmin(req, res, next) {
  if (req.admin?.role !== "superadmin") {
    return res.status(403).json({ error: "Solo el administrador principal puede hacer esto" });
  }
  next();
}

// ---------- rate limit de login (bloqueo progresivo por IP) ----------
// 1-4 fallos en 60s → bloqueo por rateLimit básico (429)
// ≥10 fallos → bloqueo 5 min · ≥20 fallos → bloqueo 30 min
const loginAttempts = new Map(); // ip → { fails, blockedUntil }

function recordLoginFailure(req) {
  const ip = getClientIp(req);
  const entry = loginAttempts.get(ip) || { fails: 0, blockedUntil: 0, at: 0 };
  entry.fails += 1;
  const t = Date.now();
  entry.at = t;
  if (entry.fails >= 20) entry.blockedUntil = t + 30 * 60000;
  else if (entry.fails >= 10) entry.blockedUntil = t + 5 * 60000;
  loginAttempts.set(ip, entry);
}

function recordLoginSuccess(req) {
  loginAttempts.delete(getClientIp(req));
}

function progressiveLoginLimit(req, res, next) {
  const entry = loginAttempts.get(getClientIp(req));
  if (entry && entry.blockedUntil > Date.now()) {
    const wait = Math.ceil((entry.blockedUntil - Date.now()) / 1000);
    return res.status(429).json({ error: `Demasiados intentos. Esperá ${wait}s e intentá de nuevo` });
  }
  next();
}

// Poda periódica de los maps en memoria (rate limits y login): se eliminan
// las claves vencidas para que la memoria no crezca sin límite con IPs
// distintas. Corre en segundo plano y no mantiene vivo el proceso.
setInterval(() => {
  const t = Date.now();
  for (const [k, b] of rateBuckets) if (b.reset < t) rateBuckets.delete(k);
  for (const [k, b] of keyedBuckets) if (b.reset < t) keyedBuckets.delete(k);
  for (const [k, e] of loginAttempts) {
    if (e.blockedUntil > t) continue; // bloqueo activo: no se toca
    if (e.at && t - e.at > 30 * 60000) loginAttempts.delete(k);
  }
}, 15 * 60 * 1000).unref();

// ---------- pedidos (cliente) ----------

// Traduce un fallo de Mercado Pago a la respuesta que ve el cliente.
//
// El pedido YA está guardado cuando se llama esto (por diseño, para que nunca
// quede una order de pago huérfana sin pedido), así que la respuesta SIEMPRE
// lleva orderId/orderNumber: el frontend los necesita para mostrarle el número
// al cliente y para que el link de WhatsApp lo incluya.
//
// El `code` es lo que el frontend usa para elegir el mensaje. Antes todo se
// colgaba de un `contactWhatsApp: true` que significaba dos cosas distintas
// (no se pudo cotizar el envío / no se pudo generar el link de pago) y el
// cliente terminaba mostrando "No pudimos calcular el envío" ante un fallo de
// pago. El `retryable` separa lo determinista de lo que vale la pena reintentar.
function mpUnavailablePayload(err, { orderId, orderNumber }) {
  const isAuth = err instanceof MpError && err.isAuthError;
  const retryable = err instanceof MpError ? err.retryable : true;
  const base = {
    orderId,
    orderNumber,
    orderCreated: true,
    contactWhatsApp: true,
    retryable,
  };
  if (isAuth) {
    // Problema de configuración (token revocado / sin policy): reintentar no
    // sirve nunca, el local tiene que resolverlo. 503 = servicio no disponible
    // (no 502: acá el gateway funcionó, lo que falla es el proveedor).
    return {
      status: 503,
      payload: {
        ...base,
        code: "mp_unauthorized",
        error:
          "Tu pedido quedó registrado pero el pago con Mercado Pago no está disponible en este momento. " +
          "Escribinos por WhatsApp con tu número de pedido y lo coordinamos.",
      },
    };
  }
  return {
    status: 503,
    payload: {
      ...base,
      code: retryable ? "mp_unavailable" : "mp_link_missing",
      error:
        "Tu pedido quedó registrado pero no pudimos generar el link de pago. " +
        "Podés reintentar en un momento o escribirnos por WhatsApp con tu número de pedido.",
    },
  };
}

// Ventana generosa a propósito: en el flujo de Mercado Pago es normal que el
// cliente cierre el modal y reintente el checkout varias veces. El abuso ya
// está cubierto por la validación de catálogo/precios server-side.
app.post("/api/orders", rateLimit({ max: 20, windowMs: 5 * 60 * 1000, name: "orders" }), async (req, res) => {
  try {
    // El email lo exige SOLO Mercado Pago (viaja como payer.email de la
    // order); con efectivo o transferencia el checkout ni lo muestra.
    // Sigue siendo una decisión server-side: el canal público la pide
    // según el método de pago, la carga manual del panel no la pide nunca.
    const result = await validateOrderBody(req.body, {
      requireEmail: req.body?.paymentMethod === "mercadopago",
    });
    if (result.error) {
      const payload = { error: result.error };
      if (result.code) payload.code = result.code;
      if (result.contactWhatsApp) payload.contactWhatsApp = true;
      return res.status(400).json(payload);
    }
    const { branch, customer, orderMode, paymentMethod, address, items, notes, total, discount, couponCode, scheduledFor, shipping } = result.data;

    const demo = isDemoMode();
    const isMp = paymentMethod === "mercadopago";

    // Reserva atómica del uso del cupón ANTES de cualquier await/insert:
    // evita que dos checkouts simultáneos consuman el mismo cupón limitado.
    // Primero se liberan reservas huérfanas de pedidos nunca pagados para que
    // el cupo no se queme con pedidos en pending_payment abandonados.
    await releaseStaleCouponReservations(db);
    let couponReserved = false;
    if (couponCode) {
      if (!(await reserveCoupon(db, couponCode, branch))) {
        return res.status(400).json({ error: "El cupón ya no tiene usos disponibles" });
      }
      couponReserved = true;
    }

    const ts = now();

    // El número de pedido se deriva del id real que asigna la DB (AUTOINCREMENT)
    // y se asigna en el MISMO batch que el INSERT: atómico y sin carrera (antes
    // se hacía MAX(id)+1, que chocaba con dos pedidos simultáneos). Para MP esto
    // invierte el orden viejo (preferencia antes que pedido): la fila se inserta
    // primero con un order_number temporal único y la order de MP se crea recién
    // después, con el número real como external_reference. Si la order falla, el
    // pedido ya existe y se puede reintentar el link — nunca queda una order de
    // pago huérfana sin pedido.
    let orderId;
    let orderNumber;
    let mpOrderId = null;
    let checkoutUrl = null;
    try {
      const tmpNumber = `tmp-${randomBytes(8).toString("hex")}`;
      const stmts = [
        {
          sql: `
        INSERT INTO orders
          (order_number, branch, customer_name, customer_phone, customer_email, customer_first_name, customer_last_name, address, order_mode,
           payment_method, payment_status, status, items, total, discount, coupon_code,
           scheduled_for, notes, shipping, shipping_km, shipping_pending, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
          args: [
            tmpNumber,
            branch,
            customer.name,
            customer.phone,
            customer.email,
            customer.firstName,
            customer.lastName,
            address,
            orderMode,
            paymentMethod,
            isMp ? "pending" : "approved", // efectivo/transferencia pagan al recibir → se aprueba directo
            isMp ? "pending_payment" : "received",
            JSON.stringify(items),
            total,
            discount,
            couponCode,
            scheduledFor,
            notes,
            shipping.cost,
            shipping.blocks,
            shipping.pending ? 1 : 0,
            ts,
            ts,
          ],
        },
        {
          // Número definitivo, derivado del id de la fila recién insertada
          sql: "UPDATE orders SET order_number = ? || printf('%05d', id), updated_at = ? WHERE id = last_insert_rowid()",
          args: ["FW-", ts],
        },
      ];
      if (!isMp) {
        stmts.push({
          sql: "INSERT INTO events (type, branch, created_at) VALUES (?, ?, ?)",
          args: ["order_created", branch, ts],
        });
      }
      const results = await db.batch(stmts, "write");
      const info = results[0];
      orderId = Number(info.lastInsertRowid);
      orderNumber = formatOrderNumber(orderId);
    } catch (err) {
      // El pedido no se llegó a crear: devolvemos el uso reservado del cupón.
      // No hay fila que marcar, y no hace falta: ni el webhook ni el sweep
      // pueden encontrar un pedido que no existe.
      if (couponReserved) await releaseOrphanReservation(db, couponCode, branch);
      throw err;
    }

    // Mercado Pago: recién acá se crea la order, con el pedido ya guardado
    // y su número real como external_reference (y como clave de idempotencia).
    // La fecha de registro del comprador sale de MIN(created_at) del teléfono:
    // para un cliente nuevo, el pedido recién insertado ES su primer pedido,
    // así que el MIN cae en "ahora", que es lo que la doc de MP pide; para
    // uno que ya compró, devuelve su primer pedido de verdad.
    if (isMp && !demo) {
      let mpOrder;
      try {
        mpOrder = await createMpOrderForOrder({
          orderNumber,
          total,
          description: `${items.length} items · ${branch}`,
          base: requestBaseUrl(req),
          // El email viaja como payer.email en el body de la order; MP lo usa
          // para precompletar el checkout y para el antifraude. La
          // identificación es dato sensible: pasa directo al body y no se
          // guarda en la base ni se loguea (el reintento del payment-link no
          // la tiene: limitación documentada en el reporte).
          payer: {
            ...(customer.email ? { email: customer.email } : {}),
            ...(customer.firstName ? { firstName: customer.firstName } : {}),
            ...(customer.lastName ? { lastName: customer.lastName } : {}),
            ...(customer.identification ? { identification: customer.identification } : {}),
          },
          additionalInfo: { registrationDate: await registrationDateFor(customer.phone) },
          // Items reales del carrito (con el envío como ítem y el descuento
          // repartido en los unit_price). Si no cuadran, buildOrderBody
          // termina mandando el ítem único: el total cobrado no cambia.
          mpItems: mpItemsForCart({
            orderNumber,
            cartItems: items,
            total,
            discount,
            shippingCost: shipping.cost,
          }),
        });
        mpOrderId = mpOrder.id;
        checkoutUrl = mpOrder.checkoutUrl;
      } catch (err) {
        // La order no se generó y el cliente va a resolver por WhatsApp:
        // se libera la reserva del cupón (no hay venta real por esta vía).
        // El pedido ya está commiteado, así que sí se marca la fila.
        console.error("MP order falló después de guardar el pedido:", err.message);
        if (couponReserved) await releaseOrderCoupon(db, orderId, couponCode, branch);
        const { status, payload } = mpUnavailablePayload(err, { orderId, orderNumber });
        return res.status(status).json(payload);
      }
      await db
        .prepare("UPDATE orders SET mp_order_id = ?, updated_at = ? WHERE id = ?")
        .run(mpOrderId, now(), orderId);
    }

    res.json({
      ok: true,
      orderId,
      orderNumber,
      demo,
      demoToken: demo ? demoTokenFor(orderId) : "",
      // Con Orders API el cliente va directo al checkout alojado por MP
      // (no hay Brick embebido: la única forma de cobrar con Orders es redirigir).
      checkoutUrl,
      status: isMp ? "pending_payment" : "received",
      total,       // total recalculado server-side (con descuento y envío)
      discount,
      couponCode,
      scheduledFor,
      shipping: { cost: shipping.cost, blocks: shipping.blocks, pending: !!shipping.pending },
    });
  } catch (err) {
    console.error("POST /api/orders:", err.message);
    res.status(500).json({ error: "No se pudo crear el pedido" });
  }
});

// ---------- estado de pago de Mercado Pago (webhook + reconciliación) ----------
// El veredicto lo da la TRANSACCIÓN (transactions.payments[]), no la order: una
// order puede quedar "processed" con la transacción ya devuelta.
function mpOrderPaymentState(mpOrder) {
  const payment = mpOrder.payments[0];
  if (!payment) return "pending";
  if (payment.status === "refunded") return "refunded";
  if (["failed", "canceled", "expired", "charged_back"].includes(payment.status)) return "rejected";
  if (payment.status === "processed") return "approved"; // incluye partially_refunded
  return "pending"; // created | processing | action_required | in_review
}

// Aplica a la BD el estado real de la order de MP. ÚNICA fuente de verdad para
// el estado del pago: la usan tanto el webhook como la reconciliación del
// polling, así una devolución hecha desde el panel de MP (o un contracargo)
// queda reflejada siempre, y nunca se duplica el evento ni se libera dos veces
// el cupón (ambos son idempotentes por el estado previo que se mira).
async function applyMpOrderState(row, mpOrder) {
  const status = mpOrderPaymentState(mpOrder);
  // El estado previo se captura DENTRO del patch, que corre sobre la fila
  // recién leída: si otro request (el panel devolviendo plata, por ejemplo)
  // escribió entre medio, los eventos y la liberación de cupón se deciden
  // sobre lo que hay de verdad, no sobre una lectura vieja.
  let wasApproved = false;
  let wasFailure = false;
  let couponCode = row.coupon_code;

  const res = await applyRefunds(db, row.id, {
    mpRefunds: mpOrder.refunds,
    patch: (pre) => {
      wasApproved = pre.payment_status === "approved";
      wasFailure = pre.payment_status === "rejected";
      couponCode = pre.coupon_code;
      return {
        // No pisar el avance del admin: MP reenvía el webhook varias veces, y
        // si el admin ya avanzó el pedido no se lo vuelve a "received". Solo
        // aprueba la primera vez (pending_payment → received).
        status: status === "approved" && pre.status === "pending_payment" ? "received" : pre.status,
        payment_status: status,
        mp_payment_id: mpOrder.payments[0]?.id || pre.mp_payment_id || null,
      };
    },
  });
  if (!res.ok) {
    console.error(`applyMpOrderState: no se pudo aplicar al pedido ${row.id} (${res.reason})`);
    return status;
  }
  const orderStatus = res.row.status;

  console.log(
    `Pedido ${row.order_number} (order ${mpOrder.id}) → payment=${status} status=${orderStatus}`
  );
  if (status === "approved" && !wasApproved) await recordEvent("order_created", row.branch);
  // Si el pago terminó mal se libera el cupón: sin eso el cupo queda quemado
  // por un pedido que no se cobró. Si en cambio se DEVOLVIÓ, el pedido se
  // pagó de verdad, así que el cupón se considera consumido.
  if (status === "rejected" && !wasFailure && couponCode) {
    await releaseOrderCoupon(db, row.id, couponCode, row.branch);
  }
  return status;
}

// ---------- reconciliación durante el polling ----------
// El webhook es el camino normal, pero es un solo punto de falla: si el secret
// está mal configurado, si la URL no responde o si el cliente cerró la
// pestaña, el pago aprobado NUNCA se refleja y el pedido queda en "pendiente"
// para siempre (el polling del front solo lee la BD).
//
// Por eso el polling del propio cliente reconcilia contra la API de MP. Con
// topes para no castigar al proveedor:
//   - por pedido: 1 consulta cada 20 s (el poll del front es cada 2,5 s)
//   - global: 1 consulta cada 2 s, así muchos pedidos pendientes a la vez no
//    generan una ráfaga contra MP
//   - solo si el pedido tiene mp_order_id, sigue "pending" y ya tiene 10 s
//     de vida (para darle tiempo al webhook de actuar primero)
const RECONCILE_COOLDOWN_MS = 20 * 1000;
const RECONCILE_GLOBAL_MS = 2 * 1000;
const RECONCILE_MIN_AGE_MS = 10 * 1000;
const reconciledAt = new Map(); // id pedido → ts de la última consulta a MP
let lastReconcileAt = 0;

function shouldReconcile(row) {
  if (isDemoMode() || mpAuthBroken) return false;
  if (row.payment_method !== "mercadopago") return false;
  if (!row.mp_order_id) return false;
  if (row.payment_status !== "pending") return false;
  const t = Date.now();
  if (t - new Date(row.created_at).getTime() < RECONCILE_MIN_AGE_MS) return false;
  if (t - (reconciledAt.get(row.id) || 0) < RECONCILE_COOLDOWN_MS) return false;
  if (t - lastReconcileAt < RECONCILE_GLOBAL_MS) return false;
  return true;
}

// Nunca lanza: si MP falla, el poll sigue devolviendo el estado que ya
// conocemos (un fallo acá no puede volver 500 el tracking del cliente).
async function reconcilePendingOrder(row) {
  reconciledAt.set(row.id, Date.now());
  lastReconcileAt = Date.now();
  try {
    return await applyMpOrderState(row, await getOrder(row.mp_order_id));
  } catch (err) {
    if (err instanceof MpError && err.isAuthError) mpAuthBroken = true;
    console.warn(`Reconciliación MP del pedido ${row.order_number} falló: ${err.message}`);
    return null;
  }
}

// Poda del registro de reconciliación (mismo criterio que el resto de los Maps
// en memoria: se limpian las entradas viejas para que no crezca sin límite).
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of reconciledAt) if (t - v > 5 * 60 * 1000) reconciledAt.delete(k);
}, 15 * 60 * 1000).unref();

// Devuelve el pedido ya reconciliado con MP cuando corresponde (o la fila tal
// cual). El 304 se evalúa DESPUÉS, sobre la fila actualizada: si se evaluara
// antes, el cliente con `updatedAt` cacheado nunca vería el cambio de estado.
async function loadPublicOrder(row) {
  let current = row;
  if (shouldReconcile(row)) {
    const status = await reconcilePendingOrder(row);
    if (status) current = await db.prepare("SELECT * FROM orders WHERE id = ?").get(row.id);
  }
  return current;
}

// Reintento del link de pago para un pedido que ya se guardó pero que quedó
// sin order de MP (falló la generación del link). Evita que el cliente tenga
// que reenviar el checkout entero y de paso crear un pedido duplicado.
app.post(
  "/api/orders/:id/payment-link",
  rateLimit({ max: 10, windowMs: 5 * 60 * 1000, name: "paylink" }),
  async (req, res) => {
    try {
      const id = paramId(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
      const row = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
      if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
      if (row.payment_method !== "mercadopago") {
        return res.status(400).json({ code: "not_mp", error: "Este pedido no se paga con Mercado Pago" });
      }
      // Solo pedidos a medio pagar, sin link, y recientes: cualquier otra cosa
      // no es un reintento (o ya tiene link, o el pago se resolvió, o es tan
      // viejo que ya no tiene sentido cobrarlo online).
      if (row.payment_status !== "pending" || row.status !== "pending_payment") {
        return res.status(409).json({ code: "not_retryable", error: "Este pedido ya no está pendiente de pago" });
      }
      if (row.mp_order_id) {
        return res.status(409).json({ code: "not_retryable", error: "Este pedido ya tiene un link de pago" });
      }
      if (Date.now() - new Date(row.created_at).getTime() > 24 * 3600 * 1000) {
        return res.status(409).json({ code: "not_retryable", error: "Pedido muy antiguo para generar un link de pago" });
      }
      if (isDemoMode()) {
        return res.status(409).json({ code: "not_retryable", error: "El link de pago solo existe fuera del modo demo" });
      }

      let mpOrder;
      // Los items guardados en la fila son los mismos cleanItems que validó
      // el checkout (JSON), así que el reintento manda los mismos ítems reales
      // que el flujo original: descuento de la fila (row.discount) y envío
      // (row.shipping) incluidos.
      let cartItems = [];
      try {
        cartItems = JSON.parse(row.items || "[]");
      } catch {
        cartItems = [];
      }
      try {
        mpOrder = await createMpOrderForOrder({
          orderNumber: row.order_number,
          total: row.total,
          description: `${cartItems.length} items · ${row.branch}`,
          base: requestBaseUrl(req),
          // El email y el nombre separado se guardan en la fila al crear el
          // pedido, así que el reintento manda lo mismo que el flujo original.
          // La identificación NO se persiste (dato sensible): el reintento
          // la manda sin ella — limitación conocida, ver el reporte.
          payer: {
            ...(row.customer_email ? { email: row.customer_email } : {}),
            ...(row.customer_first_name ? { firstName: row.customer_first_name } : {}),
            ...(row.customer_last_name ? { lastName: row.customer_last_name } : {}),
          },
          additionalInfo: { registrationDate: await registrationDateFor(row.customer_phone) },
          mpItems: mpItemsForCart({
            orderNumber: row.order_number,
            cartItems,
            total: row.total,
            discount: row.discount,
            shippingCost: row.shipping,
          }),
        });
      } catch (err) {
        if (err instanceof MpError && err.isAuthError) mpAuthBroken = true;
        console.error("MP payment-link falló:", err.message);
        // Mismo contrato que la creación del pedido: el cliente ya tiene el
        // número de pedido, así que puede caer a WhatsApp o reintentar.
        const { status, payload } = mpUnavailablePayload(err, {
          orderId: row.id,
          orderNumber: row.order_number,
        });
        return res.status(status).json(payload);
      }

      await db
        .prepare("UPDATE orders SET mp_order_id = ?, updated_at = ? WHERE id = ?")
        .run(mpOrder.id, now(), row.id);
      res.json({ ok: true, orderId: row.id, orderNumber: row.order_number, checkoutUrl: mpOrder.checkoutUrl });
    } catch (err) {
      console.error("POST /api/orders/:id/payment-link:", err.message);
      res.status(500).json({ error: "No se pudo generar el link de pago" });
    }
  }
);

// Devuelve true si el cliente ya conoce la última versión del pedido
// (If-Modified-Since). Permite responder 304 sin serializar el pedido en
// cada poll de tracking.
function isNotModified(req, row) {
  const ims = req.get("If-Modified-Since");
  if (!ims || !row || !row.updated_at) return false;
  const client = new Date(ims).getTime();
  if (isNaN(client)) return false;
  return new Date(row.updated_at).getTime() <= client;
}

// Estado público de un pedido (por id) — usado para el polling del pago.
// El polling de PaymentModal hace 1 request/2.5s por pestaña (≈24/min): 120/min
// deja margen sin abrir el endpoint a spam.
app.get("/api/orders/:id", rateLimit({ max: 120, windowMs: 60000, name: "orderget" }), async (req, res) => {
  try {
    const id = paramId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
    const current = await loadPublicOrder(row);
    if (isNotModified(req, current)) return res.status(304).end();
    res.json(toPublicOrderPublic(current));
  } catch (err) {
    console.error("GET /api/orders/:id:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// Tracking del cliente por número de pedido (FW-00001)
app.get("/api/orders/number/:orderNumber", rateLimit({ max: 120, windowMs: 60000, name: "ordernum" }), async (req, res) => {
  try {
    const num = String(req.params.orderNumber || "").trim().toUpperCase();
    if (!/^FW-\d{4,10}$/.test(num)) return res.status(400).json({ error: "Número de pedido inválido" });
    const row = await db.prepare("SELECT * FROM orders WHERE order_number = ?").get(num);
    if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
    const current = await loadPublicOrder(row);
    if (isNotModified(req, current)) return res.status(304).end();
    res.json(toPublicOrderPublic(current));
  } catch (err) {
    console.error("GET /api/orders/number/:orderNumber:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// "Mis pedidos": lista los pedidos de un cliente por su teléfono.
// Solo se devuelven datos mínimos (sin exponer pedidos de otras personas).
// Sin verificación de propiedad no es por sí solo seguro: el formato del
// teléfono se valida igual que el front y se agrega un límite estricto por
// teléfono+IP (además del general por IP) para dificultar el barrido de
// números. Una verificación completa requeriría OTP por SMS/WhatsApp.
app.get(
  "/api/orders/by-phone/:phone",
  rateLimit({ max: 15, name: "byphone" }),
  rateLimitByKey(
    (req) => `${String(req.params.phone || "").trim()}:${getClientIp(req)}`,
    { max: 8, windowMs: 10 * 60 * 1000, name: "byphonepk" }
  ),
  async (req, res) => {
    try {
      const phone = String(req.params.phone || "").trim();
      if (!isValidPhone(phone)) return res.status(400).json({ error: "Teléfono inválido" });
      // Se busca el número ya normalizado (solo dígitos), igual que se
      // almacena al crear el pedido: así coincide sin importar el formato
      // (espacios, guiones, paréntesis, +).
      const searchPhone = phone.replace(/\D/g, "");
    const rows = await db
      .prepare(
        "SELECT * FROM orders WHERE customer_phone = ? ORDER BY created_at DESC LIMIT 50"
      )
      .all(searchPhone);
    res.json({
      orders: rows.map((row) => ({
        id: row.id,
        orderNumber: row.order_number,
        branch: row.branch,
        status: row.status,
        paymentStatus: row.payment_status,
        total: row.total,
        createdAt: row.created_at,
      })),
    });
  } catch (err) {
    console.error("GET /api/orders/by-phone/:phone:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- eventos (analytics, sin datos personales) ----------
const EVENT_TYPES = [
  "page_view",
  "product_view",
  "checkout_started",
  "order_created",
];

app.post("/api/events", rateLimit({ max: 60, name: "events" }), async (req, res) => {
  try {
    const { type, branch, visitor_id } = req.body || {};
    if (!EVENT_TYPES.includes(type)) {
      return res.status(400).json({ error: "Tipo de evento inválido" });
    }
    const cleanBranch = typeof branch === "string" && CATALOG[branch] ? branch : "";
    // ID anónimo de visitante (uuid/dash/underscore) para contar personas
    const cleanVisitor =
      typeof visitor_id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(visitor_id)
        ? visitor_id
        : null;
    await db.prepare("INSERT INTO events (type, branch, created_at, visitor_id) VALUES (?, ?, ?, ?)").run(
      type,
      cleanBranch,
      now(),
      cleanVisitor
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/events:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- menú público (fuente: BD) ----------
// Health check liviano (para keep-alive externo y para el health check de
// Render). No toca la DB ni dispara analytics.
app.get("/api/health", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  // No se expone el modo demo hacia afuera (info disclosure para cualquiera
  // que consulte el endpoint sin autenticación).
  res.json({ ok: true, time: now() });
});

app.get("/api/menu/:branchId", rateLimit({ max: 120, name: "menu" }), async (req, res) => {
  try {
    const branchId = String(req.params.branchId || "").trim();
    const menu = await getMenuFromDb(branchId);
    if (!menu.categories.length) return res.status(404).json({ error: "Sucursal no encontrada" });
    res.json(menu);
  } catch (err) {
    console.error("GET /api/menu/:branchId:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- cupones (cliente) ----------
// Valida un código y devuelve el descuento sobre un total dado.
// La validación definitiva se hace server-side al crear el pedido.
// `branch` (la sucursal del pedido, la manda el checkout) es opcional:
// con ella, un cupón local de la OTRA sucursal no valida acá.
app.post("/api/coupons/validate", rateLimit({ max: 30, name: "couponvalidate" }), async (req, res) => {
  try {
    const { code, total, branch } = req.body || {};
    const n = Number(total);
    if (typeof code !== "string" || !code.trim() || !Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: "Datos inválidos" });
    }
    if (branch && !CATALOG[branch]) return res.status(400).json({ error: "Sucursal inválida" });
    const result = await applyCoupon(db, code, n, branch || "");
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ ok: true, code: result.code, discount: result.discount, totalAfter: Math.max(n - result.discount, 0) });
  } catch (err) {
    console.error("POST /api/coupons/validate:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- envío (cliente) ----------
// Calcula el costo de envío para una dirección. Solo Tandil por ahora:
// Necochea responde supported:false (sin costo calculado).
app.post("/api/shipping/quote", rateLimit({ max: 30, windowMs: 60000, name: "shipping" }), async (req, res) => {
  try {
    const { branch, address } = req.body || {};
    if (typeof branch !== "string" || !branch) return res.status(400).json({ error: "Falta la sucursal" });
    if (typeof address !== "string" || !address.trim()) return res.status(400).json({ error: "Falta la dirección" });
    const s = await computeShipping(branch, address);
    if (!s.supported) return res.json({ ok: true, blocks: 0, cost: 0, supported: false });
    res.json({ ok: true, blocks: s.blocks, cost: s.cost, supported: true });
  } catch (err) {
    console.error("POST /api/shipping/quote:", err.message);
    // transitorio (429 / servicio caído) → 503 para que el cliente reintente
    res.status(err.code === "transient" ? 503 : 400).json({ error: err.message });
  }
});

// ---------- webhook Mercado Pago ----------
// mpOrderPaymentState, mergeRefunds y applyMpOrderState están definidos más
// arriba: los usa también la reconciliación del polling (misma fuente de verdad
// para el estado del pago).
app.post("/api/webhooks/mercadopago", async (req, res) => {
  try {
    const { type, data } = req.body || {};
    console.log("Webhook recibido:", JSON.stringify({ type, id: data?.id }));

    // Sin MP_WEBHOOK_SECRET configurado la firma no es verificable:
    // verifyWebhookSignature devuelve false y el webhook se rechaza con 400
    // (Mercado Pago reintentará; el flujo demo no usa webhooks, se simula).
    if (!verifyWebhookSignature(req)) {
      console.warn("Webhook rechazado: firma inválida o MP_WEBHOOK_SECRET sin configurar");
      return res.status(400).json({ error: "Firma inválida" });
    }

    // ---- Payload que no sabemos procesar: no-op con 200 ----
    // Los tipos que MP emite son "order" (Orders API, la integración actual) y
    // "payment" (Preferences API, histórica). Cualquier otro, o un id ausente,
    // no se va a volver válido reintentando, así que se acusa recibo con 200 en
    // vez de devolver 500 y hacer que MP insista. Ojo: el id de Orders API no
    // es numérico (es tipo "01J…"), así que un id numérico casi seguro es una
    // simulación del botón "Probar" del panel de MP.
    if ((type !== "order" && type !== "payment") || !data?.id) {
      console.warn(`Webhook ignorado (tipo o id desconocido): type=${type ?? "?"} id=${data?.id ?? "?"}`);
      return res.sendStatus(200);
    }

    // ---- Orders API (integración actual) ----
    if (type === "order" && data?.id) {
      const mpOrderId = String(data.id);
      // El estado se lee SIEMPRE de la API y no del cuerpo de la notificación:
      // así una devolución hecha desde el panel de MP (o un contracargo) queda
      // reflejada aunque la notificación no traiga el detalle completo.
      const mpOrder = await getOrder(mpOrderId);
      let row = await db.prepare("SELECT * FROM orders WHERE mp_order_id = ?").get(mpOrderId);
      if (!row && mpOrder.externalReference) {
        row = await db
          .prepare("SELECT * FROM orders WHERE order_number = ?")
          .get(String(mpOrder.externalReference).toUpperCase());
      }
      if (!row) {
        console.warn("Webhook de order sin pedido local:", mpOrderId);
        return res.sendStatus(200);
      }
      await applyMpOrderState(row, mpOrder);
      return res.sendStatus(200);
    }

    // ---- Preferences API (pedidos abiertos antes de migrar a Orders) ----
    if (type === "payment" && data?.id) {
      const paymentId = String(data.id);
      const payment = await getPayment(paymentId);
      if (payment.external_reference) {
        const row = await db
          .prepare("SELECT * FROM orders WHERE order_number = ?")
          .get(payment.external_reference.toUpperCase());
        if (row) {
          // Mapeo del estado del pago de MP a nuestros estados (approved/pending/
          // rejected/refunded): cancelled/charged_back quedan como "rejected" para
          // que no sigan contando como cobradas y no rompan etiquetas/filtros.
          const status =
            payment.status === "approved"
              ? "approved"
              : payment.status === "refunded"
                ? "refunded"
                : ["rejected", "cancelled", "charged_back"].includes(payment.status)
                  ? "rejected"
                  : row.payment_status;
          const orderStatus =
            payment.status === "approved" && row.status === "pending_payment" ? "received" : row.status;

          const wasApproved = row.payment_status === "approved";
          const wasFailure = row.payment_status === "rejected";
          await db.prepare(
            "UPDATE orders SET payment_status = ?, status = ?, mp_payment_id = ?, updated_at = ? WHERE id = ?"
          ).run(status, orderStatus, paymentId, now(), row.id);
          console.log(
            `Pedido ${row.order_number} actualizado → payment=${status} status=${orderStatus}`
          );
          if (status === "approved" && !wasApproved) await recordEvent("order_created", row.branch);
          if (status === "rejected" && !wasFailure && row.coupon_code) {
            await releaseOrderCoupon(db, row.id, row.coupon_code, row.branch);
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    // Un MpError no retryable (400/404/422) es una respuesta definitiva de MP:
    // el id no existe o la operación está mal. El caso real es el botón "Probar"
    // del panel de MP, que manda {"type":"order","data":{"id":"123456"}} y MP
    // contesta 400 "path param order id is invalid" porque una order válida no
    // tiene id numérico. Reintentar eso nunca va a funcionar, así que 500 solo
    // hacía que MP lo marcara fallido e insistiera. Se acusa recibo con 200:
    // no había nada que actualizar. mpFetch ya clasifica estos casos
    // (retryable=false), igual que el resto del server, así que acá se respeta.
    if (err instanceof MpError && !err.retryable) {
      console.warn(
        `Webhook de MP con error definitivo (${err.status}): ${err.message}`
      );
      return res.sendStatus(200);
    }

    console.error("Webhook error:", err.message);
    // 500 para que Mercado Pago reintente (lo hace unas pocas veces con backoff):
    // si devolviéramos 200 la notificación se pierde y el pedido queda sin actualizar.
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- demo (solo activo en modo demo) ----------
// Clave HMAC efímera por proceso: el demoToken se entrega exclusivamente en la
// respuesta de creación del pedido, de modo que solo el navegador que lo creó
// puede simular su pago. Sin el token no se pueden aprobar pedidos ajenos.
const DEMO_HMAC_KEY = randomBytes(32);
function demoTokenFor(orderId) {
  return createHmac("sha256", DEMO_HMAC_KEY).update(String(orderId)).digest("hex");
}

if (isDemoMode()) {
  app.post(
    "/api/payments/demo/:id/:action",
    rateLimit({ max: 30, windowMs: 60000, name: "demopay" }),
    async (req, res) => {
      try {
        const id = paramId(req.params.id);
        const action = req.params.action; // "approve" | "reject"
        if (!Number.isInteger(id) || id <= 0 || !["approve", "reject"].includes(action)) {
          return res.status(400).json({ error: "Solicitud inválida" });
        }
        // Autorización: el pedido solo puede simularse con su demoToken (HMAC
        // del id). Cualquier otro request → 403.
        const demoToken = String((req.body && req.body.demoToken) || "");
        if (!demoToken || !safeEqual(demoToken, demoTokenFor(id))) {
          return res.status(403).json({ error: "No autorizado" });
        }
        const row = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
        if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
        const approved = action === "approve";
        const wasApproved = row.payment_status === "approved";
        const wasFailure = row.payment_status === "rejected";
        await db.prepare(
          "UPDATE orders SET payment_status = ?, status = ?, updated_at = ? WHERE id = ?"
        ).run(approved ? "approved" : "rejected", approved ? "received" : row.status, now(), id);
        if (approved && !wasApproved) await recordEvent("order_created", row.branch);
        // Rechazo simulado: devuelve el uso del cupón igual que el webhook.
        if (!approved && !wasFailure && row.coupon_code) {
          await releaseOrderCoupon(db, row.id, row.coupon_code, row.branch);
        }
        res.json({ ok: true, orderId: id, paymentStatus: approved ? "approved" : "rejected" });
      } catch (err) {
        console.error("POST /api/payments/demo/:id/:action:", err.message);
        res.status(500).json({ error: "Error interno" });
      }
    }
  );
}

// ---------- admin ----------
// safeEqual (comparación en tiempo constante para credenciales) vive en
// server/auth.js: la comparten el login, el middleware CSRF y el token
// del modo demo. Importada arriba junto a authenticateAdmin.

app.post(
  "/api/admin/login",
  progressiveLoginLimit,
  rateLimit({ max: 5, windowMs: 60000, name: "adminlogin" }),
  async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (typeof username !== "string" || typeof password !== "string") {
        return res.status(400).json({ error: "Faltan credenciales" });
      }
      // El superadmin del .env o una cuenta de sucursal de admin_users.
      // authenticateAdmin devuelve exactamente lo mismo para todo fallo:
      // no se enumeran usuarios ni se distingue una cuenta desactivada.
      const admin = await authenticateAdmin(db, {
        username,
        password,
        envUser: ADMIN_USER,
        envPassword: ADMIN_PASSWORD,
      });
      if (!admin.ok) {
        recordLoginFailure(req);
        return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
      }
      recordLoginSuccess(req);
      // Higiene: purga sesiones vencidas para que la tabla no crezca sin límite
      try {
        const cutoff = new Date(Date.now() - TOKEN_TTL_MS).toISOString();
        await db.prepare("DELETE FROM admin_tokens WHERE created_at < ?").run(cutoff);
      } catch (purgeErr) {
        console.error("purga admin_tokens:", purgeErr.message);
      }
      const token = randomBytes(32).toString("hex");
      // El token nace atado a quién inició sesión: superadmin
      // (admin_user_id NULL) o la cuenta de sucursal con su rol y branch.
      await db
        .prepare(
          "INSERT INTO admin_tokens (token, created_at, admin_user_id, role, branch) VALUES (?, ?, ?, ?, ?)"
        )
        .run(token, now(), admin.userId, admin.role, admin.branch);
      // Cookie httpOnly: el token nunca queda en localStorage ni en JS.
      // secure en producción/HTTPS/MP real: nunca viaja por HTTP plano.
      res.cookie("fw_admin_token", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: isSecureRequest(req),
        maxAge: TOKEN_TTL_MS,
        path: "/",
      });
      // Token CSRF de doble cookie (NO httpOnly: el front lo lee y lo manda como
      // header X-CSRF-Token). Un sitio ajeno no puede leerlo (same-origin policy).
      res.cookie("fw_admin_csrf", randomBytes(32).toString("hex"), {
        httpOnly: false,
        sameSite: "lax",
        secure: isSecureRequest(req),
        maxAge: TOKEN_TTL_MS,
        path: "/",
      });
      // El token NO se devuelve en el body: solo vive en la cookie httpOnly
      res.json({ ok: true });
    } catch (err) {
      console.error("POST /api/admin/login:", err.message);
      res.status(500).json({ error: "Error al iniciar sesión" });
    }
  }
);

app.post("/api/admin/logout", requireAdmin, async (req, res) => {
  try {
    const token = getAdminToken(req);
    await db.prepare("DELETE FROM admin_tokens WHERE token = ?").run(token);
    res.clearCookie("fw_admin_token", { path: "/" });
    res.clearCookie("fw_admin_csrf", { path: "/" });
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/admin/logout:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// Revoca TODAS las sesiones del panel (máquinas, pestañas, tokens robados):
// borra todos los tokens vivos. La sesión actual también queda invalidada.
// Solo el superadmin: un admin de sucursal no puede tirar abajo las
// sesiones del dueño ni las de la otra sucursal.
app.post("/api/admin/logout-all", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    await db.prepare("DELETE FROM admin_tokens").run();
    res.clearCookie("fw_admin_token", { path: "/" });
    res.clearCookie("fw_admin_csrf", { path: "/" });
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/admin/logout-all:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// Valida la sesión del panel (cookie o header) sin exponer el token.
// Devuelve además el rol y la sucursal: el frontend los usa para
// mostrar (o no) las secciones del panel, aunque la separación real
// se aplica en cada endpoint del backend.
app.get("/api/admin/me", requireAdmin, (req, res) => {
  // user: el del .env para el superadmin; el de la tabla para admins
  // de sucursal (resolveAdminFromToken deja username null para el
  // superadmin porque auth.js no conoce el .env).
  res.json({
    ok: true,
    user: req.admin.username || ADMIN_USER,
    role: req.admin.role,
    branch: req.admin.branch,
  });
});

// Scope de la sesión para TODA la Etapa B: el branch_admin solo ve
// su sucursal; el superadmin ve todo (null). Sale de req.admin,
// que a su vez salió del token — nunca del query ni del body.
function adminScope(req) {
  return req.admin?.role === "branch_admin" ? req.admin.branch : null;
}

// Listado de pedidos para el admin (con filtros, búsqueda y paginación)
app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const { search, status, payment, includePending } = req.query;
    const scope = adminScope(req);
    // El ?branch= del query es el filtro del panel del superadmin;
    // para el branch_admin se ignora (listOrders no lo recibe).
    const { rows, total, page, limit, hasMore } = await listOrders(db, {
      scope,
      branch: scope ? undefined : req.query.branch,
      search,
      status,
      payment,
      includePending,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({
      orders: rows.map(toPublicOrder),
      total,
      page,
      limit,
      hasMore,
    });
  } catch (err) {
    console.error("GET /api/admin/orders:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.get("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    // Pedido ajeno → 404 (no 403): no se confirma que exista.
    const row = await getOrderScoped(db, id, adminScope(req));
    if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
    res.json({ ...toPublicOrder(row), whatsappLink: orderWhatsAppLink(row, row.status) });
  } catch (err) {
    console.error("GET /api/admin/orders/:id:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// Cambio de estado del pedido
// Estados válidos:
//   received → Pedido recibido
//   preparing → En elaboración
//   ready → Listo
//   out_for_delivery → En camino
//   completed → Entregado
//   cancelled → Cancelado
const ALLOWED_STATUSES = [
  "received",
  "preparing",
  "ready",
  "out_for_delivery",
  "completed",
  "cancelled",
];

const ORDER_STATUS_LABELS = {
  received: "Pedido recibido",
  preparing: "En elaboración",
  ready: "Listo",
  out_for_delivery: "En camino",
  completed: "Entregado",
  cancelled: "Cancelado",
};

// Link wa.me para avisar al cliente del cambio de estado (sin datos sensibles)
function orderWhatsAppLink(row, status) {
  const phone = String(row.customer_phone || "").replace(/^0+/, "");
  if (!phone) return "";
  const branchLabel = row.branch === "tandil" ? "Tandil" : "Necochea";
  const label = ORDER_STATUS_LABELS[status] || status;
  const message =
    `Hola ${row.customer_name}! Tu pedido *${row.order_number}* (Fusión Wok ${branchLabel}) ` +
    `ahora está: *${label}*. ¡Gracias por elegirnos! 🍜`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

app.patch("/api/admin/orders/:id/status", requireAdmin, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Estado inválido" });
    }
    const id = paramId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    // Pedido ajeno → 404: el branch_admin no puede cambiar el estado
    // del de la otra sucursal.
    const row = await getOrderScoped(db, id, adminScope(req));
    if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
    // Cancelar desde el panel también devuelve el uso del cupón (como el
    // webhook en rejected): sin esto, un pedido cancelado quemaba el cupo
    // hasta el sweep diferido de 30 min. releaseOrderCoupon es idempotente
    // por pedido (marca coupon_released_at), así que el webhook, el sweep y
    // esta ruta pueden coincidir sin que el contador baje de más.
    if (status === "cancelled" && row.status !== "cancelled" && row.coupon_code) {
      await releaseOrderCoupon(db, row.id, row.coupon_code, row.branch);
    }
    await db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
    const updated = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    res.json({
      ok: true,
      order: toPublicOrder(updated),
      whatsappLink: orderWhatsAppLink(row, status),
    });
  } catch (err) {
    console.error("PATCH /api/admin/orders/:id/status:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// Fija el costo de envío de un pedido que quedó "pendiente" de cotización
// (fallo transitorio en el cálculo: se confirmó por WhatsApp antes de salir).
// Ajusta total, shipping y cuadras, y limpia el flag de pendiente para que el
// ticket, el arqueo de caja y las estadísticas reflejen el costo real.
app.post("/api/admin/orders/:id/shipping", requireAdmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const { cost, blocks } = req.body || {};
    const shipping = Math.round(Number(cost));
    const km = Math.round(Number(blocks));
    if (!Number.isFinite(shipping) || shipping < 0) {
      return res.status(400).json({ error: "Costo de envío inválido" });
    }
    if (!Number.isFinite(km) || km < 0) return res.status(400).json({ error: "Cuadras inválidas" });
    // Pedido ajeno → 404: el branch_admin no puede fijar el envío
    // del de la otra sucursal.
    const row = await getOrderScoped(db, id, adminScope(req));
    if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
    const oldShipping = Number(row.shipping) || 0;
    const delta = shipping - oldShipping;
    const newTotal = Math.max(0, Number(row.total) + delta);
    await db.prepare(
      "UPDATE orders SET shipping = ?, shipping_km = ?, shipping_pending = 0, total = ?, updated_at = ? WHERE id = ?"
    ).run(shipping, km, newTotal, now(), id);
    const updated = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    res.json({ ok: true, order: toPublicOrder(updated) });
  } catch (err) {
    console.error("POST /api/admin/orders/:id/shipping:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// Devuelve dinero de un pedido pagado con Mercado Pago (Orders API).
// Sin `amount` devuelve todo lo que quede; con `amount`, una parte (debe
// indicar la transacción a devolver). Idempotente en la practice: el monto se
// valida contra lo ya devuelto, así un doble clic no puede devolver de más.
app.post("/api/admin/orders/:id/refund", requireAdmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    // Pedido ajeno → 404: solo cambia la carga de la fila, el flujo
    // de devolución de MP queda exactamente igual.
    const row = await getOrderScoped(db, id, adminScope(req));
    if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
    if (row.payment_method !== "mercadopago") {
      return res.status(400).json({ error: "Este pedido no se pagó con Mercado Pago" });
    }
    // Solo pagos aprobados. Un pedido ya devuelto ("refunded") no se vuelve a
    // tocar: refunded_amount puede no reflejar lo que devolvió MP en pedidos
    // viejos, y la app no tiene cómo saberlo → que lo resuelva MP.
    if (row.payment_status !== "approved") {
      return res.status(400).json({ error: "Solo se puede devolver dinero de un pedido pagado" });
    }

    const refundable = refundableAmount(row);
    if (refundable <= 0) {
      return res.status(400).json({ error: "Este pedido ya fue devuelto por completo" });
    }

    // amount opcional: sin él, devolución total de lo que queda.
    const raw = (req.body || {}).amount;
    const amount = raw === undefined || raw === null || raw === "" ? refundable : Math.round(Number(raw));
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Monto a devolver inválido" });
    }
    if (amount > refundable) {
      return res.status(400).json({ error: `El monto supera lo que queda (${refundable})` });
    }
    const isFull = amount === refundable;

    // Deja el pedido en "refunded" solo cuando ya no queda nada por devolver.
    // Se decide adentro del patch, sobre la fila recién leída: si una devolución
    // concurrente ya completó el total, no lo volvemos a "approved".
    const markIfFullyRefunded = (pre, { refundedAmount: devuelto }) => ({
      payment_status: devuelto >= (pre.total || 0) ? "refunded" : pre.payment_status,
    });

    // Demo: sin credenciales no hay a quién devolverle, pero el flujo del panel
    // tiene que poder probarse igual. Se anota la devolución y se responde.
    if (isDemoMode()) {
      await applyRefunds(db, id, {
        mpRefunds: [{ id: `demo-${randomBytes(6).toString("hex")}`, amount }],
        patch: markIfFullyRefunded,
      });
      const updated = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
      return res.json({ ok: true, demo: true, order: toPublicOrder(updated) });
    }

    if (!row.mp_order_id) {
      return res.status(400).json({ error: "El pedido no tiene order de Mercado Pago" });
    }

    // Devolución parcial: MP exige el id de la transacción. Normalmente ya está
    // guardado (lo setea el webhook); si falta, se busca en la order.
    let transactionId = row.mp_payment_id;
    if (!isFull && !transactionId) {
      const mpOrder = await getOrder(row.mp_order_id);
      transactionId = mpOrder.payments.find((p) => p.id)?.id || null;
      if (!transactionId) {
        return res.status(409).json({ error: "Mercado Pago todavía no registró el pago" });
      }
    }

    let result;
    try {
      // Si el arranque ya detectó que el token no sirve, se corta acá: el
      // admin ve el error al instante en vez de esperar 15s a un timeout.
      if (mpAuthBroken) throw mpAuthError();
      // La clave identifica ESTA devolución: si el admin clica dos veces, la
      // segunda llega con el mismo `refundedAmount` previo y MP la deduplica
      // en vez de devolver dos veces. Dos devoluciones del mismo monto en
      // momentos distintos cambian el monto previo → claves distintas → se
      // ejecutan de verdad.
      const idempotencyKey = `ref-${row.id}-${row.refunded_amount || 0}-${amount}-${isFull ? "full" : "partial"}`;
      result = await refundOrder(
        row.mp_order_id,
        isFull ? { idempotencyKey } : { transactionId, amount, idempotencyKey }
      );
    } catch (err) {
      // Si el token fue rechazado se marca: el resto de los pedidos con MP
      // fallan igual y no tiene sentido seguir golpeando la API.
      if (err instanceof MpError && err.isAuthError) mpAuthBroken = true;
      console.error("MP refund falló:", err.message);
      // El mensaje crudo de MP ("At least one policy returned UNAUTHORIZED")
      // no le dice nada al admin: se traduce a la causa real. Antes además
      // siempre respondía 502, incluso cuando el problema eran las credenciales.
      const auth = err instanceof MpError && err.isAuthError;
      res.status(auth ? 503 : 502).json({
        code: auth ? "mp_unauthorized" : "mp_refund_failed",
        retryable: !(err instanceof MpError) || err.retryable,
        error: auth
          ? "No se pudo devolver el dinero: las credenciales de Mercado Pago están rechazadas. " +
            "Revisá el MP_ACCESS_TOKEN y reintentá."
          : `Mercado Pago rechazó la devolución: ${err.message}`,
      });
      // Sin este return la ejecución seguía con `result` sin asignar (la
      // llamada a MP falló): `result.refunds` reventaba, el catch externo
      // intentaba responder OTRA vez y el admin recibía un 500 por
      // ERR_HTTP_HEADERS_SENT en vez de este mensaje.
      return;
    }

    // Red de seguridad: si MP respondió sin el detalle del reembolso, se anota
    // uno local para que el historial del panel no quede vacío.
    const reportadas = result.refunds || [];
    const mpRefunds = reportadas.some((r) => (r.amount || 0) === amount)
      ? reportadas
      : [...reportadas, { id: result.id || `mp-${Date.now()}`, amount, at: now() }];
    await applyRefunds(db, row.id, { mpRefunds, patch: markIfFullyRefunded });

    const updated = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    res.json({ ok: true, order: toPublicOrder(updated) });
  } catch (err) {
    console.error("POST /api/admin/orders/:id/refund:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- estadísticas (panel admin) ----------
// "Venta neta" = total de pedidos confirmados/pagados (payment_status approved
// y status distinto de cancelled), evitando cancelados y pagos rechazados.
function safeIso(value, fallback) {
  if (!value) return fallback;
  const d = new Date(value);
  return isNaN(d.getTime()) ? fallback : d.toISOString();
}

app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    const defaultFrom = new Date(Date.now() - 30 * 86400000).toISOString();
    const fromIso = safeIso(from, defaultFrom);
    const toIso = safeIso(to, now());
    // El shape depende del scope: superadmin recibe el consolidado +
    // desglose por local + analytics; branch_admin solo SU venta
    // (ver getStats en admin-queries.js).
    res.json(await getStats(db, { fromIso, toIso, scope: adminScope(req) }));
  } catch (err) {
    console.error("GET /api/admin/stats:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- clientes (agregado por teléfono) ----------
// El gasto total y el historial del cliente salen SOLO de los
// pedidos de la sucursal del admin (decisión 9 del dueño);
// el superadmin conserva su filtro ?branch= del panel.
app.get("/api/admin/customers", requireAdmin, async (req, res) => {
  try {
    const { search } = req.query;
    const scope = adminScope(req);
    const customers = await listCustomers(db, {
      scope,
      branch: scope ? undefined : req.query.branch,
      search,
    });
    res.json({ customers, total: customers.length });
  } catch (err) {
    console.error("GET /api/admin/customers:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- ventas (panel admin: filtro de fecha + medios de pago) ----------
app.get("/api/admin/sales", requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    const defaultFrom = new Date(Date.now() - 30 * 86400000).toISOString();
    const fromIso = safeIso(from, defaultFrom);
    const toIso = safeIso(to, now());
    const scope = adminScope(req);
    // ?branch= es el filtro del panel del superadmin; con scope de
    // branch_admin se ignora (la venta es SIEMPRE la de su sucursal).
    res.json(await getSalesReport(db, { fromIso, toIso, scope, branch: scope ? undefined : req.query.branch }));
  } catch (err) {
    console.error("GET /api/admin/sales:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- arqueo de caja ----------
// Abre una caja con un monto inicial; mientras está abierta se puede
// consultar cuánto ingresó en efectivo; al cerrar se compara lo contado
// físicamente contra lo esperado (apertura + ventas en efectivo del turno).
app.get("/api/admin/cash-register", requireAdmin, async (req, res) => {
  try {
    const scope = adminScope(req);
    // branch_admin → SU caja siempre; superadmin → la que pida.
    const branch = scope || req.query.branch;
    if (!branch) return res.status(400).json({ error: "Falta la sucursal" });
    const { open, history, expectedNow } = await getCashRegisterState(db, scope, req.query.branch);
    res.json({
      open: open ? { ...rowToCashRegister(open), expectedNow } : null,
      history: history.map(rowToCashRegister),
    });
  } catch (err) {
    console.error("GET /api/admin/cash-register:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

function rowToCashRegister(row) {
  return {
    id: row.id,
    branch: row.branch,
    openingAmount: row.opening_amount,
    openedAt: row.opened_at,
    closingCounted: row.closing_counted,
    closedAt: row.closed_at,
    expectedAmount: row.expected_amount,
    difference: row.difference,
    notes: row.notes,
  };
}

app.post("/api/admin/cash-register/open", requireAdmin, async (req, res) => {
  try {
    const scope = adminScope(req);
    // branch_admin abre SIEMPRE en su sucursal (body.branch se ignora);
    // el superadmin mantiene el comportamiento actual.
    const branch = scope || (req.body || {}).branch;
    if (!branch) return res.status(400).json({ error: "Falta la sucursal" });
    const r = await openCashRegister(db, { branch, openingAmount: req.body?.openingAmount, nowIso: now() });
    if (r.error) return res.status(r.status || 400).json({ error: r.error });
    res.json({ ok: true, id: r.id });
  } catch (err) {
    console.error("POST /api/admin/cash-register/open:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.post("/api/admin/cash-register/:id/close", requireAdmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    const { closingCounted, notes } = req.body || {};
    // El scope valida que el arqueo sea de SU sucursal: uno ajeno
    // responde con el mismo 404 que uno inexistente.
    const r = await closeCashRegister(db, id, {
      counted: closingCounted,
      notes,
      scope: adminScope(req),
      nowIso: now(),
    });
    if (r.error) return res.status(r.status || 400).json({ error: r.error });
    res.json({ ok: true, expected: r.expected, difference: r.difference });
  } catch (err) {
    console.error("POST /api/admin/cash-register/:id/close:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- carga manual de pedidos (WhatsApp / mostrador) ----------
app.post("/api/admin/orders/manual", requireAdmin, async (req, res) => {
  try {
    const { source } = req.body || {};
    if (!["whatsapp", "counter"].includes(source)) {
      return res.status(400).json({ error: "Origen inválido" });
    }
    // La sucursal del pedido manual sale de la SESIÓN, no del body:
    // el branch_admin carga SIEMPRE en la suya (body.branch se ignora);
    // el superadmin elige, pero tiene que existir de verdad.
    const branchResult = effectiveBranch(req.admin, req.body?.branch);
    if (branchResult.error) return res.status(400).json({ error: branchResult.error });
    const result = await validateOrderBody({ ...req.body, branch: branchResult.branch });
    if (result.error) return res.status(400).json({ error: result.error });
    const { branch, customer, orderMode, paymentMethod, address, items, notes, total, discount, couponCode, scheduledFor, shipping } = result.data;

    const ts = now();
    // INSERT del pedido + número definitivo (derivado del id real) + evento
    // "order_created" en UN solo batch atómico (sin carrera de MAX(id)+1).
    const tmpNumber = `tmp-${randomBytes(8).toString("hex")}`;
    const results = await db.batch(
      [
        {
          sql: `INSERT INTO orders
          (order_number, branch, customer_name, customer_phone, customer_email, customer_first_name, customer_last_name, address, order_mode,
           payment_method, payment_status, status, items, total, discount, coupon_code,
           scheduled_for, notes, source, shipping, shipping_km, shipping_pending, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            tmpNumber,
            branch,
            customer.name,
            customer.phone,
            customer.email,
            customer.firstName,
            customer.lastName,
            address,
            orderMode,
            paymentMethod,
            JSON.stringify(items),
            total,
            discount,
            couponCode,
            scheduledFor,
            notes,
            source,
            shipping.cost,
            shipping.blocks,
            shipping.pending ? 1 : 0,
            ts,
            ts,
          ],
        },
        {
          // Número definitivo, derivado del id de la fila recién insertada
          sql: "UPDATE orders SET order_number = ? || printf('%05d', id), updated_at = ? WHERE id = last_insert_rowid()",
          args: ["FW-", ts],
        },
        {
          sql: "INSERT INTO events (type, branch, created_at) VALUES (?, ?, ?)",
          args: ["order_created", branch, ts],
        },
      ],
      "write"
    );
    const info = results[0];
    const orderId = Number(info.lastInsertRowid);
    const orderNumber = formatOrderNumber(orderId);
    res.json({ ok: true, orderId, orderNumber });
  } catch (err) {
    console.error("POST /api/admin/orders/manual:", err.message);
    res.status(500).json({ error: "No se pudo crear el pedido" });
  }
});

// ---------- productos (edición de menú desde el panel) ----------
function productRowToAdmin(row) {
  return {
    id: row.id,
    branch: row.branch,
    categoryId: row.category_id,
    categoryName: row.category_name,
    groupName: row.group_name,
    productId: row.product_id,
    name: row.name,
    price: row.price,
    description: row.description,
    image: row.image || "",
    extras: JSON.parse(row.extras_json || "[]"),
    available: row.available === 1,
    sortOrder: row.sort_order,
  };
}

// Listado: agrupado por sucursal y categoría (con grupos), listo para el panel
app.get("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    // listMenuForAdmin aplica el scope (branch_admin → solo SU
    // sucursal); el agrupado para el panel queda acá.
    const rows = await listMenuForAdmin(db, { scope: adminScope(req) });
    // Object.create(null): una branch "__proto__" no puede contaminar el mapa
    const grouped = Object.create(null);
    for (const row of rows) {
      const p = productRowToAdmin(row);
      if (!grouped[p.branch]) {
        grouped[p.branch] = { branchId: p.branch, categories: [], _catIndex: new Map() };
      }
      const g = grouped[p.branch];
      if (!g._catIndex.has(p.categoryId)) {
        // id = slug (se usa para agrupar productos y en el formulario), rowId =
        // id numérico de la tabla categories (se usa para renombrar/mover/eliminar).
        g._catIndex.set(p.categoryId, { id: p.categoryId, rowId: row._catRowId ?? null, name: p.categoryName, groups: [] });
        g.categories.push(g._catIndex.get(p.categoryId));
      }
      const cat = g._catIndex.get(p.categoryId);
      let group = cat.groups.find((x) => x.name === p.groupName);
      if (!group) {
        group = { name: p.groupName || null, products: [] };
        cat.groups.push(group);
      }
      group.products.push(p);
    }
    const result = Object.values(grouped).map(({ branchId, categories }) => ({ branchId, categories }));
    res.json({ branches: result });
  } catch (err) {
    console.error("GET /api/admin/products:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// Valida y normaliza los datos de un producto (crear o editar)
function validateProductBody(body, partial = false) {
  const { name, price, description, categoryId, categoryName, groupName, image, available } = body || {};
  const out = {};
  if (price !== undefined) {
    const n = Number(price);
    if (!Number.isInteger(n) || n < 0 || n > 100000000) return { error: "Precio inválido" };
    out.price = n;
  }
  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120) {
      return { error: "Nombre inválido" };
    }
    out.name = name.trim();
  }
  if (description !== undefined) {
    if (typeof description !== "string" || description.length > 500) return { error: "Descripción inválida" };
    out.description = description.trim();
  }
  if (image !== undefined) {
    if (typeof image !== "string" || image.length > 200) return { error: "Imagen inválida" };
    // Imágenes versionadas del menú (/uploads/products/...) o subidas como
    // BLOB a Turso (/api/images/products/N?v=ts)
    if (
      image &&
      !/^(\/uploads\/products\/[\w.-]+\.(png|jpe?g|webp|gif)|\/api\/images\/products\/\d+\?v=\d+)$/i.test(image)
    ) {
      return { error: "Imagen inválida" };
    }
    out.image = image;
  }
  if (categoryId !== undefined) {
    if (typeof categoryId !== "string" || !categoryId.trim() || categoryId.length > 80) {
      return { error: "Categoría inválida" };
    }
    out.categoryId = categoryId.trim();
  }
  if (categoryName !== undefined) {
    if (typeof categoryName !== "string" || !categoryName.trim() || categoryName.length > 120) {
      return { error: "Categoría inválida" };
    }
    out.categoryName = categoryName.trim();
  }
  if (groupName !== undefined) {
    if (typeof groupName !== "string" || groupName.length > 120) return { error: "Grupo inválido" };
    out.groupName = groupName.trim();
  }
  if (available !== undefined) {
    out.available = available === true || available === 1 ? 1 : 0;
  }
  if (!partial) {
    if (!out.name || out.price === undefined) return { error: "Faltan nombre y precio" };
    if (!out.categoryId) return { error: "Falta la categoría" };
  }
  return { data: out };
}

// Garantiza que la categoría (slug) tenga fila propia en la tabla categories:
// antes se podía crear un producto con "Nueva categoría" y la categoría quedaba
// huérfana (sin id numérico), por lo que no se podía renombrar/mover/eliminar.
async function ensureCategoryRow(branch, categoryId, categoryName) {
  const existing = await db
    .prepare("SELECT 1 FROM categories WHERE branch = ? AND category_id = ?")
    .get(branch, categoryId);
  if (existing) return;
  const sortOrderRow = await db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM categories WHERE branch = ?")
    .get(branch);
  await db
    .prepare("INSERT INTO categories (branch, category_id, name, sort_order) VALUES (?, ?, ?, ?)")
    .run(branch, categoryId, String(categoryName || categoryId).slice(0, 120), sortOrderRow.n);
}

app.post("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const { branch, ...rest } = req.body || {};
    // La sucursal sale de la SESIÓN: el branch_admin crea SIEMPRE en
    // la suya (body.branch se ignora); el superadmin elige, pero
    // tiene que existir de verdad (misma validación que antes).
    const branchResult = effectiveBranch(req.admin, branch);
    if (branchResult.error) return res.status(400).json({ error: branchResult.error });
    const branchId = branchResult.branch;
    // Si no se manda categoryId pero sí categoryName, se genera el slug
    if (!rest.categoryId && rest.categoryName) {
      rest.categoryId = slugify(rest.categoryName);
    }
    const validated = validateProductBody({ ...rest, categoryName: rest.categoryName || rest.categoryId });
    if (validated.error) return res.status(400).json({ error: validated.error });
    const data = validated.data;
    const existingRow = await db
      .prepare("SELECT COUNT(*) AS n FROM products WHERE branch = ? AND category_id = ?")
      .get(branchId, data.categoryId);
    const existing = existingRow.n;
    await ensureCategoryRow(branchId, data.categoryId, data.categoryName || data.categoryId);
    // Si la categoría ya tiene productos, reutilizar sus extras (ej: salsas en woks)
    let extrasJson = "[]";
    if (existing > 0) {
      const sample = await db
        .prepare("SELECT extras_json FROM products WHERE branch = ? AND category_id = ? AND extras_json != '[]' LIMIT 1")
        .get(branchId, data.categoryId);
      if (sample) extrasJson = sample.extras_json;
    }
    const productId = await uniqueProductId(branchId, data.name);
    const sortOrderRow = await db
      .prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM products WHERE branch = ?")
      .get(branchId);
    const sortOrder = sortOrderRow.n;
    const timestamp = now();
    const info = await db.prepare(`
    INSERT INTO products
      (branch, category_id, category_name, group_name, product_id, name, price,
       description, image, extras_json, available, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
      branchId,
      data.categoryId,
      data.categoryName || data.categoryId,
      data.groupName || "",
      productId,
      data.name,
      data.price,
      data.description || "",
      data.image || "",
      extrasJson,
      data.available === undefined ? 1 : data.available,
      sortOrder,
      timestamp,
      timestamp
    );
    CATALOG = await buildCatalog();
    invalidateMenuCache();
    const created = await db.prepare("SELECT * FROM products WHERE id = ?").get(info.lastInsertRowid);
    res.json({
      ok: true,
      product: productRowToAdmin(created),
    });
  } catch (err) {
    console.error("POST /api/admin/products:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.put("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    // Producto ajeno → 404: el branch_admin no puede editar el de
    // la otra sucursal.
    const row = await getScopedProduct(db, id, adminScope(req));
    if (!row) return res.status(404).json({ error: "Producto no encontrado" });
    const validated = validateProductBody(req.body);
    if (validated.error) return res.status(400).json({ error: validated.error });
    const data = validated.data;
    if (data.categoryId) {
      await ensureCategoryRow(row.branch, data.categoryId, data.categoryName || data.categoryId);
    }
    await db.prepare(`
    UPDATE products SET
      category_id = ?, category_name = ?, group_name = ?, name = ?,
      price = ?, description = ?, image = ?, available = ?, updated_at = ?
    WHERE id = ?
  `).run(
      data.categoryId,
      data.categoryName || row.category_name,
      data.groupName === undefined ? row.group_name : data.groupName,
      data.name,
      data.price,
      data.description === undefined ? row.description : data.description,
      data.image === undefined ? row.image : data.image,
      data.available === undefined ? row.available : data.available,
      now(),
      id
    );
    CATALOG = await buildCatalog();
    invalidateMenuCache();
    const updated = await db.prepare("SELECT * FROM products WHERE id = ?").get(id);
    // Limpieza: si el producto tenía una imagen subida (BLOB en Turso) y ahora
    // tiene otra (o ninguna), se borra la fila vieja para no acumular basura
    // que consume el mismo plan free.
    const oldImageId = imageIdFromProductImageUrl(row.image);
    const newImageId = imageIdFromProductImageUrl(data.image === undefined ? row.image : data.image);
    if (oldImageId && oldImageId !== newImageId) {
      try {
        await deleteProductImage(oldImageId);
      } catch (delErr) {
        console.error("PUT /api/admin/products/:id (limpieza imagen):", delErr.message);
      }
    }
    res.json({ ok: true, product: productRowToAdmin(updated) });
  } catch (err) {
    console.error("PUT /api/admin/products/:id:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.patch("/api/admin/products/:id/available", requireAdmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await getScopedProduct(db, id, adminScope(req));
    if (!row) return res.status(404).json({ error: "Producto no encontrado" });
    const { available } = req.body || {};
    const value = available === true || available === 1 ? 1 : 0;
    await db.prepare("UPDATE products SET available = ?, updated_at = ? WHERE id = ?").run(value, now(), id);
    CATALOG = await buildCatalog();
    invalidateMenuCache();
    const updated = await db.prepare("SELECT * FROM products WHERE id = ?").get(id);
    res.json({ ok: true, product: productRowToAdmin(updated) });
  } catch (err) {
    console.error("PATCH /api/admin/products/:id/available:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await getScopedProduct(db, id, adminScope(req));
    if (!row) return res.status(404).json({ error: "Producto no encontrado" });
    // Limpieza: si el producto usa una imagen subida (BLOB en Turso), se borra
    // junto con el producto para no dejar basura en el plan free.
    const deleteImageId = imageIdFromProductImageUrl(row.image);
    await db.prepare("DELETE FROM products WHERE id = ?").run(id);
    if (deleteImageId) {
      try {
        await deleteProductImage(deleteImageId);
      } catch (delErr) {
        console.error("DELETE /api/admin/products/:id (limpieza imagen):", delErr.message);
      }
    }
    CATALOG = await buildCatalog();
    invalidateMenuCache();
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/admin/products/:id:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// Reordenar un producto dentro de su grupo (↑/↓)
app.post("/api/admin/products/:id/move", requireAdmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    const dir = req.body?.dir === "down" ? "down" : "up";
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await getScopedProduct(db, id, adminScope(req));
    if (!row) return res.status(404).json({ error: "Producto no encontrado" });
    const scope = "branch = ? AND category_id = ? AND group_name = ?";
    const scoped = [row.branch, row.category_id, row.group_name];
    const neighbor = await db
      .prepare(
        `SELECT * FROM products WHERE ${scope} AND id != ? AND sort_order ${dir === "down" ? ">" : "<"} ?
       ORDER BY sort_order ${dir === "down" ? "ASC" : "DESC"} LIMIT 1`
      )
      .get(...scoped, row.id, row.sort_order);
    if (!neighbor) return res.status(400).json({ error: "No se puede mover más" });
    await db.prepare("UPDATE products SET sort_order = ?, updated_at = ? WHERE id = ?").run(
      neighbor.sort_order,
      now(),
      row.id
    );
    await db.prepare("UPDATE products SET sort_order = ?, updated_at = ? WHERE id = ?").run(
      row.sort_order,
      now(),
      neighbor.id
    );
    CATALOG = await buildCatalog();
    invalidateMenuCache();
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/admin/products/:id/move:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- categorías (agregar / renombrar / eliminar / reordenar) ----------
// Scope de los endpoints de grupos: sucursal + categoría. La
// sucursal sale de la SESIÓN: el branch_admin opera SIEMPRE en la
// suya (body.branch se ignora); el superadmin elige con body.branch.
function catScope(req) {
  const categoryId = req.body?.categoryId;
  const branchResult = effectiveBranch(req.admin, req.body?.branch);
  if (branchResult.error || typeof categoryId !== "string") return null;
  return { branch: branchResult.branch, categoryId };
}

app.post("/api/admin/categories", requireAdmin, async (req, res) => {
  try {
    const { name } = req.body || {};
    // La sucursal sale de la SESIÓN (igual que POST /products):
    // branch_admin → SIEMPRE la suya; superadmin → la del body.
    const branchResult = effectiveBranch(req.admin, req.body?.branch);
    if (branchResult.error) return res.status(400).json({ error: branchResult.error });
    const branch = branchResult.branch;
    const catName = String(name || "").trim();
    if (!catName || catName.length > 120) return res.status(400).json({ error: "Nombre de categoría inválido" });
    let catId = slugify(catName);
    let n = 1;
    while (await db.prepare("SELECT 1 FROM categories WHERE branch = ? AND category_id = ?").get(branch, catId)) {
      n += 1;
      catId = `${slugify(catName)}-${n}`;
    }
    const sortOrderRow = await db
      .prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM categories WHERE branch = ?")
      .get(branch);
    const sortOrder = sortOrderRow.n;
    const info = await db
      .prepare("INSERT INTO categories (branch, category_id, name, sort_order) VALUES (?, ?, ?, ?)")
      .run(branch, catId, catName, sortOrder);
    CATALOG = await buildCatalog();
    invalidateMenuCache();
    const created = await db.prepare("SELECT * FROM categories WHERE id = ?").get(info.lastInsertRowid);
    res.json({
      ok: true,
      category: toCategory(created),
    });
  } catch (err) {
    console.error("POST /api/admin/categories:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.put("/api/admin/categories/:id", requireAdmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    // Categoría ajena → 404: el branch_admin no puede renombrar la
    // de la otra sucursal.
    const row = await getScopedCategory(db, id, adminScope(req));
    if (!row) return res.status(404).json({ error: "Categoría no encontrada" });
    const name = String(req.body?.name || "").trim();
    if (!name || name.length > 120) return res.status(400).json({ error: "Nombre de categoría inválido" });
    await db.prepare("UPDATE categories SET name = ? WHERE id = ?").run(name, id);
    await db.prepare("UPDATE products SET category_name = ? WHERE branch = ? AND category_id = ?").run(
      name,
      row.branch,
      row.category_id
    );
    CATALOG = await buildCatalog();
    invalidateMenuCache();
    const updated = await db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
    res.json({ ok: true, category: toCategory(updated) });
  } catch (err) {
    console.error("PUT /api/admin/categories/:id:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.delete("/api/admin/categories/:id", requireAdmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await getScopedCategory(db, id, adminScope(req));
    if (!row) return res.status(404).json({ error: "Categoría no encontrada" });
    // Antes de borrar los productos, se anotan sus imágenes para limpiar los
    // BLOB y no dejarlos huérfanos hasta el sweep del próximo upload.
    const doomedImages = await db
      .prepare("SELECT image FROM products WHERE branch = ? AND category_id = ?")
      .all(row.branch, row.category_id);
    await db.prepare("DELETE FROM products WHERE branch = ? AND category_id = ?").run(row.branch, row.category_id);
    await db.prepare("DELETE FROM categories WHERE id = ?").run(id);
    await deleteImagesFromProductUrls(doomedImages.map((p) => p.image));
    CATALOG = await buildCatalog();
    invalidateMenuCache();
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/admin/categories/:id:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// Reordenar una categoría dentro de su sucursal (↑/↓)
app.post("/api/admin/categories/:id/move", requireAdmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    const dir = req.body?.dir === "down" ? "down" : "up";
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await getScopedCategory(db, id, adminScope(req));
    if (!row) return res.status(404).json({ error: "Categoría no encontrada" });
    const neighbor = await db
      .prepare(
        `SELECT * FROM categories WHERE branch = ? AND id != ? AND sort_order ${dir === "down" ? ">" : "<"} ?
       ORDER BY sort_order ${dir === "down" ? "ASC" : "DESC"} LIMIT 1`
      )
      .get(row.branch, id, row.sort_order);
    if (!neighbor) return res.status(400).json({ error: "No se puede mover más" });
    await db.prepare("UPDATE categories SET sort_order = ? WHERE id = ?").run(neighbor.sort_order, row.id);
    await db.prepare("UPDATE categories SET sort_order = ? WHERE id = ?").run(row.sort_order, neighbor.id);
    invalidateMenuCache();
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/admin/categories/:id/move:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- grupos (renombrar / eliminar) ----------
app.put("/api/admin/groups", requireAdmin, async (req, res) => {
  try {
    const scope = catScope(req);
    if (!scope) return res.status(400).json({ error: "Datos inválidos" });
    const { branch, categoryId } = scope;
    const oldName = String(req.body.oldName || "").trim();
    const newName = String(req.body.newName || "").trim();
    if (!oldName || !newName || newName.length > 120) return res.status(400).json({ error: "Grupo inválido" });
    const countRow = await db
      .prepare("SELECT COUNT(*) AS n FROM products WHERE branch = ? AND category_id = ? AND group_name = ?")
      .get(branch, categoryId, oldName);
    const count = countRow.n;
    if (!count) return res.status(404).json({ error: "Grupo no encontrado" });
    await db.prepare(
      "UPDATE products SET group_name = ?, updated_at = ? WHERE branch = ? AND category_id = ? AND group_name = ?"
    ).run(newName, now(), branch, categoryId, oldName);
    CATALOG = await buildCatalog();
    invalidateMenuCache();
    res.json({ ok: true, renamed: count });
  } catch (err) {
    console.error("PUT /api/admin/groups:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.delete("/api/admin/groups", requireAdmin, async (req, res) => {
  try {
    const scope = catScope(req);
    if (!scope) return res.status(400).json({ error: "Datos inválidos" });
    const { branch, categoryId } = scope;
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Grupo inválido" });
    const countRow = await db
      .prepare("SELECT COUNT(*) AS n FROM products WHERE branch = ? AND category_id = ? AND group_name = ?")
      .get(branch, categoryId, name);
    const count = countRow.n;
    if (!count) return res.status(404).json({ error: "Grupo no encontrado" });
    // Se limpian también los BLOB de imágenes de los productos del grupo
    // (igual que al borrar una categoría completa).
    const doomedImages = await db
      .prepare("SELECT image FROM products WHERE branch = ? AND category_id = ? AND group_name = ?")
      .all(branch, categoryId, name);
    await db.prepare("DELETE FROM products WHERE branch = ? AND category_id = ? AND group_name = ?").run(branch, categoryId, name);
    await deleteImagesFromProductUrls(doomedImages.map((p) => p.image));
    CATALOG = await buildCatalog();
    invalidateMenuCache();
    res.json({ ok: true, deleted: count });
  } catch (err) {
    console.error("DELETE /api/admin/groups:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- cupones (admin) ----------
function couponRowToAdmin(row) {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    value: row.value,
    minTotal: row.min_total,
    active: row.active === 1,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at || "",
    createdAt: row.created_at,
    branch: row.branch || "",
  };
}

// Branch de un cupón que crea un admin: el branch_admin cae SIEMPRE en su
// sucursal (venga lo que venga en el body); el superadmin elige entre
// global (''), necochea o tandil.
const COUPON_BRANCHES = ["", "necochea", "tandil"];
function couponBranchFor(req) {
  if (req.admin.role === "branch_admin") return req.admin.branch;
  const requested = String(req.body?.branch ?? "");
  return COUPON_BRANCHES.includes(requested) ? requested : null;
}

app.get("/api/admin/coupons", requireAdmin, async (req, res) => {
  try {
    // Con scope, el branch_admin ve SOLO los cupones de su sucursal: ni
    // los de la otra ni los globales (esos los crea el superadmin y
    // valen en ambas).
    const rows = await listCoupons(db, { scope: adminScope(req) });
    res.json({ coupons: rows.map(couponRowToAdmin) });
  } catch (err) {
    console.error("GET /api/admin/coupons:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.post("/api/admin/coupons", requireAdmin, async (req, res) => {
  try {
    const { code, type, value, minTotal, maxUses, active, expiresAt } = req.body || {};
    const branch = couponBranchFor(req);
    if (branch === null) return res.status(400).json({ error: "Sucursal inválida" });
    const cleanCode = String(code || "").trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,30}$/.test(cleanCode)) return res.status(400).json({ error: "Código de cupón inválido" });
    if (!["percent", "fixed"].includes(type)) return res.status(400).json({ error: "Tipo de cupón inválido" });
    const v = Number(value);
    if (!Number.isInteger(v) || v <= 0 || (type === "percent" && v > 100)) return res.status(400).json({ error: "Valor inválido" });
    const min = Math.max(0, Number(minTotal) || 0);
    const maxUsesNum = Math.max(0, Number(maxUses) || 0);
    // Duplicado por código GLOBAL (opción 2 del dueño): existe en cualquier
    // sucursal → error genérico, sin revelar en cuál está en uso.
    if (await isCouponCodeTaken(db, cleanCode)) {
      return res.status(400).json({ error: "Ese código ya está en uso" });
    }
    let expires = "";
    if (expiresAt) {
      const d = parseArLocal(expiresAt);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "Fecha de vencimiento inválida" });
      expires = d.toISOString();
    }
    const ts = now();
    await db.prepare(
      "INSERT INTO coupons (code, type, value, min_total, active, max_uses, expires_at, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(cleanCode, type, v, min, active === false ? 0 : 1, maxUsesNum, expires, branch, ts, ts);
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/admin/coupons:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.patch("/api/admin/coupons/:id", requireAdmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    // Ajeno al scope (otra sucursal, o global para el branch_admin) → 404,
    // sin confirmar la existencia.
    const row = await getScopedCoupon(db, id, adminScope(req));
    if (!row) return res.status(404).json({ error: "Cupón no encontrado" });
    const active = req.body?.active === false ? 0 : 1;
    await db.prepare("UPDATE coupons SET active = ?, updated_at = ? WHERE id = ?").run(active, now(), id);
    const updated = await db.prepare("SELECT * FROM coupons WHERE id = ?").get(id);
    res.json({ ok: true, coupon: couponRowToAdmin(updated) });
  } catch (err) {
    console.error("PATCH /api/admin/coupons/:id:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.put("/api/admin/coupons/:id", requireAdmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await getScopedCoupon(db, id, adminScope(req));
    if (!row) return res.status(404).json({ error: "Cupón no encontrado" });

    const { code, type, value, minTotal, maxUses, active } = req.body || {};
    const cleanCode = String(code ?? row.code).trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,30}$/.test(cleanCode)) return res.status(400).json({ error: "Código de cupón inválido" });
    const finalType = type ?? row.type;
    if (!["percent", "fixed"].includes(finalType)) return res.status(400).json({ error: "Tipo de cupón inválido" });
    const finalValue = value !== undefined ? Number(value) : row.value;
    if (!Number.isFinite(finalValue) || finalValue <= 0 || (finalType === "percent" && finalValue > 100)) {
      return res.status(400).json({ error: "Valor inválido" });
    }
    const finalMin = minTotal !== undefined ? Math.max(0, Number(minTotal) || 0) : row.min_total;
    const finalMaxUses = maxUses !== undefined ? Math.max(0, Number(maxUses) || 0) : row.max_uses;

    // Duplicado GLOBAL igual que el POST (mismo caso, mismo mensaje
    // genérico). La sucursal del cupón no se edita acá: nace con ella.
    if (cleanCode !== row.code) {
      const dup = await isCouponCodeTaken(db, cleanCode, { excludeId: id });
      if (dup) return res.status(400).json({ error: "Ese código ya está en uso" });
    }
    const finalActive = active !== undefined ? (active ? 1 : 0) : row.active;
    await db.prepare(
      "UPDATE coupons SET code = ?, type = ?, value = ?, min_total = ?, max_uses = ?, active = ?, updated_at = ? WHERE id = ?"
    ).run(cleanCode, finalType, finalValue, finalMin, finalMaxUses, finalActive, now(), id);

    const updated = await db.prepare("SELECT * FROM coupons WHERE id = ?").get(id);
    res.json({ ok: true, coupon: couponRowToAdmin(updated) });
  } catch (err) {
    console.error("PUT /api/admin/coupons/:id:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.delete("/api/admin/coupons/:id", requireAdmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await getScopedCoupon(db, id, adminScope(req));
    if (!row) return res.status(404).json({ error: "Cupón no encontrado" });
    await db.prepare("DELETE FROM coupons WHERE id = ?").run(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/admin/coupons/:id:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- cuentas de admin por sucursal (solo superadmin) ----------
// El dueño crea y administra los admins de cada sucursal. Las
// contraseñas viajan por HTTPS, se hashean con scrypt dentro de
// admin-users.js y NUNCA salen del server: estos endpoints solo
// devuelven id/username/branch/role/active. Cambiar contraseña o
// desactivar borra los tokens de la cuenta (la sesión abierta corta
// en el request siguiente).
app.get("/api/admin/users", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    res.json({ users: await listAdminUsers(db) });
  } catch (err) {
    console.error("GET /api/admin/users:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.post("/api/admin/users", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    const { username, password, branch } = req.body || {};
    const r = await createAdminUser(db, { username, password, branch }, { envUser: ADMIN_USER, nowIso: now() });
    if (r.error) return res.status(400).json({ error: r.error });
    res.status(201).json({ ok: true, user: r.user });
  } catch (err) {
    // Nunca se loguea la contraseña (ni el hash) si algo falla.
    console.error("POST /api/admin/users:", err.message);
    res.status(500).json({ error: "No se pudo crear la cuenta" });
  }
});

app.put("/api/admin/users/:id/password", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const { password } = req.body || {};
    const r = await setUserPassword(db, id, password, { nowIso: now() });
    if (r.error) return res.status(r.error === "Cuenta no encontrada" ? 404 : 400).json({ error: r.error });
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /api/admin/users/:id/password:", err.message);
    res.status(500).json({ error: "No se pudo cambiar la contraseña" });
  }
});

app.patch("/api/admin/users/:id", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const { active } = req.body || {};
    if (typeof active !== "boolean") return res.status(400).json({ error: "Falta el estado de la cuenta" });
    const r = await setUserActive(db, id, active, { nowIso: now() });
    if (r.error) return res.status(r.error === "Cuenta no encontrada" ? 404 : 400).json({ error: r.error });
    res.json({ ok: true, active: r.active });
  } catch (err) {
    console.error("PATCH /api/admin/users/:id:", err.message);
    res.status(500).json({ error: "No se pudo actualizar la cuenta" });
  }
});

// Borrar una cuenta de sucursal DEFINITIVAMENTE (solo superadmin).
// Borra también sus tokens: la sesión abierta cae en el request
// siguiente. Pedidos, ventas y cajas no se tocan (no referencian
// a la cuenta).
app.delete("/api/admin/users/:id", requireAdmin, requireSuperadmin, async (req, res) => {
  try {
    const id = paramId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const r = await deleteAdminUser(db, id);
    if (r.error) return res.status(r.error === "Cuenta no encontrada" ? 404 : 400).json({ error: r.error });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/admin/users/:id:", err.message);
    res.status(500).json({ error: "No se pudo borrar la cuenta" });
  }
});

// ---------- imágenes de producto (upload) ----------
// Recibe un dataURL base64, valida formato y tamaño, y guarda el BLOB en la
// base (Tabla product_images de Turso). El filesystem de Render free se borra
// en cada redeploy, así que aquí NUNCA se escribe a disco: las imágenes se
// sirven por /api/images/products/:id (ruta debajo), con ?v= para cachear.
// Extrae el id de una URL de imagen subida a la base (/api/images/products/N?v=ts)
function imageIdFromProductImageUrl(url) {
  if (typeof url !== "string") return 0;
  const m = String(url).match(/^\/api\/images\/products\/(\d+)(?:\?|$)/);
  return m ? Number(m[1]) : 0;
}

// Borra los BLOB de imágenes subidas (Turso) referenciados por un grupo de
// URLs de producto. Al eliminar una categoría o un grupo ya no hay productos
// dueños y, sin esto, los BLOB quedarían huérfanos hasta el sweep del upload.
async function deleteImagesFromProductUrls(urls) {
  for (const url of urls || []) {
    const imgId = imageIdFromProductImageUrl(url);
    if (!imgId) continue;
    try {
      await deleteProductImage(imgId);
    } catch (err) {
      console.error("Limpieza de imagen de producto:", err.message);
    }
  }
}

app.post(
  "/api/admin/upload",
  requireAdmin,
  rateLimit({ max: 60, windowMs: 60000, name: "upload" }),
  async (req, res) => {
    try {
      const { dataUrl } = req.body || {};
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
        return res.status(400).json({ error: "Imagen inválida" });
      }
      const m = dataUrl.match(/^data:image\/(png|jpeg|webp|gif);base64,(.+)$/);
      if (!m) return res.status(400).json({ error: "Formato de imagen no soportado" });
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > 1.5 * 1024 * 1024) return res.status(400).json({ error: "La imagen supera 1.5 MB" });
      const saved = await saveProductImage({ mime: `image/${m[1]}`, data: buf });
      const v = Math.floor(Date.now() / 1000);
      // Sweep de huérfanas: borra BLOBs sin ninguna referencia en products
      // (upload subido y cancelado sin guardar el producto), con un margen de
      // 10 min para no romper un upload recién hecho que el front todavía está
      // por asociar. La fila recién creada se excluye siempre.
      try {
        const refs = await db.prepare("SELECT image FROM products").all();
        const referenced = new Set();
        for (const r of refs) {
          const rid = imageIdFromProductImageUrl(r.image);
          if (rid) referenced.add(rid);
        }
        const cutoff = new Date(Date.now() - 10 * 60000).toISOString();
        let sql = "DELETE FROM product_images WHERE id != ? AND created_at <= ?";
        const args = [saved.id, cutoff];
        if (referenced.size) {
          const placeholders = [...referenced].map(() => "?").join(",");
          sql += ` AND id NOT IN (${placeholders})`;
          args.push(...referenced);
        }
        await db.prepare(sql).run(...args);
      } catch (sweepErr) {
        console.error("sweep imagenes huérfanas:", sweepErr.message);
      }
      res.json({ ok: true, url: `/api/images/products/${saved.id}?v=${v}` });
    } catch (err) {
      console.error("POST /api/admin/upload:", err.message);
      res.status(500).json({ error: "No se pudo guardar la imagen" });
    }
  }
);

// Sirve las imágenes guardadas como BLOB en Turso. La URL lleva ?v=<updatedAt>
// (constante por versión) → Cache-Control inmutable; el front ya cambia el query
// al regenerar la imagen. Nunca se consulta por un id viejo tras un redeploy.
app.get(
  "/api/images/products/:id",
  rateLimit({ max: 300, windowMs: 60000, name: "images" }),
  async (req, res) => {
    try {
      const id = paramId(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
      const row = await getProductImage(id);
      if (!row) return res.status(404).json({ error: "Imagen no encontrada" });
      const buf = Buffer.from(row.data);
      res.setHeader("Content-Type", row.mime);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Content-Length", buf.length);
      res.end(buf);
    } catch (err) {
      console.error("GET /api/images/products/:id:", err.message);
      if (!res.headersSent) res.status(500).json({ error: "Error interno" });
    }
  }
);

// ---------- producción: servir el build ----------
const distDir = path.join(__dirname, "..", "dist");

// Los assets de Vite llevan hash en el nombre (index-XXXX.js): una vez
// publicados son inmutables, se cachean por 1 año sin revalidar.
const distAssetsDir = path.join(distDir, "assets");
app.use(
  "/assets",
  express.static(distAssetsDir, { maxAge: "1y", immutable: true })
);

// SEO: se lee el HTML del build una vez y se reescribe por request
// (title, description, canonical, og:image, JSON-LD por ruta/sucursal).
let indexHtml = null;
function indexTemplate() {
  if (indexHtml === null) indexHtml = readFileSync(path.join(distDir, "index.html"), "utf8");
  return indexHtml;
}

// CSP: solo en páginas HTML (ruta SEO). Scripts permitidos: assets propios
// ('self') y el JSON-LD inline con nonce por request. Con la Orders API el
// pago ocurre en el checkout alojado por Mercado Pago (el navegador se va a
// mercadopago.com), así que ya no hace falta cargar ningún script de MP.
// Sin 'unsafe-inline' para scripts: cualquier script inline inyectado queda
// bloqueado. Estilos inline (React) sí se permiten (style-src 'unsafe-inline').
// El ticket de impresión abre una ventana about:blank SIN <script> (solo un
// <style>, permitido): la impresión no se ve afectada.
function buildCsp(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

app.get("/robots.txt", (req, res) => {
  res.type("text/plain");
  res.setHeader("Cache-Control", "no-cache, must-revalidate");
  res.send(
    [
      "User-agent: *",
      "Allow: /",
      "Disallow: /admin",
      "Disallow: /track/",
      "Disallow: /api",
      `Sitemap: ${requestBaseUrl(req)}/sitemap.xml`,
      "",
    ].join("\n")
  );
});

app.get("/sitemap.xml", (req, res) => {
  res.type("application/xml");
  res.setHeader("Cache-Control", "no-cache, must-revalidate");
  const baseUrl = requestBaseUrl(req);
  const urls = [
    { loc: `${baseUrl}/`, priority: "1.0", changefreq: "weekly" },
    { loc: `${baseUrl}/?branch=necochea`, priority: "0.9", changefreq: "weekly" },
    { loc: `${baseUrl}/?branch=tandil`, priority: "0.9", changefreq: "weekly" },
    { loc: `${baseUrl}/track`, priority: "0.5", changefreq: "monthly" },
  ];
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(
        (u) =>
          `  <url><loc>${u.loc.replace(/&/g, "&amp;")}</loc><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`
      )
      .join("\n") +
    `\n</urlset>\n`;
  res.send(body);
});

// Páginas SPA → HTML con SEO por ruta. Va ANTES de express.static porque
// el static sirve dist/index.html para "/" (y se saltaría la inyección).
// Los archivos con extensión (js/css/img) se dejan pasar al static.
function serveSpaPage(req, res, { noindex = false } = {}) {
  if (noindex) res.setHeader("X-Robots-Tag", "noindex, follow");
  const canonicalPath =
    req.path === "/" && (req.query.branch === "necochea" || req.query.branch === "tandil")
      ? `/?branch=${req.query.branch}`
      : req.path;
  res.setHeader("Cache-Control", "no-cache, must-revalidate");
  // Nonce por request → el JSON-LD se marca con él en enhanceHtml y la CSP
  // solo admite ese script inline puntual.
  const nonce = randomBytes(16).toString("base64");
  res.setHeader("Content-Security-Policy", buildCsp(nonce));
  res.send(
    enhanceHtml(indexTemplate(), {
      pathname: req.path,
      query: req.query || {},
      baseUrl: requestBaseUrl(req),
      canonicalPath,
      nonce,
    })
  );
}

app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (req.path.startsWith("/api")) return next();
  if (/\.[a-zA-Z0-9]{1,10}$/.test(req.path)) return next();
  const isSensitive = req.path.startsWith("/admin") || req.path.startsWith("/track/");
  serveSpaPage(req, res, { noindex: isSensitive });
});

// index.html y demás estáticos sin hash: negocian con ETag/Last-Modified
// (un nuevo build cambia el contenido y el nombre de los assets).
app.use(
  express.static(distDir, {
    etag: true,
    maxAge: 0,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    },
  })
);

// Fallback SPA de último recurso (rutas no-api que el static no sirvió,
// p. ej. un asset con hash viejo). Se sirve con el mismo HTML+SEO+CSP que
// el resto y con noindex: antes se enviaba index.html crudo, sin CSP ni
// noindex (headers inconsistentes).
app.get(/^(?!\/api).*/, (req, res) => {
  serveSpaPage(req, res, { noindex: true });
});

// 404 JSON para lo que no matcheó (incluye rutas /api desconocidas y métodos
// no-GET a rutas inexistentes). Antes Express devolvía su 404 HTML por defecto.
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

// Error handler final: nunca filtra detalles internos (stacks) al cliente.
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "JSON inválido" });
  }
  console.error("Error no controlado:", err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Error interno" });
});

app.listen(PORT, () => {
  console.log(`🌱 Fusión Wok API corriendo en http://localhost:${PORT}`);
  console.log(`   Modo demo: ${isDemoMode() ? "SÍ (sin credenciales reales)" : "NO (Mercado Pago real)"}`);
});
