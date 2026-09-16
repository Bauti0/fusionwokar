import "dotenv/config";
import express from "express";
import cors from "cors";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import {
  db,
  toPublicOrder,
  toPublicOrderPublic,
  nextOrderNumber,
  toProduct,
  toCategory,
  seedProducts,
  seedCategories,
} from "./db.js";
import { createPreference, getPayment, getMpPublicKey, isDemoMode, verifyWebhookSignature } from "./mp.js";
import { MENUS } from "../src/data/menus.js";
import { enhanceHtml } from "./seo.js";
import { isOpenAtTime, toWallclock } from "../src/utils/schedule.js";
import { computeShipping } from "./shipping.js";

// ============================================================
// FUSIÓN WOK — API + servidor de producción
// Endpoints:
//   POST  /api/orders                       → crea pedido (WhatsApp o MP)
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
//   DELETE /api/admin/coupons/:id           → eliminar cupón
//   POST  /api/admin/upload                 → subir imagen de producto
//   GET   /api/admin/customers               → clientes agrupados por teléfono
//   GET   /api/admin/sales                   → ventas por período + medios de pago
//   GET   /api/admin/cash-register           → caja abierta + historial de arqueos
//   POST  /api/admin/cash-register/open      → abrir caja
//   POST  /api/admin/cash-register/:id/close → cerrar caja (calcula diferencia)
//   POST  /api/admin/orders/manual           → cargar pedido de WhatsApp/mostrador
// ============================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const app = express();

// Siembra el menú y las categorías en la BD (solo la primera vez)
await seedProducts(MENUS);
await seedCategories(MENUS);

// ---------- validación de configuración (fail-fast en producción) ----------
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "fusionwok";
const DEMO = isDemoMode();

function validateConfig() {
  const problems = [];
  let fatal = false;
  if (!DEMO) {
    if (!process.env.MP_ACCESS_TOKEN) problems.push("Falta MP_ACCESS_TOKEN");
    if (!process.env.MP_PUBLIC_KEY) problems.push("Falta MP_PUBLIC_KEY");
    if (!process.env.MP_WEBHOOK_SECRET) problems.push("Falta MP_WEBHOOK_SECRET (el webhook rechazará pagos)");
    if (problems.length) fatal = true;
  }
  // La contraseña por defecto ("fusionwok") quedó publicada como ejemplo:
  // en producción (NODE_ENV=production o DEMO_MODE=false) no se permite arrancar.
  // Ojo: se mira el env EXPLÍCITO, no DEMO resuelto (isDemoMode() devuelve true
  // cuando faltan credenciales de MP, aunque DEMO_MODE sea false).
  const weakPassword = !process.env.ADMIN_PASSWORD || ADMIN_PASSWORD === "fusionwok";
  if (weakPassword) {
    problems.push('ADMIN_PASSWORD sin configurar o con el valor por defecto ("fusionwok")');
    if (process.env.NODE_ENV === "production" || process.env.DEMO_MODE === "false") fatal = true;
  }
  if (!problems.length) {
    console.log("✅ Configuración válida");
    return;
  }
  for (const p of problems) console.error(`⚠️  ${p}`);
  if (fatal) {
    console.error(
      "❌ Configuración inválida para producción. Revisá el archivo .env antes de arrancar:\n" +
        "   - Generá una ADMIN_PASSWORD fuerte (16+ caracteres, alfanumérica + símbolos).\n" +
        "   - Completá las credenciales de Mercado Pago (MP_*)."
    );
    process.exit(1);
  }
}
validateConfig();

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
  next();
});

// Las API nunca deben cachearse (datos en vivo: pedidos, menú, admin).
// Se registra ANTES de las rutas para que aplique a todas las respuestas.
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});

// Protección CSRF para las mutaciones del panel: con auth por cookie, una
// petición que llega desde un origen distinto al del servidor se rechaza.
// (Los GET del panel son idempotentes y no se protegen.)
app.use("/api/admin", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    const o = new URL(origin);
    // Mismo host directo (producción: todo detrás del mismo dominio)
    if (o.host === req.headers.host) return next();
    // Orígenes habilitados vía ALLOWED_ORIGINS (p. ej. el front servido
    // desde otro puerto/dominio que el backend)
    if (allowedOrigins.includes(o.origin)) return next();
    // En desarrollo el proxy de Vite reescribe el Host (changeOrigin), así
    // que el origen del navegador es localhost:5173 y el host llega como
    // localhost:3001. Se acepta localhost/127.0.0.1 en cualquier puerto.
    if (
      process.env.NODE_ENV !== "production" &&
      ["localhost", "127.0.0.1"].includes(o.hostname)
    ) {
      return next();
    }
  } catch {
    return res.status(403).json({ error: "Origen inválido" });
  }
  return res.status(403).json({ error: "Origen no permitido" });
});

// ---------- utilidades ----------
// Base URL para canonical/og:image/sitemap. Si PUBLIC_BASE_URL está seteado
// se usa tal cual (importante con tu dominio propio). Si no, se deriva del
// request (Host + proto) → funciona sin config en el subdominio *.onrender.com
// y en cualquier dominio que apunte al servicio.
const ENV_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
function requestBaseUrl(req) {
  if (ENV_BASE_URL) return ENV_BASE_URL;
  const host = req.headers.host;
  if (!host) return `http://localhost:${PORT}`;
  const proto = req.headers["x-forwarded-proto"];
  return `${proto && String(proto).includes("https") ? "https" : "http"}://${host}`;
}
const TOKEN_TTL_MS = Number(process.env.ADMIN_TOKEN_TTL_MS || 24 * 3600 * 1000); // 24h por defecto

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

// ---------- catálogo de productos (para validar precios server-side) ----------
// La BD es la fuente de verdad del menú. Se siembra desde los archivos
// estáticos la primera vez y luego se edita desde el panel admin.
async function buildCatalog() {
  const catalog = {};
  const rows = await db.prepare("SELECT * FROM products ORDER BY sort_order").all();
  for (const row of rows) {
    const p = toProduct(row);
    if (!catalog[row.branch]) catalog[row.branch] = {};
    catalog[row.branch][p.id] = {
      price: p.price,
      available: p.available,
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
  const menu = { branchId, categories };
  menuCache.set(branchId, { at: Date.now(), menu });
  return menu;
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

// Valida un cupón contra la BD y calcula el descuento
async function applyCoupon(code, total) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) return { error: "Falta el código del cupón" };
  const row = await db.prepare("SELECT * FROM coupons WHERE code = ?").get(clean);
  if (!row) return { error: "El cupón no existe" };
  if (row.active !== 1) return { error: "El cupón ya no está activo" };
  if (row.max_uses > 0 && row.used_count >= row.max_uses) {
    return { error: "El cupón ya no tiene usos disponibles" };
  }
  if (row.expires_at) {
    const exp = new Date(row.expires_at);
    if (isNaN(exp.getTime()) || exp.getTime() < Date.now()) return { error: "El cupón está vencido" };
  }
  if (total < row.min_total) return { error: `El cupón requiere un pedido mínimo de $${row.min_total}` };
  let discount;
  if (row.type === "percent") discount = Math.round((total * row.value) / 100);
  else discount = row.value;
  discount = Math.min(Math.max(discount, 0), total);
  return { code: row.code, discount };
}

// Reserva/liberación atómica de un uso de cupón. La reserva usa un UPDATE
// condicional (no SELECT + UPDATE separados): si dos checkouts simultáneos
// usan el mismo cupón de un solo uso, solo uno logra reservar. Se reserva
// ANTES de cualquier await (ej. createPreference de Mercado Pago) y se
// libera si el pedido nunca llega a crearse.
async function reserveCoupon(code) {
  if (!code) return true; // no hay cupón, nada que reservar
  const result = await db.prepare(`
    UPDATE coupons SET used_count = used_count + 1, updated_at = ?
    WHERE code = ? AND active = 1 AND (max_uses = 0 OR used_count < max_uses)
  `).run(now(), code);
  return result.changes > 0;
}

async function releaseCoupon(code) {
  if (!code) return;
  await db.prepare("UPDATE coupons SET used_count = MAX(used_count - 1, 0), updated_at = ? WHERE code = ?")
    .run(now(), code);
}

// Valida y normaliza el cuerpo del pedido (evita manipulación de precios,
// cantidades negativas, productos inexistentes y pedidos falsos).
async function validateOrderBody(body) {
  const { branch, customer, orderMode, paymentMethod, items, notes, scheduledFor, couponCode } = body || {};
  if (!CATALOG[branch]) return { error: "Sucursal inválida" };
  if (!customer || typeof customer.name !== "string" || !customer.name.trim() || customer.name.trim().length > 100) {
    return { error: "Faltan datos del cliente" };
  }
  const phone = String(customer.phone || "").trim();
  if (!phone || phone.length > 30) return { error: "Falta el teléfono" };
  if (!["delivery", "pickup"].includes(orderMode)) return { error: "Modalidad inválida" };
  if (!["mercadopago", "efectivo", "transferencia"].includes(paymentMethod)) {
    return { error: "Método de pago inválido" };
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
    return { error: "Faltan productos" };
  }
  // Fecha programada (opcional): ISO válida, entre 10 min y 7 días
  let scheduled = "";
  if (scheduledFor) {
    const iso = new Date(scheduledFor);
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
    if (Number(it.unitPrice) !== product.price) return { error: "Precio inválido" };
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
      unitPrice: product.price,
      extras,
      notes: String(it.notes || "").slice(0, 300),
      qty,
    });
  }
  const address = orderMode === "delivery" ? String(body.address || "").trim() : "";
  if (orderMode === "delivery" && !address) return { error: "Falta la dirección de entrega" };

  // Cupón de descuento (opcional): se valida contra la BD y se recalcula
  let discount = 0;
  let appliedCoupon = "";
  if (couponCode) {
    const coupon = await applyCoupon(couponCode, total);
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
      return { error: err.message };
    }
  }
  return {
    data: {
      branch,
      customer: { name: customer.name.trim().slice(0, 100), phone },
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

// Autenticación del admin (cookie httpOnly o token en tabla admin_tokens)
async function requireAdmin(req, res, next) {
  try {
    const token = getAdminToken(req);
    const row = await db.prepare("SELECT * FROM admin_tokens WHERE token = ?").get(token);
    if (!row) return res.status(401).json({ error: "No autorizado" });
    const age = Date.now() - new Date(row.created_at).getTime();
    if (age > TOKEN_TTL_MS) {
      await db.prepare("DELETE FROM admin_tokens WHERE token = ?").run(token);
      return res.status(401).json({ error: "Sesión expirada" });
    }
    return next();
  } catch (err) {
    console.error("requireAdmin:", err.message);
    return res.status(500).json({ error: "Error al validar la sesión" });
  }
}

// ---------- rate limit de login (bloqueo progresivo por IP) ----------
// 1-4 fallos en 60s → bloqueo por rateLimit básico (429)
// ≥10 fallos → bloqueo 5 min · ≥20 fallos → bloqueo 30 min
const loginAttempts = new Map(); // ip → { fails, blockedUntil }

function recordLoginFailure(req) {
  const ip = getClientIp(req);
  const entry = loginAttempts.get(ip) || { fails: 0, blockedUntil: 0 };
  entry.fails += 1;
  const t = Date.now();
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

// ---------- pedidos (cliente) ----------
// Ventana generosa a propósito: en el flujo de Mercado Pago es normal que el
// cliente cierre el modal y reintente el checkout varias veces. El abuso ya
// está cubierto por la validación de catálogo/precios server-side.
app.post("/api/orders", rateLimit({ max: 20, windowMs: 5 * 60 * 1000, name: "orders" }), async (req, res) => {
  try {
    const result = await validateOrderBody(req.body);
    if (result.error) return res.status(400).json({ error: result.error });
    const { branch, customer, orderMode, paymentMethod, address, items, notes, total, discount, couponCode, scheduledFor, shipping } = result.data;

    const orderNumber = await nextOrderNumber();
    const demo = isDemoMode();
    const isMp = paymentMethod === "mercadopago";

    // Reserva atómica del uso del cupón ANTES de cualquier await/insert:
    // evita que dos checkouts simultáneos consuman el mismo cupón limitado
    let couponReserved = false;
    if (couponCode) {
      if (!(await reserveCoupon(couponCode))) {
        return res.status(400).json({ error: "El cupón ya no tiene usos disponibles" });
      }
      couponReserved = true;
    }

    try {
      // Para Mercado Pago se crea la preferencia ANTES de guardar el pedido
      let mpPreferenceId = null;
      let initPoint = null;
      if (isMp && !demo) {
        const pref = await createPreference({
          orderNumber,
          total,
          title: `Pedido Fusión Wok ${orderNumber}`,
          description: `${items.length} items · ${branch}`,
          backUrls: {
            success: `${requestBaseUrl(req)}/?pago=aprobado&pedido=${orderNumber}`,
            pending: `${requestBaseUrl(req)}/?pago=pendiente&pedido=${orderNumber}`,
            failure: `${requestBaseUrl(req)}/?pago=rechazado&pedido=${orderNumber}`,
          },
          notificationUrl: `${requestBaseUrl(req)}/api/webhooks/mercadopago`,
        });
        mpPreferenceId = pref.id;
        initPoint = pref.init_point || pref.sandbox_init_point || null;
      }

      const ts = now();
      // INSERT del pedido (+ evento "order_created" para efectivo/transferencia)
      // en UN solo batch: 1 round-trip y atómico.
      const stmts = [
        {
          sql: `
        INSERT INTO orders
          (order_number, branch, customer_name, customer_phone, address, order_mode,
           payment_method, payment_status, status, items, total, discount, coupon_code,
           scheduled_for, notes, mp_preference_id, shipping, shipping_km, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
          args: [
            orderNumber,
            branch,
            customer.name,
            customer.phone,
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
            mpPreferenceId,
            shipping.cost,
            shipping.blocks,
            ts,
            ts,
          ],
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

      res.json({
        ok: true,
        orderId: Number(info.lastInsertRowid),
        orderNumber,
        demo,
        publicKey: isMp ? getMpPublicKey() : "",
        preferenceId: mpPreferenceId || `demo-${Number(info.lastInsertRowid)}`,
        initPoint,
        status: isMp ? "pending_payment" : "received",
        total,       // total recalculado server-side (con descuento y envío)
        discount,
        couponCode,
        scheduledFor,
        shipping: { cost: shipping.cost, blocks: shipping.blocks },
      });
    } catch (err) {
      // El pedido no se creó: devolvemos el uso reservado del cupón
      if (couponReserved) await releaseCoupon(couponCode);
      throw err;
    }
  } catch (err) {
    console.error("POST /api/orders:", err.message);
    res.status(500).json({ error: "No se pudo crear el pedido" });
  }
});

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

// Estado público de un pedido (por id) — usado para el polling del pago
app.get("/api/orders/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
    if (isNotModified(req, row)) return res.status(304).end();
    res.json(toPublicOrderPublic(row));
  } catch (err) {
    console.error("GET /api/orders/:id:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// Tracking del cliente por número de pedido (FW-00001)
app.get("/api/orders/number/:orderNumber", async (req, res) => {
  try {
    const num = String(req.params.orderNumber || "").trim().toUpperCase();
    if (!/^FW-\d{4,10}$/.test(num)) return res.status(400).json({ error: "Número de pedido inválido" });
    const row = await db.prepare("SELECT * FROM orders WHERE order_number = ?").get(num);
    if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
    if (isNotModified(req, row)) return res.status(304).end();
    res.json(toPublicOrderPublic(row));
  } catch (err) {
    console.error("GET /api/orders/number/:orderNumber:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// "Mis pedidos": lista los pedidos de un cliente por su teléfono.
// Solo se devuelven datos mínimos (sin exponer pedidos de otras personas).
app.get("/api/orders/by-phone/:phone", rateLimit({ max: 15, name: "byphone" }), async (req, res) => {
  try {
    const phone = (req.params.phone || "").trim();
    if (!phone || phone.length > 30) return res.status(400).json({ error: "Falta el teléfono" });
    const rows = await db
      .prepare(
        "SELECT * FROM orders WHERE customer_phone = ? ORDER BY created_at DESC LIMIT 50"
      )
      .all(phone);
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
  res.json({ ok: true, demo: isDemoMode(), time: now() });
});

app.get("/api/menu/:branchId", async (req, res) => {
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
app.post("/api/coupons/validate", rateLimit({ max: 30, name: "couponvalidate" }), async (req, res) => {
  try {
    const { code, total } = req.body || {};
    const n = Number(total);
    if (typeof code !== "string" || !code.trim() || !Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: "Datos inválidos" });
    }
    const result = await applyCoupon(code, n);
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
app.post("/api/webhooks/mercadopago", async (req, res) => {
  try {
    const { type, data } = req.body || {};
    console.log("Webhook recibido:", JSON.stringify({ type, data }));

    // En producción, exigimos firma válida. En demo (sin credenciales) se acepta
    // solo si la firma está configurada y es válida.
    if (!verifyWebhookSignature(req)) {
      console.warn("Webhook rechazado: firma inválida");
      return res.status(400).json({ error: "Firma inválida" });
    }
    if (!isDemoMode() && !process.env.MP_WEBHOOK_SECRET) {
      console.warn("Webhook rechazado: falta MP_WEBHOOK_SECRET en producción");
      return res.status(400).json({ error: "Falta configuración de webhook" });
    }

    if (type === "payment" && data?.id) {
      const paymentId = String(data.id);
      const payment = await getPayment(paymentId);
      if (payment.external_reference) {
        const row = await db
          .prepare("SELECT * FROM orders WHERE order_number = ?")
          .get(payment.external_reference.toUpperCase());
        if (row) {
          const status =
            payment.status === "approved"
              ? "approved"
              : payment.status === "rejected"
                ? "rejected"
                : row.payment_status;
          const orderStatus =
            payment.status === "approved" ? "received" : row.status;

          // Idempotencia: solo registrar "order_created" la primera vez que se aprueba
          const wasApproved = row.payment_status === "approved";
          await db.prepare(
            "UPDATE orders SET payment_status = ?, status = ?, mp_payment_id = ?, updated_at = ? WHERE id = ?"
          ).run(status, orderStatus, paymentId, now(), row.id);
          console.log(
            `Pedido ${row.order_number} actualizado → payment=${status} status=${orderStatus}`
          );
          if (status === "approved" && !wasApproved) await recordEvent("order_created", row.branch);
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.sendStatus(200); // siempre 200 para que MP no reintente en loop
  }
});

// ---------- demo (solo activo en modo demo) ----------
if (isDemoMode()) {
  app.post("/api/payments/demo/:id/:action", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const action = req.params.action; // "approve" | "reject"
      if (!Number.isInteger(id) || id <= 0 || !["approve", "reject"].includes(action)) {
        return res.status(400).json({ error: "Solicitud inválida" });
      }
      const row = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
      if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
      const approved = action === "approve";
      const wasApproved = row.payment_status === "approved";
      await db.prepare(
        "UPDATE orders SET payment_status = ?, status = ?, updated_at = ? WHERE id = ?"
      ).run(approved ? "approved" : "rejected", approved ? "received" : row.status, now(), id);
      if (approved && !wasApproved) await recordEvent("order_created", row.branch);
      res.json({ ok: true, orderId: id, paymentStatus: approved ? "approved" : "rejected" });
    } catch (err) {
      console.error("POST /api/payments/demo/:id/:action:", err.message);
      res.status(500).json({ error: "Error interno" });
    }
  });
}

// ---------- admin ----------
// Comparación en tiempo constante para credenciales. Se hashean ambos lados
// a longitud fija (SHA-256) antes de timingSafeEqual: así no se filtra ni el
// contenido ni el largo del secreto por diferencias de tiempo.
function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

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
       if (!safeEqual(username, ADMIN_USER) || !safeEqual(password, ADMIN_PASSWORD)) {
         recordLoginFailure(req);
         return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
       }
      recordLoginSuccess(req);
      const token = randomBytes(32).toString("hex");
      await db.prepare("INSERT INTO admin_tokens (token, created_at) VALUES (?, ?)").run(token, now());
      // Cookie httpOnly: el token nunca queda en localStorage ni en JS.
      // secure en producción (o con MP real configurado): nunca viaja por HTTP plano
      res.cookie("fw_admin_token", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production" || !isDemoMode(),
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
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/admin/logout:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// Valida la sesión del panel (cookie o header) sin exponer el token
app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ ok: true, user: ADMIN_USER });
});

// Listado de pedidos para el admin (con filtros, búsqueda y paginación)
app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const { branch, search, status, payment, includePending } = req.query;
    const conds = [];
    const params = [];

    if (branch) { conds.push("branch = ?"); params.push(branch); }
    if (status && status !== "all") { conds.push("status = ?"); params.push(status); }
    if (payment && payment !== "all") { conds.push("payment_status = ?"); params.push(payment); }

    // Por defecto no se muestran los pagos de MP pendientes (pedidos no confirmados)
    if (includePending !== "1") {
      conds.push("(payment_method != 'mercadopago' OR payment_status != 'pending')");
    }

    if (search) {
      conds.push("(order_number LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const totalRow = await db.prepare(`SELECT COUNT(*) AS n FROM orders ${where}`).get(...params);
    const total = totalRow.n;
    const rows = await db
      .prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    res.json({
      orders: rows.map(toPublicOrder),
      total,
      page,
      limit,
      hasMore: offset + rows.length < total,
    });
  } catch (err) {
    console.error("GET /api/admin/orders:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.get("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
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
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
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

    // 3 consultas independientes en un solo round-trip de lectura
    const results = await db.batch(
      [
        {
          sql: `SELECT branch, total FROM orders
         WHERE payment_status = 'approved' AND status != 'cancelled'
           AND created_at >= ? AND created_at <= ?`,
          args: [fromIso, toIso],
        },
        {
          sql: "SELECT type, COUNT(*) AS n FROM events WHERE created_at >= ? AND created_at <= ? GROUP BY type",
          args: [fromIso, toIso],
        },
        {
          sql: "SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE type = 'page_view' AND visitor_id IS NOT NULL AND created_at >= ? AND created_at <= ?",
          args: [fromIso, toIso],
        },
        {
          sql: `SELECT items FROM orders
         WHERE payment_status = 'approved' AND status != 'cancelled'
           AND created_at >= ? AND created_at <= ?`,
          args: [fromIso, toIso],
        },
      ],
      "read"
    );
    const confirmed = results[0].rows;
    const eventRows = results[1].rows;
    const visitantes = Number((results[2].rows[0] || {}).n || 0);
    const confirmedItems = results[3].rows;

    let ventaNeta = 0;
    let ventaNecochea = 0;
    let ventaTandil = 0;
    for (const o of confirmed) {
      ventaNeta += o.total;
      if (o.branch === "necochea") ventaNecochea += o.total;
      if (o.branch === "tandil") ventaTandil += o.total;
    }
    const pedidos = confirmed.length;
    const ticketPromedio = pedidos > 0 ? Math.round(ventaNeta / pedidos) : 0;

    // Conteo de eventos en el período (fila de los eventos viene del batch)
    const counts = { page_view: 0, product_view: 0, checkout_started: 0, order_created: 0 };
    for (const row of eventRows) {
      if (row.type in counts) counts[row.type] = row.n;
    }

    const visitas = visitantes;
    const pageViews = counts.page_view || 0;
    const productosVistos = counts.product_view || 0;
    const checkouts = counts.checkout_started || 0;
    const conversion = visitas > 0 ? Math.round((pedidos / visitas) * 1000) / 10 : 0;

    // Productos más vendidos (por cantidad) y que más facturan (netos, en $),
    // calculado a partir de los mismos pedidos confirmados del período.
    const productAgg = new Map(); // name -> { name, qty, revenue }
    for (const row of confirmedItems) {
      let items;
      try { items = JSON.parse(row.items); } catch { items = []; }
      for (const it of items) {
        const extrasTotal = (it.extras || []).reduce((a, e) => a + (e.price || 0), 0);
        const lineRevenue = (it.unitPrice + extrasTotal) * it.qty;
        const key = it.name || it.productId;
        const entry = productAgg.get(key) || { name: key, qty: 0, revenue: 0 };
        entry.qty += it.qty;
        entry.revenue += lineRevenue;
        productAgg.set(key, entry);
      }
    }
    const allProducts = Array.from(productAgg.values());
    const topSelling = [...allProducts].sort((a, b) => b.qty - a.qty).slice(0, 8);
    const topRevenue = [...allProducts].sort((a, b) => b.revenue - a.revenue).slice(0, 8);

    res.json({
      period: { from: fromIso, to: toIso },
      ventaNeta,
      ventaNecochea,
      ventaTandil,
      ticketPromedio,
      pedidos,
      checkouts,
      productosVistos,
      visitas,
      pageViews,
      conversion,
      topSelling,
      topRevenue,
    });
  } catch (err) {
    console.error("GET /api/admin/stats:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- clientes (agregado por teléfono) ----------
app.get("/api/admin/customers", requireAdmin, async (req, res) => {
  try {
    const { search, branch } = req.query;
    const conds = [];
    const params = [];
    if (branch) { conds.push("branch = ?"); params.push(branch); }
    if (search) {
      conds.push("(customer_name LIKE ? OR customer_phone LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    // Por cliente (teléfono): nombre y dirección más recientes, cantidad de
    // pedidos, gasto total y fecha del último pedido.
    const rows = await db
      .prepare(
        `SELECT
         customer_phone AS phone,
         customer_name AS name,
         address,
         branch,
         total,
         created_at
       FROM orders ${where}
       ORDER BY created_at DESC`
      )
      .all(...params);

    const byPhone = new Map();
    for (const r of rows) {
      const entry = byPhone.get(r.phone) || {
        phone: r.phone,
        name: r.name,
        address: "",
        branch: r.branch,
        ordersCount: 0,
        totalSpent: 0,
        lastOrderAt: r.created_at,
      };
      entry.ordersCount += 1;
      entry.totalSpent += r.total;
      if (!entry.address && r.address) entry.address = r.address;
      byPhone.set(r.phone, entry);
    }
    const customers = Array.from(byPhone.values()).sort(
      (a, b) => new Date(b.lastOrderAt) - new Date(a.lastOrderAt)
    );
    res.json({ customers, total: customers.length });
  } catch (err) {
    console.error("GET /api/admin/customers:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- ventas (panel admin: filtro de fecha + medios de pago) ----------
app.get("/api/admin/sales", requireAdmin, async (req, res) => {
  try {
    const { from, to, branch } = req.query;
    const defaultFrom = new Date(Date.now() - 30 * 86400000).toISOString();
    const fromIso = safeIso(from, defaultFrom);
    const toIso = safeIso(to, now());

    const conds = ["payment_status = 'approved'", "status != 'cancelled'", "created_at >= ?", "created_at <= ?"];
    const params = [fromIso, toIso];
    if (branch) { conds.push("branch = ?"); params.push(branch); }
    const where = `WHERE ${conds.join(" AND ")}`;

    const rows = await db.prepare(`SELECT payment_method, total, created_at FROM orders ${where}`).all(...params);

    let total = 0;
    const byMethod = {}; // method -> { count, total }
    const byDay = new Map(); // YYYY-MM-DD -> { date, count, total }
    for (const r of rows) {
      total += r.total;
      const m = byMethod[r.payment_method] || { method: r.payment_method, count: 0, total: 0 };
      m.count += 1;
      m.total += r.total;
      byMethod[r.payment_method] = m;

      const day = r.created_at.slice(0, 10);
      const d = byDay.get(day) || { date: day, count: 0, total: 0 };
      d.count += 1;
      d.total += r.total;
      byDay.set(day, d);
    }

    res.json({
      period: { from: fromIso, to: toIso },
      total,
      count: rows.length,
      average: rows.length > 0 ? Math.round(total / rows.length) : 0,
      byMethod: Object.values(byMethod).sort((a, b) => b.total - a.total),
      byDay: Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)),
    });
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
    const { branch } = req.query;
    if (!branch) return res.status(400).json({ error: "Falta la sucursal" });
    const results = await db.batch(
      [
        {
          sql: "SELECT * FROM cash_registers WHERE branch = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",
          args: [branch],
        },
        {
          sql: "SELECT * FROM cash_registers WHERE branch = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 30",
          args: [branch],
        },
      ],
      "read"
    );
    const open = results[0].rows[0] || null;
    const history = results[1].rows;

    let expectedNow = null;
    if (open) {
      const cashIncome = await db
        .prepare(
          `SELECT COALESCE(SUM(total), 0) AS s FROM orders
         WHERE branch = ? AND payment_method = 'efectivo' AND payment_status = 'approved'
           AND status != 'cancelled' AND created_at >= ?`
        )
        .get(branch, open.opened_at);
      expectedNow = open.opening_amount + cashIncome.s;
    }

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
    const { branch, openingAmount } = req.body || {};
    if (!branch) return res.status(400).json({ error: "Falta la sucursal" });
    const amount = Number(openingAmount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: "Monto inicial inválido" });
    const already = await db
      .prepare("SELECT id FROM cash_registers WHERE branch = ? AND closed_at IS NULL")
      .get(branch);
    if (already) return res.status(400).json({ error: "Ya hay una caja abierta en esta sucursal" });
    const info = await db
      .prepare(
        `INSERT INTO cash_registers (branch, opening_amount, opened_at, notes, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`
      )
      .run(branch, Math.round(amount), now(), now(), now());
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  } catch (err) {
    console.error("POST /api/admin/cash-register/open:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.post("/api/admin/cash-register/:id/close", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { closingCounted, notes } = req.body || {};
    const counted = Number(closingCounted);
    if (!Number.isFinite(counted) || counted < 0) return res.status(400).json({ error: "Monto contado inválido" });
    const row = await db.prepare("SELECT * FROM cash_registers WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Arqueo no encontrado" });
    if (row.closed_at) return res.status(400).json({ error: "Esta caja ya está cerrada" });

    const cashIncome = await db
      .prepare(
        `SELECT COALESCE(SUM(total), 0) AS s FROM orders
       WHERE branch = ? AND payment_method = 'efectivo' AND payment_status = 'approved'
         AND status != 'cancelled' AND created_at >= ?`
      )
      .get(row.branch, row.opened_at);
    const expected = row.opening_amount + cashIncome.s;
    const difference = Math.round(counted) - expected;

    await db.prepare(
      `UPDATE cash_registers
     SET closing_counted = ?, closed_at = ?, expected_amount = ?, difference = ?, notes = ?, updated_at = ?
     WHERE id = ?`
    ).run(Math.round(counted), now(), expected, difference, String(notes || "").slice(0, 500), now(), id);

    res.json({ ok: true, expected, difference });
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
    const result = await validateOrderBody(req.body);
    if (result.error) return res.status(400).json({ error: result.error });
    const { branch, customer, orderMode, paymentMethod, address, items, notes, total, discount, couponCode, scheduledFor, shipping } = result.data;

    const orderNumber = await nextOrderNumber();
    const ts = now();
    // INSERT del pedido + evento "order_created" en un solo batch atómico
    const results = await db.batch(
      [
        {
          sql: `INSERT INTO orders
          (order_number, branch, customer_name, customer_phone, address, order_mode,
           payment_method, payment_status, status, items, total, discount, coupon_code,
           scheduled_for, notes, source, shipping, shipping_km, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            orderNumber,
            branch,
            customer.name,
            customer.phone,
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
            ts,
            ts,
          ],
        },
        {
          sql: "INSERT INTO events (type, branch, created_at) VALUES (?, ?, ?)",
          args: ["order_created", branch, ts],
        },
      ],
      "write"
    );
    const info = results[0];
    res.json({ ok: true, orderId: Number(info.lastInsertRowid), orderNumber });
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
    const rows = await db
      .prepare(
        `SELECT p.* FROM products p
       LEFT JOIN categories c ON c.branch = p.branch AND c.category_id = p.category_id
       ORDER BY COALESCE(c.sort_order, 999999), p.sort_order`
      )
      .all();
    const grouped = {};
    for (const row of rows) {
      const p = productRowToAdmin(row);
      if (!grouped[p.branch]) {
        grouped[p.branch] = { branchId: p.branch, categories: [], _catIndex: new Map() };
      }
      const g = grouped[p.branch];
      if (!g._catIndex.has(p.categoryId)) {
        g._catIndex.set(p.categoryId, { id: p.categoryId, name: p.categoryName, groups: [] });
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
    if (image && !/^\/uploads\/products\/[\w.-]+\.(png|jpe?g|webp|gif)$/i.test(image)) {
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

app.post("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const { branch, ...rest } = req.body || {};
    if (typeof branch !== "string" || !branch.trim() || !/^[a-z0-9-_]+$/i.test(branch)) {
      return res.status(400).json({ error: "Sucursal inválida" });
    }
    // Si no se manda categoryId pero sí categoryName, se genera el slug
    if (!rest.categoryId && rest.categoryName) {
      rest.categoryId = slugify(rest.categoryName);
    }
    const validated = validateProductBody({ ...rest, categoryName: rest.categoryName || rest.categoryId });
    if (validated.error) return res.status(400).json({ error: validated.error });
    const data = validated.data;
    const branchId = branch.trim();
    const existingRow = await db
      .prepare("SELECT COUNT(*) AS n FROM products WHERE branch = ? AND category_id = ?")
      .get(branchId, data.categoryId);
    const existing = existingRow.n;
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
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await db.prepare("SELECT * FROM products WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Producto no encontrado" });
    const validated = validateProductBody(req.body);
    if (validated.error) return res.status(400).json({ error: validated.error });
    const data = validated.data;
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
    res.json({ ok: true, product: productRowToAdmin(updated) });
  } catch (err) {
    console.error("PUT /api/admin/products/:id:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.patch("/api/admin/products/:id/available", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await db.prepare("SELECT * FROM products WHERE id = ?").get(id);
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
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await db.prepare("SELECT * FROM products WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Producto no encontrado" });
    await db.prepare("DELETE FROM products WHERE id = ?").run(id);
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
    const id = Number(req.params.id);
    const dir = req.body?.dir === "down" ? "down" : "up";
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await db.prepare("SELECT * FROM products WHERE id = ?").get(id);
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
function catScope(req) {
  const branch = req.body?.branch;
  const categoryId = req.body?.categoryId;
  return typeof branch === "string" && typeof categoryId === "string" ? { branch, categoryId } : null;
}

app.post("/api/admin/categories", requireAdmin, async (req, res) => {
  try {
    const { branch, name } = req.body || {};
    if (typeof branch !== "string" || !/^[a-z0-9-_]+$/i.test(branch)) {
      return res.status(400).json({ error: "Sucursal inválida" });
    }
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
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
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
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Categoría no encontrada" });
    await db.prepare("DELETE FROM products WHERE branch = ? AND category_id = ?").run(row.branch, row.category_id);
    await db.prepare("DELETE FROM categories WHERE id = ?").run(id);
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
    const id = Number(req.params.id);
    const dir = req.body?.dir === "down" ? "down" : "up";
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
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
    await db.prepare("DELETE FROM products WHERE branch = ? AND category_id = ? AND group_name = ?").run(branch, categoryId, name);
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
  };
}

app.get("/api/admin/coupons", requireAdmin, async (req, res) => {
  try {
    const rows = await db.prepare("SELECT * FROM coupons ORDER BY id DESC").all();
    res.json({ coupons: rows.map(couponRowToAdmin) });
  } catch (err) {
    console.error("GET /api/admin/coupons:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.post("/api/admin/coupons", requireAdmin, async (req, res) => {
  try {
    const { code, type, value, minTotal, maxUses, active, expiresAt } = req.body || {};
    const cleanCode = String(code || "").trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,30}$/.test(cleanCode)) return res.status(400).json({ error: "Código de cupón inválido" });
    if (!["percent", "fixed"].includes(type)) return res.status(400).json({ error: "Tipo de cupón inválido" });
    const v = Number(value);
    if (!Number.isInteger(v) || v <= 0 || (type === "percent" && v > 100)) return res.status(400).json({ error: "Valor inválido" });
    const min = Math.max(0, Number(minTotal) || 0);
    const maxUsesNum = Math.max(0, Number(maxUses) || 0);
    if (await db.prepare("SELECT 1 FROM coupons WHERE code = ?").get(cleanCode)) {
      return res.status(400).json({ error: "El código ya existe" });
    }
    let expires = "";
    if (expiresAt) {
      const d = new Date(expiresAt);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "Fecha de vencimiento inválida" });
      expires = d.toISOString();
    }
    const ts = now();
    await db.prepare(
      "INSERT INTO coupons (code, type, value, min_total, active, max_uses, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(cleanCode, type, v, min, active === false ? 0 : 1, maxUsesNum, expires, ts, ts);
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/admin/coupons:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

app.patch("/api/admin/coupons/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await db.prepare("SELECT * FROM coupons WHERE id = ?").get(id);
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

app.delete("/api/admin/coupons/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID inválido" });
    const row = await db.prepare("SELECT * FROM coupons WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Cupón no encontrado" });
    await db.prepare("DELETE FROM coupons WHERE id = ?").run(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/admin/coupons/:id:", err.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ---------- imágenes de producto (upload) ----------
// Recibe un dataURL base64, valida formato y tamaño, y lo guarda en
// public/uploads/products/ (servido como /uploads/products/...).
app.post(
  "/api/admin/upload",
  requireAdmin,
  rateLimit({ max: 60, windowMs: 60000, name: "upload" }),
  (req, res) => {
    const { dataUrl } = req.body || {};
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
      return res.status(400).json({ error: "Imagen inválida" });
    }
    const m = dataUrl.match(/^data:image\/(png|jpeg|webp|gif);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: "Formato de imagen no soportado" });
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 1.5 * 1024 * 1024) return res.status(400).json({ error: "La imagen supera 1.5 MB" });
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const filename = `${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;
    writeFileSync(path.join(uploadsDir, filename), buf);
    res.json({ ok: true, url: `/uploads/products/${filename}` });
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
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (req.path.startsWith("/api")) return next();
  if (/\.[a-zA-Z0-9]{1,10}$/.test(req.path)) return next();
  const isSensitive = req.path.startsWith("/admin") || req.path.startsWith("/track/");
  if (isSensitive) res.setHeader("X-Robots-Tag", "noindex, follow");
  const canonicalPath =
    req.path === "/" && (req.query.branch === "necochea" || req.query.branch === "tandil")
      ? `/?branch=${req.query.branch}`
      : req.path;
  res.setHeader("Cache-Control", "no-cache, must-revalidate");
  res.send(
    enhanceHtml(indexTemplate(), {
      pathname: req.path,
      query: req.query || {},
      baseUrl: requestBaseUrl(req),
      canonicalPath,
    })
  );
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

// Fallback SPA de último recurso (rutas no-api que el static no sirvió)
app.get(/^(?!\/api).*/, (req, res) => {
  res.setHeader("Cache-Control", "no-cache, must-revalidate");
  res.sendFile(path.join(distDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`🌱 Fusión Wok API corriendo en http://localhost:${PORT}`);
  console.log(`   Modo demo: ${isDemoMode() ? "SÍ (sin credenciales reales)" : "NO (Mercado Pago real)"}`);
});