// ============================================================
// FUSIÓN WOK — Cálculo de envío por sucursal
// Regla comercial (misma para ambas sucursales):
//   - Las primeras FLAT_BLOCKS cuadras a la redonda del local: BASE_COST fijos.
//   - Cada cuadra extra: PER_BLOCK.
//   - Una cuadra ≈ BLOCK_METERS m (configurable por sucursal, 130 m por defecto).
//   0 cuadras (la dirección del propio local) también paga BASE_COST.
//   - Origen: dirección del local de cada sucursal (geocodificada o por env vars).
//     UN solo punto por sucursal sirve de origen y de centro del radio de búsqueda.
//   - Servicios 100% gratis, con respaldos para que una limitación
//     de tráfico (429) o una caída no deje sin envío:
//       1) Geocodificación: Georef Argentina API (datos.gob.ar) → respaldos
//          ORS (api.heigit.org), Nominatim, Photon.
//       2) Ruta por calles: OpenRouteService si ORS_API_KEY está seteada
//          → si no, OSRM → si falla, distancia en línea recta (factor ~1.25x).
//   - MAX_BLOCKS opcional por sucursal: si > 0, direcciones más allá se rechazan
//     como "fuera de zona".
//   - sanityRadiusKm: red de seguridad. Si el punto elegido queda a más de este
//     radio del origen de la sucursal, se trata como "no ubicada" (envío a
//     confirmar) en vez de calcular una distancia absurda. Valor 50 km.
//   - PRECISO: solo se cotiza a nivel address o interpolated. street o menos
//     => "no ubicada" (shipping_pending), salvo acceptStreetLevel=true.
// ============================================================

import { normalizeAddressKey } from "./utils/normalizeAddressKey.js";
import {
  getShippingSettings,
  onShippingSettingsSaved,
  DEFAULT_BLOCK_METERS,
  DEFAULT_SHIPPING,
  ROAD_FACTOR,
} from "./shipping-settings.js";

// Clave de OpenRouteService: se queda en .env (secreto). Nunca viaja a la BD
// ni a las respuestas de la API ni a los logs.
const ORS_KEY = (process.env.ORS_API_KEY || "").trim();
// ORS migró de api.openrouteservice.org (410 Gone) a api.heigit.org.
// Una constante por servicio, sin repetir URLs.
const ORS_GEOCODE_BASE = "https://api.heigit.org/pelias/v1"; // search / structured / reverse
const ORS_DIRECTIONS_BASE = "https://api.heigit.org/openrouteservice/v2/directions";

// Constante técnica (no editable desde el panel ni guardada en BD): se lee
// del entorno con fallback al valor de código, igual que antes.
function blockMetersFor(branch) {
  const upper = String(branch || "").toUpperCase();
  return (
    Number(
      process.env[`SHIPPING_BLOCK_METERS_${upper}`] ||
        process.env.SHIPPING_BLOCK_METERS ||
        DEFAULT_BLOCK_METERS[upper] ||
        130
    ) || 130
  );
}

// El origen es fijo: cacheamos 24 h (origen estable, sin vencimiento hasta
// que cambie la configuración o se reinicie el servidor).
const ORIGIN_TTL = 24 * 60 * 60 * 1000;
// Dirección → costo/cuadras: cacheamos 7 días (se repiten muchísimo).
const KM_TTL = 7 * 24 * 60 * 60 * 1000;

// Georef Argentina API - servicio oficial de datos.gob.ar
// Documentación: https://apis.datos.gob.ar/georef/api/
const GEOREF_BASE = "https://apis.datos.gob.ar/georef/api";
const GEOREF_TIMEOUT_MS = 8000;
// Lista explícita de campos válidos, tomada de la clave `ayuda` de la API
// (el valor anterior "estandar,nomenclatura,ubicacion" devuelve HTTP 400 c.1002).
const GEOREF_CAMPOS =
  "calle.nombre,altura.valor,nomenclatura,ubicacion.lat,ubicacion.lon," +
  "localidad_censal.nombre,departamento.nombre,provincia.nombre";

const GEO_REF_FOCUS_RADIUS_KM = 14;

// Resuelve la configuración efectiva de envío de una sucursal: BD (valor
// editado desde el panel) con caché de 30 s, o los valores de semilla
// (.env / código) como respaldo si la BD falla.
export async function getBranchConfig(db, branch) {
  return getShippingSettings(db, branch);
}

// Cuando la configuración se guarda desde el panel, invalidamos TODOS los
// cachés de esta sucursal (origen, cotizaciones, fallos) para que los próximos
// cálculos usen la nueva tarifa y parámetros.
onShippingSettingsSaved((branch) => {
  originCache.delete(branch);
  const prefix = `${branch.toLowerCase()}|`;
  for (const [k, v] of blockCache) if (k.startsWith(prefix)) blockCache.delete(k);
  for (const [k, v] of transientFailCache) if (k.startsWith(prefix)) transientFailCache.delete(k);
  for (const [k, v] of definitiveFailCache) if (k.startsWith(prefix)) definitiveFailCache.delete(k);
  for (const [k, v] of geoCache) if (k.startsWith(prefix)) geoCache.delete(k);
});
// Ante un fallo transitorio (429/caída) no volvemos a golpear el servicio
// por 90 s.
const DEFINITIVE_FAIL_TTL = 90 * 1000;
// Caché de geocodificación por sucursal + dirección normalizada: 24 h, máximo
// 500 entradas para que el Map no crezca sin límite.
const GEO_TTL = 24 * 60 * 60 * 1000;
const GEO_MAX_ENTRIES = 500;

const GEO_TIMEOUT_MS = 5000;
const USER_AGENT = "FusionWok/1.0 (+https://fusionwok.net)";

// Niveles de coincidencia de un geocodificador (de mayor a menor precisión).
// Solo address o interpolated generan precio.
const MATCH_LEVELS = ["address", "interpolated", "street", "locality", "region", "unknown"];
const LEVEL_PRIORITY = { address: 5, interpolated: 4, street: 3, locality: 2, region: 1, unknown: 0 };
function levelPriority(nivel) {
  return LEVEL_PRIORITY[nivel] ?? 0;
}
function esNivelPreciso(nivel) {
  return nivel === "address" || nivel === "interpolated";
}
function esNivelAceptable(nivel, acceptStreetLevel) {
  if (esNivelPreciso(nivel)) return true;
  return acceptStreetLevel === true && nivel === "street";
}

// Umbral de confianza mínimo para aceptar un resultado del geocodificador.
const MIN_CONFIDENCE = 0.7;

const blockCache = new Map(); // `${branch}|${addressKey}` → { blocks, cost, at }
const transientFailCache = new Map(); // `${branch}|${addressKey}` → { at } (15s)
const definitiveFailCache = new Map(); // `${branch}|${addressKey}` → { at, code } (90s)
// Origen estable por sucursal: se guarda en memoria SIN vencimiento hasta que
// cambie la configuración o se reinicie el servidor (invalidado por
// onShippingSettingsSaved).
const originCache = new Map(); // branch → { lat, lng, source, level, from }
const geoCache = new Map(); // `${branch}|${textoNormalizado}` → { coords, at }
const inFlight = new Map(); // `${branch}|${textoNormalizado}` → promesa en vuelo

const TRANSIENT_FAIL_TTL = 15000;
const DEADLINE_MS = 12000;

class ShippingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const transient = (m) => new ShippingError("transient", m);
const unknown = (m) => new ShippingError("unknown", m);
const zone = (m) => new ShippingError("zone", m);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const providerSuspendedUntil = new Map();
const PROVIDER_SUSPEND_MS = 10 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 5 * 1000;

function isProviderSuspended(name) {
  const until = providerSuspendedUntil.get(name);
  if (!until) return false;
  if (Date.now() < until) return true;
  providerSuspendedUntil.delete(name);
  return false;
}

function suspendProvider(name, ms = PROVIDER_SUSPEND_MS) {
  providerSuspendedUntil.set(name, Date.now() + ms);
}

let lastExternalCall = 0;
const MAX_EXTERNAL_QUEUE = 20;
let externalQueueLength = 0;
let externalQueue = Promise.resolve();
function throttled(fn) {
  if (externalQueueLength >= MAX_EXTERNAL_QUEUE) {
    return Promise.reject(transient("El servicio de envío está saturado. Volvé a intentar en unos segundos."));
  }
  externalQueueLength += 1;
  const run = externalQueue.then(async () => {
    try {
      const wait = Math.max(0, 1200 - (Date.now() - lastExternalCall));
      if (wait) await sleep(wait);
      lastExternalCall = Date.now();
      return await fn();
    } finally {
      externalQueueLength -= 1;
    }
  });
  externalQueue = run.catch(() => {});
  return run;
}

const fetchJson = async (url, options = {}) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), GEO_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "es",
        ...(options.headers || {}),
      },
      ...options,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      try {
        err.retryAfter = res.headers?.get?.("retry-after") || null;
      } catch {}
      throw err;
    }
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") {
      const e = new Error("timeout");
      e.type = "timeout";
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
};

function jitter(ms) {
  const j = ms * 0.5 * Math.random();
  return Math.round(ms - j + 2 * j);
}

const withRetry = async (fn, times = 1, opts = {}) => {
  let lastErr;
  const start = Date.now();
  const deadline = opts.deadline || Number.POSITIVE_INFINITY;
  for (let i = 0; i <= times; i++) {
    if (Date.now() > deadline) throw transient("No pudimos consultar el mapa. Volvé a intentar en unos segundos.");
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < times) {
        const base = 600 * (i + 1);
        let wait = jitter(base);
        if (Date.now() + wait > deadline) wait = Math.max(0, deadline - Date.now());
        if (wait > 0) await sleep(wait);
      }
    }
  }
  throw lastErr;
};

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- Normalización de direcciones (Necochea: calles numeradas) ----------
function extraerCruces(a) {
  const cruces = [];
  let t = String(a)
    .replace(/\b(entre\s+[^,;]+?\s+y\s+[^,;]+)\b/gi, (m) => {
      cruces.push(m.trim());
      return " ";
    })
    .replace(/\s+y\s+[^,;]+$/gi, (m) => {
      cruces.push(m.trim().slice(2));
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { texto: t, cruces };
}

export function normalizarTexto(a) {
  const { texto: t, cruces } = extraerCruces(a);
  let s = t
    .replace(/\b(n°|nº|nro|número|numero)\s*/gi, " ")
    .replace(/\bav\.\s*/gi, "av. ")
    .replace(/\s+/g, " ")
    .trim();
  const calleAltura = /^(\d{1,3})\s+(\d{1,5})$/;
  const m = s.match(calleAltura);
  if (m) {
    s = `Calle ${m[1]} ${m[2]}`;
  }
  return { texto: s, cruces };
}

// Extrae el nombre de calle de la dirección pedida (sin el número de altura,
// sin cruces, sin abreviaturas) para validar que el candidato coincida (paso 3c).
// Quita solo la altura final (último número): "Calle 5 678" → "Calle 5".
export function extraerCallePedida(a) {
  const { texto } = normalizarTexto(a);
  const sinAltura = texto.replace(/\s*\d{1,5}\s*$/, "").trim();
  return sinAltura.replace(/\s+/g, " ").trim();
}

// Genera variantes de consulta para un mismo domicilio, priorizando la
// dirección completa con ciudad/región/país y desechando cruces ("y ...") del
// texto geocodificado (los cruces van a las notas del pedido). Devuelve
// [{ texto, tipo }]. (paso 7: direcciones con cruces e intersecciones)
export function buildVariants(address, cfg = {}) {
  const { texto, cruces } = normalizarTexto(address);
  const ciudad = (cfg.city || "").trim();
  const region = (cfg.region || "").trim();
  const country = (cfg.country || "").trim();
  const sufijo = [ciudad, region, country].filter(Boolean).join(", ");
  const principalTexto = sufijo ? `${texto}${texto ? ", " : ""}${sufijo}` : texto;
  const variantes = [{ texto: principalTexto, tipo: "principal" }];
  if (cruces.length) {
    variantes.push({ texto: texto, tipo: "calle_solo" });
    variantes.push({ texto: cruces.join(" y "), tipo: "cruce" });
  }
  return variantes;
}

// Normaliza un nombre de calle para comparar (minúsculas, sin tildes, sin
// abreviaturas tipo calle/av./diagonal/int.).
function normalizarCalle(c) {
  if (c == null) return "";
  return String(c)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\b(calle|av\.|avenida|diagonal|int\.|intendente)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = [];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev.length = 0;
    prev.push(...curr);
  }
  return prev[n];
}

// ¿Dos nombres de calle se refieren a la misma calle? Tolera un error de
// tipeo corto cuando los nombres son lo bastante largos.
function callesCoinciden(callePedida, calleCandidato) {
  const a = normalizarCalle(callePedida);
  const b = normalizarCalle(calleCandidato);
  if (!a || !b) return false;
  if (a === b) return true;
  const menor = Math.min(a.length, b.length);
  const mayor = Math.max(a.length, b.length);
  if (menor < 3) return false;
  const dist = levenshtein(a, b);
  return dist <= 1 && dist / mayor <= 0.25;
}

// ¿La localidad del candidato coincide con la ciudad de la sucursal
// (usando sinónimos configurables, p. ej. Quequén para Necochea)? (paso 3d)
function localidadCoincide(ciudadCandidato, cfg) {
  const expected = (cfg.city || "").toLowerCase();
  const sinonimos = (cfg.localidadSinonimos || []).map((s) => String(s).toLowerCase());
  const c = (ciudadCandidato || "").toLowerCase();
  if (!c || !expected) return false;
  if (c === expected) return true;
  return sinonimos.includes(c);
}

// ---------- Normalizador único de candidatos (paso 3a) ----------
// {lat, lng, provider, matchLevel, confidence, city, road, houseNumber, label, locality, region, country}
function normalizarCandidato(provider, raw) {
  const out = {
    lat: null,
    lng: null,
    provider,
    matchLevel: "unknown",
    confidence: 0,
    city: "",
    road: "",
    houseNumber: "",
    label: "",
    locality: "",
    region: "",
    country: "",
  };

  if (provider === "georef") {
    const ubic = raw.ubicacion || {};
    out.lat = raw.ubicacion_lat != null ? Number(raw.ubicacion_lat) : ubic.lat != null ? Number(ubic.lat) : null;
    out.lng =
      raw.ubicacion_lon != null ? Number(raw.ubicacion_lon) : ubic.lon != null ? Number(ubic.lon) : null;
    out.road = raw.calle_nombre || (raw.calle && raw.calle.nombre) || "";
    out.houseNumber =
      raw.altura_valor != null ? String(raw.altura_valor) : raw.altura && raw.altura.valor != null ? String(raw.altura.valor) : "";
    out.city =
      raw.localidad_censal_nombre ||
      (raw.localidad && raw.localidad.nombre) ||
      raw.departamento_nombre ||
      (raw.departamento && raw.departamento.nombre) ||
      "";
    out.locality = out.city;
    out.region = raw.provincia_nombre || (raw.provincia && raw.provincia.nombre) || "";
    out.country = "Argentina";
    out.label = raw.nomenclatura || out.road || raw.nombre || "";
    out.confidence = 1.0;
    // Georef: altura presente => address; solo calle => street.
    if (out.houseNumber) out.matchLevel = "address";
    else if (out.road) out.matchLevel = "street";
    return out;
  }

  if (provider === "ors" || provider === "ors-structured") {
    const props = raw.properties || {};
    const coords = raw.geometry && raw.geometry.coordinates;
    out.lat = coords && coords.length >= 2 ? Number(coords[1]) : null;
    out.lng = coords && coords.length >= 2 ? Number(coords[0]) : null;
    const addr = props.address || {};
    out.road = addr.street || props.street || "";
    out.houseNumber = addr.number || props.housenumber || "";
    out.city = props.locality || "";
    out.locality = props.locality || "";
    out.region = props.region || props.state || "";
    out.country = props.country || "";
    out.label = props.label || "";
    out.confidence = Number(props.confidence) || 0;
    const layer = String(props.layer || "").toLowerCase();
    if (["address", "venue", "house", "building", "entrance"].includes(layer)) out.matchLevel = "address";
    else if (["street", "intersection"].includes(layer)) out.matchLevel = "street";
    else if (["locality", "suburb", "neighbourhood", "borough", "district", "municipality"].includes(layer)) out.matchLevel = "locality";
    else if (["region", "state", "county"].includes(layer)) out.matchLevel = "region";
    return out;
  }

  if (provider === "photon") {
    const props = raw.properties || {};
    const coords = raw.geometry && raw.geometry.coordinates;
    out.lat = coords && coords.length >= 2 ? Number(coords[1]) : null;
    out.lng = coords && coords.length >= 2 ? Number(coords[0]) : null;
    out.road = props.street || "";
    out.houseNumber = props.housenumber || "";
    out.city = props.city || "";
    out.locality = props.city || "";
    out.region = props.state || "";
    out.country = props.country || "";
    out.label = props.name || props.label || "";
    out.confidence = Number(props.confidence) || 0;
    const type = String(props.type || "").toLowerCase();
    const osm = String(props.osm_value || "").toLowerCase();
    if (osm === "house" || type === "house" || props.housenumber) out.matchLevel = "address";
    else if (["street", "road", "highway", "path"].includes(type) || osm === "street") out.matchLevel = "street";
    else if (["city", "town", "village", "suburb", "borough", "district", "municipality"].includes(type)) out.matchLevel = "locality";
    else if (["state", "region", "county"].includes(type)) out.matchLevel = "region";
    return out;
  }

  if (provider === "nominatim") {
    const addr = raw.address || {};
    out.lat = raw.lat != null ? Number(raw.lat) : null;
    out.lng = raw.lon != null ? Number(raw.lon) : null;
    out.road = raw.road || "";
    out.houseNumber = raw.house_number || "";
    out.city = addr.city || addr.town || addr.village || "";
    out.locality = out.city;
    out.region = addr.state || addr.region || "";
    out.country = addr.country || "";
    out.label = raw.display_name || "";
    out.confidence = Number(raw.importance) || 0;
    const at = String(raw.addresstype || "").toLowerCase();
    const cls = String(raw.class || "").toLowerCase();
    const typ = String(raw.type || "").toLowerCase();
    if (raw.house_number || ["house", "building"].includes(at) || cls === "building") out.matchLevel = "address";
    else if (cls === "highway" || typ === "street" || typ === "road" || raw.road) out.matchLevel = "street";
    else if (
      ["locality", "suburb", "neighbourhood", "borough", "district", "municipality", "city", "town", "village"].includes(at)
    )
      out.matchLevel = "locality";
    else if (["state", "region", "county", "country"].includes(at)) out.matchLevel = "region";
    return out;
  }

  return out;
}

// Valida un candidato contra lo pedido: localidad, nombre de calle y nivel.
// devuelve { ok, motivo, nivel } (paso 3b, 3c, 3d).
function validarCandidato(c, cfg, callePedida, acceptStreetLevel) {
  if (!c) return { ok: false, motivo: "sin_candidato", nivel: "unknown" };
  if (!esNivelAceptable(c.matchLevel, acceptStreetLevel)) {
    return { ok: false, motivo: `nivel_${c.matchLevel}`, nivel: c.matchLevel };
  }
  // Localidad: ciudad del candidato == ciudad de la sucursal (con sinónimos).
  if (!localidadCoincide(c.city, cfg)) {
    return { ok: false, motivo: `localidad_${c.city || "desconocida"}`, nivel: c.matchLevel };
  }
  // Nombre de calle: si el candidato trae calle, debe coincidir con la pedida.
  if (c.road && callePedida && !callesCoinciden(callePedida, c.road)) {
    return { ok: false, motivo: `calle_${c.road}`, nivel: c.matchLevel };
  }
  return { ok: true, motivo: "ok", nivel: c.matchLevel };
}

// Valida que un punto esté dentro del radio de sanity de la sucursal, usando
// `ancla` (origen estable) como centro cuando se provee, o cfg.center como fallback.
function dentroDelRadio(cfg, c, ancla) {
  if (c.lat < -90 || c.lat > 90 || c.lng < -180 || c.lng > 180) return false;
  const centro = ancla || cfg.center;
  return haversineKm(centro, c) <= cfg.sanityRadiusKm;
}

// ---------- Caché de geocodificación ----------
function geoCacheKey(branch, textoNormalizado) {
  return `${branch}|${textoNormalizado}`;
}

function geoCacheGet(branch, textoNormalizado) {
  const k = geoCacheKey(branch, textoNormalizado);
  const c = geoCache.get(k);
  if (c && Date.now() - c.at < GEO_TTL) return c.coords;
  if (c) geoCache.delete(k);
  return null;
}

function geoCacheSet(branch, textoNormalizado, coords) {
  const k = geoCacheKey(branch, textoNormalizado);
  if (geoCache.size >= GEO_MAX_ENTRIES) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [kk, vv] of geoCache) {
      if (vv.at < oldestAt) {
        oldestAt = vv.at;
        oldestKey = kk;
      }
    }
    if (oldestKey) geoCache.delete(oldestKey);
  }
  geoCache.set(k, { coords, at: Date.now() });
}

// ---------- Geocodificadores ----------

// Georef Argentina API (datos.gob.ar) - primario para todas las sucursales.
// Campo `campos` con lista explícita válida (lista `ayuda` de la API).
async function geocodeGeoref(query, cfg, opts = {}) {
  const ancla = opts.ancla || cfg.center;
  const deadline = opts.deadline || Date.now() + GEOREF_TIMEOUT_MS;
  try {
    const params = new URLSearchParams();
    params.set("direccion", query);
    params.set("provincia", "Buenos Aires");
    if (cfg.city) params.set("departamento", cfg.city);
    params.set("max", "5");
    params.set("campos", GEOREF_CAMPOS);
    params.set("aplanar", "true");

    const url = `${GEOREF_BASE}/direcciones?${params.toString()}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GEOREF_TIMEOUT_MS);
    const j = await fetchJson(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    const resultados = j?.direcciones || [];
    const expectedCity = (cfg.city || "").toLowerCase();
    const mejores = [];
    for (const dir of resultados) {
      const c = normalizarCandidato("georef", dir);
      if (c.lat == null || c.lng == null) continue;
      // Ciudad válida (con sinónimos) y dentro del radio de sanity.
      if (!localidadCoincide(c.city, cfg)) continue;
      if (!dentroDelRadio(cfg, c, ancla)) continue;
      mejores.push(c);
    }
    if (!mejores.length) return null;
    // Quedarse con el de mayor nivel de coincidencia.
    mejores.sort((a, b) => levelPriority(b.matchLevel) - levelPriority(a.matchLevel));
    return mejores[0];
  } catch (err) {
    if (err.name === "AbortError" || err.type === "timeout") {
      console.warn(`shipping georef timeout`);
      throw err;
    }
    console.warn(`shipping georef error: ${err.message}`);
    throw err;
  }
}

// OpenRouteService / Pelias como RESPALDO (solo si Georef falla).
// boundary.circle es un BIAS centrado en el origen estable, no filtro duro.
async function geocodeOrs(query, cfg, opts = {}) {
  if (!ORS_KEY) return null;
  const ancla = opts.ancla || cfg.center;
  const deadline = opts.deadline || Date.now() + GEOREF_TIMEOUT_MS;
  const params = new URLSearchParams();
  params.set("text", query);
  params.set("focus.point.lat", String(ancla.lat));
  params.set("focus.point.lon", String(ancla.lng));
  params.set("boundary.circle.lat", String(ancla.lat));
  params.set("boundary.circle.lon", String(ancla.lng));
  params.set("boundary.circle.radius", String(cfg.searchRadiusKm || GEO_REF_FOCUS_RADIUS_KM));
  params.set("boundary.country", "AR");
  params.set("size", "5");
  const url = `${ORS_GEOCODE_BASE}/search?api_key=${encodeURIComponent(ORS_KEY)}&${params.toString()}`;
  try {
    const j = await fetchJson(url, { deadline });
    const features = j && j.features ? j.features : [];
    const mejores = [];
    for (const f of features) {
      const c = normalizarCandidato("ors", f);
      if (c.lat == null || c.lng == null) continue;
      if (!Number.isFinite(c.confidence) || c.confidence < MIN_CONFIDENCE) continue;
      if (!localidadCoincide(c.city, cfg)) continue;
      if (!dentroDelRadio(cfg, c, ancla)) continue;
      mejores.push(c);
    }
    if (!mejores.length) return null;
    mejores.sort((a, b) => levelPriority(b.matchLevel) - levelPriority(a.matchLevel));
    return mejores[0];
  } catch (err) {
    if (err.name === "AbortError" || err.type === "timeout") throw err;
    const st = err.status;
    if (st === 401 || st === 403) suspendProvider("ors");
    throw err;
  }
}

// Búsqueda estructurada de Pelias (/geocode/search/structured) para intersecciones
// o avenidas sin altura (p. ej. "Av. 59 y 10").
async function geocodeOrsStructured(address, locality, region, country, cfg, opts = {}) {
  if (!ORS_KEY) return null;
  const ancla = opts.ancla || cfg.center;
  const params = new URLSearchParams();
  if (address) params.set("address", address);
  if (locality) params.set("locality", locality);
  if (region) params.set("region", region);
  if (country) params.set("country", country);
  params.set("focus.point.lat", String(ancla.lat));
  params.set("focus.point.lon", String(ancla.lng));
  params.set("boundary.circle.lat", String(ancla.lat));
  params.set("boundary.circle.lon", String(ancla.lng));
  params.set("boundary.circle.radius", String(cfg.searchRadiusKm || GEO_REF_FOCUS_RADIUS_KM));
  params.set("boundary.country", "AR");
  params.set("size", "5");
  const url = `${ORS_GEOCODE_BASE}/search/structured?api_key=${encodeURIComponent(ORS_KEY)}&${params.toString()}`;
  try {
    const j = await fetchJson(url);
    const features = j && j.features ? j.features : [];
    const mejores = [];
    for (const f of features) {
      const c = normalizarCandidato("ors-structured", f);
      if (c.lat == null || c.lng == null) continue;
      if (!Number.isFinite(c.confidence) || c.confidence < MIN_CONFIDENCE) continue;
      if (!localidadCoincide(c.city, cfg)) continue;
      if (!dentroDelRadio(cfg, c, ancla)) continue;
      mejores.push(c);
    }
    if (!mejores.length) return null;
    mejores.sort((a, b) => levelPriority(b.matchLevel) - levelPriority(a.matchLevel));
    return mejores[0];
  } catch (err) {
    if (err.name === "AbortError" || err.type === "timeout") throw err;
    const st = err.status;
    if (st === 401 || st === 403) suspendProvider("ors");
    throw err;
  }
}

// Geocodificadores gratuitos (respaldos): Nominatim → Photon.
const GEO_PROVIDERS = [
  {
    name: "nominatim",
    fn: async (q, opts = {}) => {
      if (isProviderSuspended("nominatim")) {
        const e = new Error("provider suspended");
        e.provider = "nominatim";
        e.suspended = true;
        throw e;
      }
      const ancla = opts.ancla || { lat: -38.5670514, lng: -58.7293811 };
      // Pelias-style bounded query para limitar a la zona de la sucursal.
      const bounded = `${q}, ${ancla.lat.toFixed(4)},${ancla.lng.toFixed(4)}`;
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&addressdetails=1&q=${encodeURIComponent(bounded)}`;
      try {
        const j = await fetchJson(url);
        const hits = Array.isArray(j) ? j : [];
        const mejores = [];
        for (const hit of hits) {
          if (hit.lat == null || hit.lon == null) continue;
          const c = normalizarCandidato("nominatim", hit);
          if (c.lat == null || c.lng == null) continue;
          if (!localidadCoincide(c.city, { city: "" })) {
            // Nominatim ya filtra por localidad via bounded; aceptamos si tiene city.
          }
          mejores.push(c);
        }
        if (!mejores.length) return null;
        mejores.sort((a, b) => levelPriority(b.matchLevel) - levelPriority(a.matchLevel));
        return mejores[0];
      } catch (err) {
        if (err.type === "timeout" || err.name === "AbortError") throw err;
        const status = err.status || (typeof err.message === "string" && err.message.match(/HTTP (\d+)/)?.[1]);
        const st = status ? Number(status) : null;
        if (st === 401 || st === 403) { suspendProvider("nominatim"); throw err; }
        if (st === 429) {
          let wait = 0;
          try { if (err.retryAfter) wait = Math.min(Number(err.retryAfter) * 1000, MAX_RETRY_AFTER_MS); } catch {}
          if (wait > 0) {
            const e = new Error("rate limited"); e.status = 429; e.retryAfterMs = wait; throw e;
          }
          suspendProvider("nominatim");
          throw err;
        }
        throw err;
      }
    },
  },
  {
    name: "photon",
    fn: async (q, opts = {}) => {
      if (isProviderSuspended("photon")) {
        const e = new Error("provider suspended");
        e.provider = "photon";
        e.suspended = true;
        throw e;
      }
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5`;
      try {
        const j = await fetchJson(url);
        const feats = j?.features || [];
        const mejores = [];
        for (const feat of feats) {
          const c = normalizarCandidato("photon", feat);
          if (c.lat == null || c.lng == null) continue;
          mejores.push(c);
        }
        if (!mejores.length) return null;
        mejores.sort((a, b) => levelPriority(b.matchLevel) - levelPriority(a.matchLevel));
        return mejores[0];
      } catch (err) {
        if (err.type === "timeout" || err.name === "AbortError") throw err;
        const status = err.status || (typeof err.message === "string" && err.message.match(/HTTP (\d+)/)?.[1]);
        const st = status ? Number(status) : null;
        if (st === 401 || st === 403) { suspendProvider("photon"); throw err; }
        if (st === 429) {
          let wait = 0;
          try { if (err.retryAfter) wait = Math.min(Number(err.retryAfter) * 1000, MAX_RETRY_AFTER_MS); } catch {}
          if (wait > 0) {
            const e = new Error("rate limited"); e.status = 429; e.retryAfterMs = wait; throw e;
          }
          suspendProvider("photon");
          throw err;
        }
        throw err;
      }
    },
  },
];

// Extrae la ciudad/localidad del resultado (ya normalizada en c.city).
function ciudadValida(cfg, c) {
  if (!c || !c.address) return false;
  const addr = c.address;
  const candidatos = [addr.city, addr.town, addr.village, addr.municipality]
    .filter(Boolean)
    .map(String)
    .map((s) => s.toLowerCase());
  const expected = (cfg.city || "").toLowerCase();
  if (!expected) return false;
  return candidatos.some((cand) => cand === expected);
}

// ---------- Origen estable (paso 4) ----------
// Un solo punto por sucursal que sirve de origen y de centro del radio.
// Si origin_lat/origen_lng existen, se usan tal cual. Si no, se geocodifica
// la dirección del origen una sola vez con nivel address, se guarda en memoria
// sin vencimiento hasta que cambie la configuración o se reinicie el servidor,
// y se loguea UNA vez la fuente y el nivel (sin coordenadas).
async function getOrigin(cfg, opts = {}) {
  const branch = cfg.city;
  if (cfg.originLat != null && cfg.originLng != null) {
    const lat = Number(cfg.originLat);
    const lng = Number(cfg.originLng);
    // Heurística Argentina: lat -56 a -21, lng -74 a -53.
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && lat >= -56 && lat <= -21 && lng >= -74 && lng <= -53) {
      return { lat, lng, source: "config", level: "address", from: "originLatLng" };
    }
    console.warn(`${branch}: origen.lat/lng inválidos, se ignoran`);
  }
  const cached = originCache.get(branch);
  if (cached) return cached;
  if (!cfg.originAddress || !cfg.originAddress.trim()) {
    const fallback = { lat: cfg.center.lat, lng: cfg.center.lng, source: "center", level: "unknown", from: "center" };
    originCache.set(branch, fallback);
    return fallback;
  }
  // Geocodificar la dirección del origen una sola vez, exigiendo nivel address.
  // Si no se puede geocodificar (Georef caído, timeout, sin respaldos), se usa
  // el centro de la sucursal como origen de fallback para que la sucursal siga
  // operando en vez de quedar bloqueada por completo.
  const o = await geocodeConMinNivel(cfg.originAddress, cfg, "address", opts);
  let resultado;
  if (!o) {
    console.warn(`${branch}: origen no geocodificado, usando centro como fallback`);
    resultado = { lat: cfg.center.lat, lng: cfg.center.lng, source: "center", level: "unknown", from: "center-fallback" };
  } else {
    resultado = { lat: o.lat, lng: o.lng, source: o.provider, level: o.matchLevel, from: "geocode" };
    console.log(`shipping origin ${branch}: fuente=${resultado.source} nivel=${resultado.level}`);
  }
  originCache.set(branch, resultado);
  return resultado;
}

// Geocode que exige un nivel mínimo (para el origen).
async function geocodeConMinNivel(query, cfg, minNivel, opts = {}) {
  const c = await geocode(query, cfg, opts);
  if (!c) return null;
  if (minNivel === "address" && !esNivelPreciso(c.matchLevel)) return null;
  return c;
}

// ---------- Geocodificación principal ----------
// Geocodifica usando Georef (primario) con respaldos. Devuelve el mejor
// candidato normalizado que pase localidad + radio de sanity, priorizando
// address/interpolated. No devuelve dirección ni coordenadas en los logs.
export async function geocode(query, cfg, opts = {}) {
  const deadline = opts.deadline || Date.now() + GEO_TIMEOUT_MS * 20;
  const ancla = opts.ancla || cfg.center;
  const textoNormalizado = normalizarTexto(query).texto;
  const cacheKey = `${cfg.city}|${textoNormalizado}`;

  const enVuelo = inFlight.get(cacheKey);
  if (enVuelo) return enVuelo;

  const promesa = (async () => {
    const cacheado = geoCacheGet(cfg.city, textoNormalizado);
    if (cacheado) return cacheado;

    let resultado = null;
    let mejorSinPrecision = null; // mejor candidato no-preciso (street/locality) como referencia
    let sawTransient = false;

    // Intenta proveedores en orden, quedándose con el mejor nivel de coincidencia.
    // Si encuentra address/interpolated válido, lo devuelve inmediatamente.
    const intentar = async (nombre, fn) => {
      if (Date.now() > deadline) throw transient("No pudimos consultar el mapa. Volvé a intentar en unos segundos.");
      try {
        const c = await fn();
        if (!c) return null;
        if (!dentroDelRadio(cfg, c, ancla)) return null;
        if (esNivelPreciso(c.matchLevel)) {
          resultado = c;
          return c;
        }
        if (!mejorSinPrecision || levelPriority(c.matchLevel) > levelPriority(mejorSinPrecision.matchLevel)) {
          mejorSinPrecision = c;
        }
        return null;
      } catch (err) {
        if (err.name === "AbortError" || err.type === "timeout") sawTransient = true;
        if (err.suspended) return null;
        throw err;
      }
    };

    // 1) Georef Argentina API - PRIMARIO para TODAS las sucursales
    if (isProviderSuspended("georef")) {
      // continuar a respaldos
    } else {
      try {
        const r = await intentar("georef", () => geocodeGeoref(query, cfg, { ancla, deadline }));
        if (r) { geoCacheSet(cfg.city, textoNormalizado, r); inFlight.delete(cacheKey); return r; }
      } catch (err) {
        if (err.name !== "AbortError" && err.type !== "timeout" && !err.suspended) {
          console.warn(`shipping georef fallback: ${err.message}`);
        }
        if (err.name === "AbortError" || err.type === "timeout") sawTransient = true;
        const status = err.status;
        if (status === 403) suspendProvider("georef");
        else if (status === 429) {
          console.warn(`shipping provider fail: georef HTTP 429`);
          let wait = 2000;
          try { if (err.retryAfter) wait = Math.min(Number(err.retryAfter) * 1000, MAX_RETRY_AFTER_MS); } catch {}
          await sleep(Math.min(wait, MAX_RETRY_AFTER_MS));
          try {
            if (!isProviderSuspended("georef")) {
              const r2 = await geocodeGeoref(query, cfg, { ancla, deadline });
              if (r2 && dentroDelRadio(cfg, r2, ancla) && esNivelPreciso(r2.matchLevel)) {
                resultado = r2;
                geoCacheSet(cfg.city, textoNormalizado, r2);
                inFlight.delete(cacheKey);
                return r2;
              }
              if (r2 && (!mejorSinPrecision || levelPriority(r2.matchLevel) > levelPriority(mejorSinPrecision.matchLevel))) {
                mejorSinPrecision = r2;
              }
            }
          } catch (retryErr) {
            const retryStatus = retryErr.status;
            if (retryStatus === 429 || retryStatus === 403) suspendProvider("georef");
            if (retryErr.name !== "AbortError" && retryErr.type !== "timeout") console.warn(`shipping georef fallback (retry): ${retryErr.message}`);
          }
        }
      }
    }

    // 2) ORS Pelias como RESPALDO (solo si hay key)
    if (ORS_KEY && !resultado && Date.now() <= deadline) {
      try {
        const r = await intentar("ors", () => geocodeOrs(query, cfg, { ancla, deadline }));
        if (r) { geoCacheSet(cfg.city, textoNormalizado, r); inFlight.delete(cacheKey); return r; }
      } catch (err) {
        if (err.name === "AbortError" || err.type === "timeout") sawTransient = true;
      }
    }

    // 3) Búsqueda estructurada ORS para intersecciones (respaldos)
    const { cruces } = normalizarTexto(query);
    if (cruces.length && ORS_KEY && !resultado && Date.now() <= deadline) {
      const partes = cruces[0].split(/\s+y\s+/i);
      if (partes.length >= 2) {
        try {
          const r = await geocodeOrsStructured(
            partes[0].trim(),
            cfg.city,
            cfg.region,
            cfg.country,
            cfg,
            { ancla, deadline }
          );
          if (r && dentroDelRadio(cfg, r, ancla)) {
            resultado = r;
            geoCacheSet(cfg.city, textoNormalizado, r);
            inFlight.delete(cacheKey);
            return r;
          }
          if (r && (!mejorSinPrecision || levelPriority(r.matchLevel) > levelPriority(mejorSinPrecision.matchLevel))) {
            mejorSinPrecision = r;
          }
        } catch (err) {
          if (err.name === "AbortError" || err.type === "timeout") sawTransient = true;
        }
      }
    }

    // 4) Variantes ORS (respaldos)
    if (ORS_KEY && !resultado && Date.now() <= deadline) {
      const variantes = buildVariants(query, cfg);
      for (const v of variantes) {
        if (Date.now() > deadline) break;
        try {
          const r = await intentar(`ors:${v.tipo}`, () => geocodeOrs(v.texto, cfg, { ancla, deadline }));
          if (r) { geoCacheSet(cfg.city, textoNormalizado, r); inFlight.delete(cacheKey); return r; }
        } catch (err) {
          if (err.name === "AbortError" || err.type === "timeout") sawTransient = true;
        }
      }
    }

    // 5) Respaldos Nominatim → Photon (último recurso)
    const variantesParaRespaldo = buildVariants(query, cfg);
    for (const p of GEO_PROVIDERS) {
      if (Date.now() > deadline) break;
      for (const v of variantesParaRespaldo) {
        if (Date.now() > deadline) break;
        try {
          const c = await p.fn(v.texto, { ancla, deadline });
          if (c && dentroDelRadio(cfg, c, ancla)) {
            // Para gratis, validar ciudad (Nominatim/Photon no filtran fuerte).
            if (!localidadCoincide(c.city, cfg)) continue;
            if (esNivelPreciso(c.matchLevel)) {
              resultado = c;
              geoCacheSet(cfg.city, textoNormalizado, c);
              inFlight.delete(cacheKey);
              return c;
            }
            if (!mejorSinPrecision || levelPriority(c.matchLevel) > levelPriority(mejorSinPrecision.matchLevel)) {
              mejorSinPrecision = c;
            }
          }
        } catch (err) {
          if (err.type === "timeout" || err.name === "AbortError") continue;
          const st = err.status;
          if (st === 429 && err.retryAfterMs) {
            if (err.retryAfterMs > 0) await sleep(Math.min(err.retryAfterMs, MAX_RETRY_AFTER_MS));
            continue;
          }
          if (st === 401 || st === 403) continue;
          sawTransient = true;
          continue;
        }
      }
    }

    // No se encontró nada válido dentro del radio.
    if (resultado) {
      geoCacheSet(cfg.city, textoNormalizado, resultado);
      inFlight.delete(cacheKey);
      return resultado;
    }
    // No cacheamos mejorSinPrecision (street/locality/region) como definitivo:
    // una consulta posterior podría encontrar address/interpolated en otro proveedor.
    if (mejorSinPrecision) {
      inFlight.delete(cacheKey);
      return mejorSinPrecision;
    }
    if (sawTransient) throw transient("No pudimos consultar el mapa. Volvé a intentar en unos segundos.");
    geoCacheSet(cfg.city, textoNormalizado, null);
    inFlight.delete(cacheKey);
    return null;
  })();

  inFlight.set(cacheKey, promesa);
  try {
    return await promesa;
  } finally {
    inFlight.delete(cacheKey);
  }
}

// ---------- Distancia por calles ----------
// Orden: OpenRouteService (si hay key) → OSRM → línea recta como red de seguridad.
async function roadDistanceKm(from, to, opts = {}) {
  const deadline = opts.deadline || Date.now() + DEADLINE_MS;
  if (ORS_KEY) {
    try {
      return await withRetry(
        () =>
          throttled(async () => {
            const url =
              `${ORS_DIRECTIONS_BASE}/driving-car?api_key=` +
              `${encodeURIComponent(ORS_KEY)}&start=${from.lng},${from.lat}&end=${to.lng},${to.lat}`;
            const j = await fetchJson(url);
            const d = j?.routes?.[0]?.summary?.distance;
            if (typeof d !== "number" || d <= 0) throw new Error("ORS sin ruta");
            return d / 1000;
          }),
        1,
        { deadline }
      );
    } catch (err) {
      try {
        const status = err.status || (typeof err.message === "string" && err.message.match(/HTTP (\d+)/)?.[1]);
        const st = status ? Number(status) : null;
        if (st === 401 || st === 403 || st === 429) {
          if (st === 401 || st === 403) suspendProvider("ors");
        }
      } catch {}
    }
  }
  try {
    return await withRetry(
      () =>
        throttled(async () => {
          const url =
            `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat}` +
            `;${to.lng},${to.lat}?overview=false&alternatives=false`;
          try {
            const j = await fetchJson(url);
            const m = j?.routes?.[0]?.distance;
            if (typeof m !== "number" || m <= 0) throw new Error("OSRM sin ruta");
            return m / 1000;
          } catch (err) {
            if (err.type === "timeout") console.warn("shipping provider fail: osrm timeout");
            else {
              const status = err.status || (typeof err.message === "string" && err.message.match(/HTTP (\d+)/)?.[1]);
              const st = status ? Number(status) : null;
              if (st) console.warn(`shipping provider fail: osrm HTTP ${st}`);
              if (st === 401 || st === 403) suspendProvider("osrm");
              if (st === 429) {
                let wait = 0;
                try {
                  if (err.retryAfter) wait = Math.min(Number(err.retryAfter) * 1000, MAX_RETRY_AFTER_MS);
                } catch {}
                if (wait > 0) {
                  const e = new Error("rate limited");
                  e.status = 429;
                  e.retryAfterMs = wait;
                  throw e;
                }
                suspendProvider("osrm");
              }
            }
            throw err;
          }
        }),
      1,
      { deadline }
    );
  } catch (err) {
    if (err.type === "timeout" || err.status === 429 || err.suspended) {
      // seguirá a haversine
    }
    return haversineKm(from, to) * ROAD_FACTOR;
  }
}

// ---------- Cotización ----------
// Cotización de envío para una dirección y una configuración dada.
// Usada por computeShipping (pedido real) y por el endpoint de "probar
// cotización" del panel. No crea pedidos.
export async function quoteShipping(cfg, address) {
  const a = String(address || "").trim();
  if (!a) return { blocks: 0, cost: 0, supported: true };
  const branchKey = cfg.city.toLowerCase(); // "tandil" | "necochea"
  const addressKey = normalizeAddressKey(a);
  const key = `${branchKey}|${addressKey}`;
  const started = Date.now();
  const acceptStreetLevel = cfg.acceptStreetLevel === true;
  const callePedida = extraerCallePedida(a);

  const cached = blockCache.get(key);
  if (cached && Date.now() - cached.at < KM_TTL) {
    return { cost: cached.cost, blocks: cached.blocks, supported: true };
  }
  const tFailed = transientFailCache.get(key);
  if (tFailed && Date.now() - tFailed.at < TRANSIENT_FAIL_TTL) {
    throw transient("El servicio de envío está saturado. Volvé a intentar en unos segundos.");
  }
  const dFailed = definitiveFailCache.get(key);
  if (dFailed && Date.now() - dFailed.at < DEFINITIVE_FAIL_TTL) {
    const code = dFailed.code;
    if (code === "zone") {
      throw new ShippingError(
        "zone",
        `Esa dirección queda fuera de nuestra zona de reparto.`
      );
    }
    throw unknown("No pudimos ubicar esa dirección con exactitud.");
  }

  let duracion = 0;
  let resultado = null;
  let provider = null;
  let matchLevel = "unknown";

  try {
    const origen = await getOrigin(cfg, { deadline: started + DEADLINE_MS });
    const textoPrincipal = [a, cfg.city, cfg.region, cfg.country]
      .filter(Boolean)
      .join(", ");
    const dest = await geocode(textoPrincipal, cfg, { ancla: origen, deadline: started + DEADLINE_MS });
    if (Date.now() - started > DEADLINE_MS) {
      throw transient("No pudimos consultar el mapa. Volvé a intentar en unos segundos.");
    }
    if (!dest) {
      definitiveFailCache.set(key, { at: Date.now(), code: "unknown" });
      duracion = Date.now() - started;
      logQuote("unknown", "unknown", null, duracion);
      throw unknown("No pudimos ubicar esa dirección con exactitud.");
    }
    provider = dest.provider;
    matchLevel = dest.matchLevel;

    // Validar candidato completo: localidad, calle y nivel de precisión.
    const validacion = validarCandidato(dest, cfg, callePedida, acceptStreetLevel);
    if (!validacion.ok) {
      definitiveFailCache.set(key, { at: Date.now(), code: "unknown" });
      duracion = Date.now() - started;
      logQuote("unknown", matchLevel, provider, duracion);
      throw unknown("No pudimos ubicar esa dirección con exactitud.");
    }

    const km = await roadDistanceKm(origen, dest, { deadline: started + DEADLINE_MS });
    if (Date.now() - started > DEADLINE_MS) {
      throw transient("No pudimos consultar el mapa. Volvé a intentar en unos segundos.");
    }
    const exact = (km * 1000) / cfg.blockMeters;

    if (cfg.maxBlocks > 0 && exact > cfg.maxBlocks) {
      definitiveFailCache.set(key, { at: Date.now(), code: "zone" });
      duracion = Date.now() - started;
      logQuote("zone", matchLevel, provider, duracion);
      throw zone(
        `Esa dirección queda a ${Math.round(exact)} cuadras. Nuestro reparto cubre hasta ${cfg.maxBlocks} cuadras (~${Math.round((cfg.maxBlocks * cfg.blockMeters) / 1000)} km).`
      );
    }

    let cost, blocks;
    if (exact <= cfg.flatBlocks) {
      cost = cfg.baseCost;
      blocks = Math.round(exact);
    } else {
      const extra = Math.ceil(exact) - cfg.flatBlocks;
      cost = cfg.baseCost + extra * cfg.perBlock;
      blocks = Math.ceil(exact);
    }
    blockCache.set(key, { blocks, cost, at: Date.now() });
    duracion = Date.now() - started;
    logQuote("ok", matchLevel, provider, duracion);
    return { cost, blocks, supported: true };
  } catch (err) {
    duracion = Date.now() - started;
    if (err && err.code === "transient") {
      transientFailCache.set(key, { at: Date.now() });
      logQuote("transient", matchLevel, provider, duracion);
    } else if (err && err.code === "zone") {
      logQuote("zone", matchLevel, provider, duracion);
    } else {
      logQuote("unknown", matchLevel, provider, duracion);
    }
    throw err;
  }
}

// Un solo log por cotización, SIN datos personales: proveedor, matchLevel,
// resultado (ok, unknown, zone, transient) y duración. (paso 3h)
function logQuote(resultado, matchLevel, provider, duracion) {
  console.log(
    `shipping quote: resultado=${resultado} nivel=${matchLevel || "unknown"} proveedor=${provider || "-"} duracion=${duracion}ms`
  );
}

export async function computeShipping(a, b, c) {
  // Soporta tanto computeShipping(db, branch, address) como la firma antigua
  // computeShipping(branch, address) (sin BD: usa valores de semilla, útil para
  // lógica pura como order-edit.js y para tests existentes).
  let db, branch, address;
  if (a && typeof a.prepare === "function") {
    db = a;
    branch = b;
    address = c;
  } else {
    db = undefined;
    branch = a;
    address = b;
  }
  const cfg = await getBranchConfig(db, branch);
  if (!cfg || !DEFAULT_SHIPPING[branch]) {
    return { cost: 0, blocks: 0, supported: false };
  }
  if (!db) cfg.blockMeters = blockMetersFor(branch);
  if (cfg.autoEnabled === 0) {
    return { cost: 0, blocks: 0, supported: true, pending: true };
  }
  const s = String(address || "").trim();
  if (!s) {
    return { cost: 0, blocks: 0, supported: true };
  }
  const result = await quoteShipping(cfg, address);
  return { cost: result.cost, blocks: result.blocks, supported: result.supported };
}

function pruneShippingCaches() {
  const t = Date.now();
  for (const [k, v] of blockCache) if (t - v.at > KM_TTL) blockCache.delete(k);
  for (const [k, v] of transientFailCache) if (t - v.at > TRANSIENT_FAIL_TTL * 2) transientFailCache.delete(k);
  for (const [k, v] of definitiveFailCache) if (t - v.at > DEFINITIVE_FAIL_TTL * 2) definitiveFailCache.delete(k);
  for (const [k, v] of originCache) if (t - v.at > ORIGIN_TTL * 2) originCache.delete(k);
  for (const [k, v] of geoCache) if (t - v.at > GEO_TTL * 2) geoCache.delete(k);
}
setInterval(pruneShippingCaches, 10 * 60 * 1000).unref();
