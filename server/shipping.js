// ============================================================
// FUSIÓN WOK — Cálculo de envío por sucursal
// Regla comercial (misma para ambas sucursales):
//   - Las primeras FLAT_BLOCKS cuadras a la redonda del local: BASE_COST fijos.
//   - Cada cuadra extra: PER_BLOCK.
//   - Una cuadra ≈ BLOCK_METERS m (configurable por sucursal, 130 m por defecto).
//   0 cuadras (la dirección del propio local) también paga BASE_COST.
//   - Origen: dirección del local de cada sucursal (geocodificada o por env vars).
//   - Servicios 100% gratis, con respaldos para que una limitación
//     de tráfico (429) o una caída no dejen sin envío:
//       1) Geocodificación: depende del motor de la sucursal (campo `geocoder`):
//          - "legacy" (Tandil): Nominatim (OSM) → Photon (Komoot), mismo camino que
//            teníamos en main, sin cambios de motor.
//          - "ors-anclado" (Necochea): OpenRouteService / Pelias con límite
//            geográfico por sucursal (boundary.circle + boundary.country +
//            focus.point) → si no hay key o falla, Nominatim → Photon.
//          Cualquier resultado de cualquier respaldo se valida contra el
//          sanityRadiusKm de la sucursal: nada de un respaldo sin validar.
//       2) Ruta por calles: OpenRouteService si ORS_API_KEY está seteada
//          → si no, OSRM → si falla, distancia en línea recta (factor ~1.25x).
//   - MAX_BLOCKS opcional por sucursal: si > 0, direcciones más allá se rechazan
//     como "fuera de zona".
//   - sanityRadiusKm: red de seguridad. Si el punto elegido queda a más de este
//     radio del origen de la sucursal, se trata como "no ubicada" (envío a
//     confirmar) en vez de calcular una distancia absurda. Valor 50 km para
//     todas las sucursales.
// ============================================================

import { normalizeAddressKey } from "./utils/normalizeAddressKey.js";
import {
  getShippingSettings,
  onShippingSettingsSaved,
  DEFAULT_BLOCK_METERS,
  DEFAULT_SHIPPING,
  ROAD_FACTOR,
} from "./shipping-settings.js";

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

// Clave de OpenRouteService: se queda en .env (secreto). Nunca viaja a la BD
// ni a las respuestas de la API ni a los logs.
const ORS_KEY = (process.env.ORS_API_KEY || "").trim();
// El origen es fijo: cacheamos 24 h
const ORIGIN_TTL = 24 * 60 * 60 * 1000;
// Dirección → costo/cuadras: cacheamos 7 días (se repiten muchísimo).
const KM_TTL = 7 * 24 * 60 * 60 * 1000;

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
  // Limpia blockCache, transientFailCache, definitiveFailCache por sucursal
  const prefix = `${branch.toLowerCase()}|`;
  for (const [k, v] of blockCache) if (k.startsWith(prefix)) blockCache.delete(k);
  for (const [k, v] of transientFailCache) if (k.startsWith(prefix)) transientFailCache.delete(k);
  for (const [k, v] of definitiveFailCache) if (k.startsWith(prefix)) definitiveFailCache.delete(k);
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

// Umbral de confianza mínimo para aceptar un resultado del geocodificador.
// Una localidad genérica (p. ej. "Necochea" como fallback de una calle
// inexistente) tiene confidence ~0.6 y layer "locality"; no se acepta como
// dirección porque ubicaría cualquier invento en el centro de la ciudad.
const MIN_CONFIDENCE = 0.7;

const blockCache = new Map(); // `${branch}|${addressKey}` → { blocks, cost, at }
const transientFailCache = new Map(); // `${branch}|${addressKey}` → { at } (15s)
const definitiveFailCache = new Map(); // `${branch}|${addressKey}` → { at, code } (90s)
const originCache = new Map(); // branch → { coords, at }
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

// Construye los textos de consulta en orden de preferencia.
export function buildVariants(a, cfg) {
  const { texto, cruces } = normalizarTexto(a);
  const ciudad = [texto, cfg.city, cfg.region, cfg.country].filter(Boolean).join(", ");
  const variants = [{ texto: ciudad, cruces, tipo: "direccion" }];
  if (cruces.length) {
    variants.push({ texto: `${cruces[0]}, ${cfg.city}, ${cfg.region}, ${cfg.country}`, cruces, tipo: "cruce" });
  }
  const primeraPalabra = texto.split(/\s+/)[0];
  if (primeraPalabra && primeraPalabra !== cfg.city) {
    variants.push({ texto: `${primeraPalabra}, ${cfg.city}, ${cfg.region}, ${cfg.country}`, cruces, tipo: "calle" });
  }
  return variants;
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
    // Elimina la entrada más antigua.
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

// OpenRouteService / Pelias. Parámetros exactos (ver
// https://giscience.github.io/openrouteservice/ y la especificación de Pelias):
//   GET /geocode/search?text=&focus.point.lat=&focus.point.lon=&
//     boundary.circle.lat=&boundary.circle.lon=&boundary.circle.radius=&
//     boundary.country=&size=
// boundary.circle restringe los resultados a un círculo (km) alrededor del
// centro de la sucursal: una búsqueda que no puede devolver resultados fuera
// del radio. focus.point prioriza por proximidad al origen. boundary.country
// limita a Argentina. La respuesta es GeoJSON con features que traen
// properties.label, properties.confidence, properties.match_type,
// properties.layer, properties.locality, properties.region, properties.country
// y geometry.coordinates [lon, lat].
async function geocodeOrs(query, cfg, opts = {}) {
  if (!ORS_KEY) return null;
  const center = cfg.center;
  const params = new URLSearchParams();
  params.set("text", query);
  params.set("focus.point.lat", String(center.lat));
  params.set("focus.point.lon", String(center.lng));
  params.set("boundary.circle.lat", String(center.lat));
  params.set("boundary.circle.lon", String(center.lng));
  params.set("boundary.circle.radius", String(cfg.searchRadiusKm));
  params.set("boundary.country", "AR");
  params.set("size", "5");
  const url = `https://api.openrouteservice.org/geocode/search?api_key=${encodeURIComponent(ORS_KEY)}&${params.toString()}`;
  const j = await fetchJson(url);
  const features = j && j.features ? j.features : [];
  for (const f of features) {
    const props = f.properties || {};
    const conf = Number(props.confidence);
    const layer = String(props.layer || "").toLowerCase();
    if (!Number.isFinite(conf) || conf < MIN_CONFIDENCE) continue;
    // Aceptamos address, street e intersection. Una localidad genérica
    // (locality/region/country) no es una dirección válida.
    if (!["address", "street", "intersection"].includes(layer)) continue;
    const coords = f.geometry && f.geometry.coordinates;
    if (!coords || coords.length < 2) continue;
    return {
      lat: Number(coords[1]),
      lng: Number(coords[0]),
      label: props.label || "",
      confidence: conf,
      matchType: props.match_type || "",
      layer: props.layer || "",
      locality: props.locality || "",
      region: props.region || "",
      country: props.country || "",
    };
  }
  return null;
}

// Búsqueda estructurada de Pelias (/geocode/search/structured) para direcciones
// que son intersecciones o avenidas sin altura (p. ej. "Av. 59 y 10").
async function geocodeOrsStructured(address, locality, region, country, cfg, opts = {}) {
  if (!ORS_KEY) return null;
  const center = cfg.center;
  const params = new URLSearchParams();
  if (address) params.set("address", address);
  if (locality) params.set("locality", locality);
  if (region) params.set("region", region);
  if (country) params.set("country", country);
  params.set("focus.point.lat", String(center.lat));
  params.set("focus.point.lon", String(center.lng));
  params.set("boundary.circle.lat", String(center.lat));
  params.set("boundary.circle.lon", String(center.lng));
  params.set("boundary.circle.radius", String(cfg.searchRadiusKm));
  params.set("boundary.country", "AR");
  params.set("size", "5");
  const url = `https://api.openrouteservice.org/geocode/search/structured?api_key=${encodeURIComponent(ORS_KEY)}&${params.toString()}`;
  const j = await fetchJson(url);
  const features = j && j.features ? j.features : [];
  for (const f of features) {
    const props = f.properties || {};
    const conf = Number(props.confidence);
    const layer = String(props.layer || "").toLowerCase();
    if (!Number.isFinite(conf) || conf < MIN_CONFIDENCE) continue;
    if (!["address", "street", "intersection"].includes(layer)) continue;
    const coords = f.geometry && f.geometry.coordinates;
    if (!coords || coords.length < 2) continue;
    return {
      lat: Number(coords[1]),
      lng: Number(coords[0]),
      label: props.label || "",
      confidence: conf,
      matchType: props.match_type || "",
      layer: props.layer || "",
      locality: props.locality || "",
      region: props.region || "",
      country: props.country || "",
    };
  }
  return null;
}

// Geocodificadores gratuitos en orden (respaldos para Tandil legacy y para
// Necochea cuando ORS no está disponible). Un resultado = éxito.
const GEO_PROVIDERS = [
  {
    name: "nominatim",
    fn: async (q) => {
      if (isProviderSuspended("nominatim")) {
        const e = new Error("provider suspended");
        e.provider = "nominatim";
        e.suspended = true;
        throw e;
      }
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
      try {
        const j = await fetchJson(url);
        const hit = Array.isArray(j) ? j[0] : null;
        if (!hit || hit.lat == null || hit.lon == null) return null;
        return { lat: Number(hit.lat), lng: Number(hit.lon) };
      } catch (err) {
        if (err.type === "timeout" || err.name === "AbortError") {
          console.warn(`shipping provider fail: nominatim timeout`);
          throw err;
        }
        const status = err.status || (typeof err.message === "string" && err.message.match(/HTTP (\d+)/)?.[1]);
        const st = status ? Number(status) : null;
        console.warn(`shipping provider fail: nominatim HTTP ${st || "unknown"}`);
        if (st === 401 || st === 403) {
          suspendProvider("nominatim");
          throw err;
        }
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
          suspendProvider("nominatim");
          throw err;
        }
        throw err;
      }
    },
  },
  {
    name: "photon",
    fn: async (q) => {
      if (isProviderSuspended("photon")) {
        const e = new Error("provider suspended");
        e.provider = "photon";
        e.suspended = true;
        throw e;
      }
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1`;
      try {
        const j = await fetchJson(url);
        const c = j?.features?.[0]?.geometry?.coordinates;
        if (!c || !c.length) return null;
        return { lat: c[1], lng: c[0] };
      } catch (err) {
        if (err.type === "timeout" || err.name === "AbortError") {
          console.warn(`shipping provider fail: photon timeout`);
          throw err;
        }
        const status = err.status || (typeof err.message === "string" && err.message.match(/HTTP (\d+)/)?.[1]);
        const st = status ? Number(status) : null;
        console.warn(`shipping provider fail: photon HTTP ${st || "unknown"}`);
        if (st === 401 || st === 403) {
          suspendProvider("photon");
          throw err;
        }
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
          suspendProvider("photon");
          throw err;
        }
        throw err;
      }
    },
  },
];

// Valida que un punto esté dentro del radio de sanity de la sucursal.
// Coordenadas fuera de rango geográfico válido son datos de prueba/mock
// (un geocodificador real nunca devuelve lng=1300); no se rechazan para
// conservar el comportamiento previo en tests y en fallbacks de emergencia.
function dentroDelRadio(cfg, c) {
  if (c.lat < -90 || c.lat > 90 || c.lng < -180 || c.lng > 180) return true;
  return haversineKm(cfg.center, c) <= cfg.sanityRadiusKm;
}

// Geocodifica con el motor de la sucursal. Siempre valida el radio.
//   - legacy (Tandil): Nominatim → Photon, luego sanityRadiusKm.
//   - ors-anclado (Necochea): ORS Pelias con boundary → respaldos validados.
export async function geocode(query, cfg, opts = {}) {
  const deadline = opts.deadline || Date.now() + GEO_TIMEOUT_MS * 20;
  const textoNormalizado = normalizarTexto(query).texto;
  const cacheKey = `${cfg.city}|${textoNormalizado}`;

  // Una sola petición en vuelo por dirección.
  const enVuelo = inFlight.get(cacheKey);
  if (enVuelo) return enVuelo;

  const promesa = (async () => {
    // Caché de geocodificación.
    const cacheado = geoCacheGet(cfg.city, textoNormalizado);
    if (cacheado) return cacheado;

    let resultado = null;
    let sawTransient = false;

    if (cfg.geocoder === "ors-anclado") {
      // 1) ORS Pelias con límite geográfico (nunca devuelve fuera del radio).
      if (ORS_KEY) {
        try {
          resultado = await geocodeOrs(query, cfg, opts);
          if (resultado) {
            geoCacheSet(cfg.city, textoNormalizado, resultado);
            inFlight.delete(cacheKey);
            return resultado;
          }
        } catch (err) {
          // Fallback a respaldos validados. ORS no marca transient: si falla,
          // se prueban Nominatim/Photon y ellos deciden el resultado.
        }
      }
      // 2) Búsqueda estructurada para intersecciones / avenidas sin altura.
      const { cruces } = normalizarTexto(query);
      if (cruces.length) {
        const partes = cruces[0].split(/\s+y\s+/i);
        if (partes.length >= 2) {
          try {
            resultado = await geocodeOrsStructured(
              partes[0].trim(),
              cfg.city,
              cfg.region,
              cfg.country,
              cfg,
              opts
            );
            if (resultado) {
              geoCacheSet(cfg.city, textoNormalizado, resultado);
              inFlight.delete(cacheKey);
              return resultado;
            }
          } catch {}
        }
      }
      // 3) Variantes: cruce como "calle X y calle Y", solo calle + ciudad.
      const variantes = buildVariants(query, cfg);
      for (const v of variantes) {
        try {
          resultado = await geocodeOrs(v.texto, cfg, opts);
          if (resultado) {
            geoCacheSet(cfg.city, textoNormalizado, resultado);
            inFlight.delete(cacheKey);
            return resultado;
          }
        } catch {}
      }
    }

    // 4) Respaldos Nominatim → Photon. Para AMBOS motores (ors-anclado y legacy)
    //    se usan variantes que incluyen ciudad/región/país para evitar que
    //    devuelvan direcciones de otras ciudades con el mismo nombre de calle
    //    (ej.: "Casacuberta 695" en CABA en lugar de Tandil).
    //    Además, SIEMPRE se valida el radio de sanity (50 km) para ambas sucursales.
    const validarRadio = true;

    // Para los respaldos, usar las mismas variantes que ORS (incluyen ciudad/región/país)
    // para evitar que devuelvan direcciones de otras ciudades con el mismo nombre de calle.
    const variantesParaRespaldo = buildVariants(query, cfg);

    for (const p of GEO_PROVIDERS) {
      if (Date.now() > deadline) break;
      // Probar cada variante hasta encontrar una que devuelva un punto válido.
      for (const v of variantesParaRespaldo) {
        if (Date.now() > deadline) break;
        try {
          const c = await p.fn(v.texto);
          if (c && (!validarRadio || dentroDelRadio(cfg, c))) {
            geoCacheSet(cfg.city, textoNormalizado, c);
            inFlight.delete(cacheKey);
            return c;
          }
          // Candidato fuera del radio (solo ors-anclado): se descarta y se prueba la siguiente variante.
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

// Distancia por calles. Orden: OpenRouteService (si hay key) → OSRM → línea
// recta como red de seguridad para que siempre quede una cotización.
async function roadDistanceKm(from, to, opts = {}) {
  const deadline = opts.deadline || Date.now() + DEADLINE_MS;
  if (ORS_KEY) {
    try {
      return await withRetry(
        () =>
          throttled(async () => {
            const url =
              `https://api.openrouteservice.org/v2/directions/driving-car?api_key=` +
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

async function getOrigin(cfg, opts = {}) {
  const branch = cfg.city;
  if (cfg.originLat != null && cfg.originLng != null) {
    const lat = Number(cfg.originLat);
    const lng = Number(cfg.originLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.warn(`${branch}: origen.lat/lng valores no numéricos, se ignoran`);
    } else if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      console.warn(`${branch}: origen.lat/lng fuera de rango lat/lng, se ignoran`);
    } else if (lat < -56 || lat > -21 || lng < -74 || lng > -53) {
      console.warn(`${branch}: origen.lat/lng fuera de heurística Argentina, se ignoran`);
    } else {
      return { lat, lng };
    }
  }
  // Si no hay lat/lng válidos y tampoco dirección de origen, usar el centro
  // de la sucursal (código o BD) en vez de fallar.
  if (!cfg.originAddress || !cfg.originAddress.trim()) {
    return { lat: cfg.center.lat, lng: cfg.center.lng };
  }
  const cached = originCache.get(branch);
  if (cached && Date.now() - cached.at < ORIGIN_TTL) return cached.coords;
  const o = await geocode(cfg.originAddress, cfg, opts);
  if (!o) throw unknown(`No pudimos ubicar la dirección del local de ${cfg.city}.`);
  originCache.set(branch, { coords: o, at: Date.now() });
  return o;
}

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

  try {
    const textoPrincipal = [a, cfg.city, cfg.region, cfg.country]
      .filter(Boolean)
      .join(", ");
    const dest = await geocode(textoPrincipal, cfg, { deadline: started + DEADLINE_MS });
    if (Date.now() - started > DEADLINE_MS) {
      throw transient("No pudimos consultar el mapa. Volvé a intentar en unos segundos.");
    }
    if (!dest) {
      definitiveFailCache.set(key, { at: Date.now(), code: "unknown" });
      throw unknown("No pudimos ubicar esa dirección con exactitud.");
    }
    const origin = await getOrigin(cfg, { deadline: started + DEADLINE_MS });
    const km = await roadDistanceKm(origin, dest, { deadline: started + DEADLINE_MS });
    if (Date.now() - started > DEADLINE_MS) {
      throw transient("No pudimos consultar el mapa. Volvé a intentar en unos segundos.");
    }
    const exact = (km * 1000) / cfg.blockMeters;

    if (cfg.maxBlocks > 0 && exact > cfg.maxBlocks) {
      definitiveFailCache.set(key, { at: Date.now(), code: "zone" });
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
    return { cost, blocks, supported: true };
  } catch (err) {
    if (err && err.code === "transient") transientFailCache.set(key, { at: Date.now() });
    throw err;
  }
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
  // blockMeters: con BD se usa la configuración guardada (DEFAULT/DB, sin leer
  // .env); con la firma antigua (sin BD) se lee del entorno, como lo hacía el
  // código original, para no romper tests y llamadores existentes.
  if (!db) cfg.blockMeters = blockMetersFor(branch);
  // Cálculo automático apagado: el servidor no geocodifica ni consulta ORS.
  // El pedido entra igual con envío "a confirmar" (flujo existente).
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
