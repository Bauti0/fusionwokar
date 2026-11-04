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
//       1) Geocoding: Nominatim (OSM) → si falla, Photon (Komoot).
//       2) Ruta por calles: OpenRouteService si ORS_API_KEY está seteada
//          (clave gratuita en openrouteservice.org) → si no, OSRM → si
//          falla, distancia en línea recta (factor ~1.25x).
//   - MAX_BLOCKS opcional por sucursal: si > 0, direcciones más allá se rechazan
//     como "fuera de zona".
// ============================================================

import { normalizeAddressKey } from "./utils/normalizeAddressKey.js";

// Configuración por sucursal. Los valores por defecto son los de Tandil;
// Necochea usa los mismos valores de tarifa pero origen y ciudad distintos.
const BRANCH_SHIPPING_CONFIG = {
  tandil: {
    originQuery: "Chacabuco 660, Tandil, Buenos Aires, Argentina",
    city: "Tandil",
    region: "Buenos Aires",
    country: "Argentina",
    blockMeters: Number(process.env.SHIPPING_BLOCK_METERS || 130),
    flatBlocks: Number(process.env.SHIPPING_FLAT_BLOCKS || 20),
    baseCost: Number(process.env.SHIPPING_BASE_COST || 4000),
    perBlock: Number(process.env.SHIPPING_PER_BLOCK || 100),
    maxBlocks: Math.max(0, Number(process.env.SHIPPING_MAX_BLOCKS || 0) || 0),
    // Coordenadas opcionales por env vars (SHIPPING_ORIGIN_LAT/LNG son globales;
    // si se definen se usan para Tandil por compatibilidad).
    envOriginLat: (process.env.SHIPPING_ORIGIN_LAT || "").trim(),
    envOriginLng: (process.env.SHIPPING_ORIGIN_LNG || "").trim(),
  },
  necochea: {
    originQuery: "Diagonal San Martín 1258, Necochea, Buenos Aires, Argentina",
    city: "Necochea",
    region: "Buenos Aires",
    country: "Argentina",
    blockMeters: Number(process.env.SHIPPING_BLOCK_METERS || 100),
    flatBlocks: Number(process.env.SHIPPING_FLAT_BLOCKS || 20),
    baseCost: Number(process.env.SHIPPING_BASE_COST || 4000),
    perBlock: Number(process.env.SHIPPING_PER_BLOCK || 100),
    maxBlocks: Math.max(0, Number(process.env.SHIPPING_MAX_BLOCKS || 0) || 0),
    // Necochea no tiene env vars dedicados aún; se geocodifica originQuery.
    envOriginLat: "",
    envOriginLng: "",
  },
};

const ORS_KEY = (process.env.ORS_API_KEY || "").trim();
// Multiplicador línea recta → calles (distancia de ruta aproximada)
const ROAD_FACTOR = 1.25;
// El origen es fijo: cacheamos 24 h
const ORIGIN_TTL = 24 * 60 * 60 * 1000;
// Dirección → costo/cuadras: cacheamos 7 días (se repiten muchísimo y así no
// se vuelven a consultar los geocoders por la misma dirección).
const KM_TTL = 7 * 24 * 60 * 60 * 1000;
// Ante un fallo transitorio (429/caída) no volvemos a golpear el servicio
// por 90 s, así el cliente puede reintentar sin saturar nada.
const DEFINITIVE_FAIL_TTL = 90 * 1000;

const GEO_TIMEOUT_MS = 5000; // reducido para que el total no crezca
const USER_AGENT = "FusionWok/1.0 (+https://fusionwok.net)";

const blockCache = new Map(); // clave normalizada → { blocks, cost, at }
const transientFailCache = new Map(); // clave normalizada → { at } (fallos transitorios: 15s)
const definitiveFailCache = new Map(); // clave normalizada → { at, code } (unknown/zone: 90s)
const originCache = new Map(); // branch → { coords, at }

// TTLs diferenciados
const TRANSIENT_FAIL_TTL = 15000; // caché negativo corto para transient
// DEFINITIVE_FAIL_TTL ya declarada arriba (90 * 1000)
const DEADLINE_MS = 12000; // techo global para computeShipping

// Errores con código para que el endpoint devuelva el HTTP correcto:
//  - transient → 503 (servicio saturado/caído, se puede reintentar)
//  - unknown / zone → 400 (definitivo, mostrado al cliente)
class ShippingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const transient = (m) => new ShippingError("transient", m);
const unknown = (m) => new ShippingError("unknown", m);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Suspensiones de providers (403/401/429 prolongado)
const providerSuspendedUntil = new Map(); // providerName -> timestamp ms
const PROVIDER_SUSPEND_MS = 10 * 60 * 1000; // 10 minutos
const MAX_RETRY_AFTER_MS = 5 * 1000; // tope razonable para Retry-After

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

// Espaciado mínimo entre llamadas externas (~1.2 s) para ser amables con los
// servicios gratuitos. Global: una petición externa por vez a lo sumo.
let lastExternalCall = 0;
// M-3: la cola era infinita. Un flood de cotizaciones acumulaba promesas
// pendientes (cada una con su espera de 1.2 s) hasta agotar memoria/event
// loop, y seguía encolando hacia servicios ya saturados. Con tope, lo que
// excede responde transient (503) y el cliente reintenta más tarde.
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
      // Intentar leer Retry-After si viene
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

// Reintento con backoff + jitter (±50% aprox)
function jitter(ms) {
  const j = ms * 0.5 * Math.random();
  return Math.round(ms - j + 2 * j); // simple
}

// Un solo reintento (limita las llamadas al plan externo; el respaldo entre
// proveedores ya cubre la caída de uno)
const withRetry = async (fn, times = 1, opts = {}) => {
  let lastErr;
  const start = Date.now();
  const deadline = opts.deadline || Number.POSITIVE_INFINITY;
  for (let i = 0; i <= times; i++) {
    // deadline global
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
}

// Haversine (km en línea recta); fallback cuando OSRM no responde.
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

// Geocodificadores gratuitos en orden; un resultado = éxito.
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

async function geocode(query, opts = {}) {
  const deadline = opts.deadline || Date.now() + GEO_TIMEOUT_MS * 20; // margen
  return withRetry(
    () =>
      throttled(async () => {
        let sawTransient = false;
        for (const p of GEO_PROVIDERS) {
          if (Date.now() > deadline) {
            sawTransient = true;
            break;
          }
          try {
            const c = await p.fn(query);
            if (c) return c;
          } catch (err) {
            // timeouts -> transient but don't suspend
            if (err.type === "timeout" || err.name === "AbortError") {
              sawTransient = true;
              continue;
            }
            const st = err.status;
            if (st === 429 && err.retryAfterMs) {
              // respeamos wait acotado, aún así marca transient para conjunto
              sawTransient = true;
              if (err.retryAfterMs > 0) await sleep(Math.min(err.retryAfterMs, MAX_RETRY_AFTER_MS));
              continue;
            }
            if (st === 401 || st === 403) {
              // ya suspendido/logueado
              sawTransient = true;
              continue;
            }
            sawTransient = true;
          }
        }
        if (sawTransient) throw transient("No pudimos consultar el mapa. Volvé a intentar en unos segundos.");
        return null;
      }),
    1,
    { deadline }
  );
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
      // si ORS falla, seguimos con OSRM
      try {
        const status = err.status || (typeof err.message === "string" && err.message.match(/HTTP (\d+)/)?.[1]);
        const st = status ? Number(status) : null;
        if (st === 401 || st === 403 || st === 429) {
          // logueo ya hecho implícitamente no necesario; suspendemos si aplica
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

// Obtiene la configuración de envío para una sucursal (con defaults seguros).
function getBranchConfig(branch) {
  return BRANCH_SHIPPING_CONFIG[branch] || BRANCH_SHIPPING_CONFIG.tandil;
}

// Enriquece una dirección con la ciudad/región/país de la sucursal.
function enrichAddress(address, branch) {
  const a = String(address || "").trim();
  if (!a) return "";
  const cfg = getBranchConfig(branch);
  // Si la dirección ya menciona la ciudad, no la duplicamos.
  const cityRe = new RegExp(cfg.city, "i");
  if (cityRe.test(a)) return a;
  return `${a}, ${cfg.city}, ${cfg.region}, ${cfg.country}`;
}

async function getOrigin(branch, opts = {}) {
  const cfg = getBranchConfig(branch);
  // Si hay coordenadas de entorno válidas para esta sucursal, úsalas directo.
  if (cfg.envOriginLat && cfg.envOriginLng) {
    const lat = Number(cfg.envOriginLat);
    const lng = Number(cfg.envOriginLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.warn(`${branch}: SHIPPING_ORIGIN_LAT/LNG valores no numéricos, se ignoran`);
    } else if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      console.warn(`${branch}: SHIPPING_ORIGIN_LAT/LNG fuera de rango lat/lng, se ignoran`);
    } else if (lat < -56 || lat > -21 || lng < -74 || lng > -53) {
      console.warn(`${branch}: SHIPPING_ORIGIN_LAT/LNG fuera de heurística Argentina, se ignoran`);
    } else {
      return { lat, lng };
    }
  }
  const cached = originCache.get(branch);
  if (cached && Date.now() - cached.at < ORIGIN_TTL) return cached.coords;
  const o = await geocode(cfg.originQuery, opts);
  if (!o) throw unknown(`No pudimos ubicar la dirección del local de ${cfg.city}.`);
  originCache.set(branch, { coords: o, at: Date.now() });
  return o;
}

// Devuelve { cost, blocks, supported } para un envío en la sucursal dada.
// Reintentar es seguro: los fallos transitorios se cachean brevemente y los
// resultados por dirección se guardan para no repetir consultas.
export async function computeShipping(branch, address) {
  const a = String(address || "").trim();
  // Si la sucursal no tiene config de envío conocida, no está soportada.
  if (!BRANCH_SHIPPING_CONFIG[branch]) {
    return { cost: 0, blocks: 0, supported: false };
  }
  const cfg = getBranchConfig(branch);
  // Sin dirección: la sucursal soporta envío pero no hay costo que calcular.
  if (!a) {
    return { cost: 0, blocks: 0, supported: true };
  }
  const key = normalizeAddressKey(a);
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
    throw unknown("No pudimos ubicar esa dirección. Revisá calle y número.");
  }

  // Todo lo que consulta la red va envuelto para que el fallo transitorio
  // quede cacheado por 15 s para esta dirección (caché negativo corto): el
  // cliente que reintenta cada 2 s no le vuelve a pegar a Nominatim/Photon/OSRM
  // ni los obliga a seguir respondiendo. Los definitivos (unknown/zone) se
  // cachean donde se detectan, con su plazo de 90 s.
  try {
    const dest = await geocode(enrichAddress(a, branch), { deadline: started + DEADLINE_MS });
    if (Date.now() - started > DEADLINE_MS) {
      throw transient("No pudimos consultar el mapa. Volvé a intentar en unos segundos.");
    }
    if (!dest) {
      definitiveFailCache.set(key, { at: Date.now(), code: "unknown" });
      throw unknown("No pudimos ubicar esa dirección. Revisá calle y número.");
    }
    const origin = await getOrigin(branch, { deadline: started + DEADLINE_MS });
    const km = await roadDistanceKm(origin, dest, { deadline: started + DEADLINE_MS });
    if (Date.now() - started > DEADLINE_MS) {
      throw transient("No pudimos consultar el mapa. Volvé a intentar en unos segundos.");
    }
    const exact = (km * 1000) / cfg.blockMeters;

    // Fuera de zona de reparto: solo si hay un tope configurado (maxBlocks > 0).
    // Sin tope configurado el reparto no tiene límite de cobertura.
    if (cfg.maxBlocks > 0 && exact > cfg.maxBlocks) {
      definitiveFailCache.set(key, { at: Date.now(), code: "zone" });
      throw new ShippingError(
        "zone",
        `Esa dirección queda a ${Math.round(exact)} cuadras. Nuestro reparto cubre hasta ${cfg.maxBlocks} cuadras (~${Math.round((cfg.maxBlocks * cfg.blockMeters) / 1000)} km).`
      );
    }

    // Dentro de la franquicia (hasta flatBlocks cuadras): costo fijo.
    // Después: la primera cuadra entera o parcial que salga de la franquicia
    // paga como extra (perBlock), igual que cada cuadra adicional.
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

// Poda de cachés de envío: elimina las entradas vencidas para que los Map no
// crezcan sin límite con direcciones distintas. Corre en segundo plano y no
// mantiene vivo el proceso.
function pruneShippingCaches() {
  const t = Date.now();
  for (const [k, v] of blockCache) if (t - v.at > KM_TTL) blockCache.delete(k);
  for (const [k, v] of transientFailCache) if (t - v.at > TRANSIENT_FAIL_TTL * 2) transientFailCache.delete(k);
  for (const [k, v] of definitiveFailCache) if (t - v.at > DEFINITIVE_FAIL_TTL * 2) definitiveFailCache.delete(k);
  for (const [k, v] of originCache) if (t - v.at > ORIGIN_TTL * 2) originCache.delete(k);
}
setInterval(pruneShippingCaches, 10 * 60 * 1000).unref();