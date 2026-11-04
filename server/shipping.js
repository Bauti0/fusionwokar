// ============================================================
// FUSIÓN WOK — Cálculo de envío (Tandil y Necochea)
// Regla real (ambas sucursales):
//   - Las primeras 20 cuadras a la redonda del local: $4.000 fijos.
//   - Cada cuadra extra: $100.
//   - La cuadra en Tandil ≈ 130 m, en Necochea ≈ 100 m (configurable).
//   0 cuadras (la dirección del propio local) también paga $4.000.
//   - Origen Tandil: Chacabuco 660, Tandil, Buenos Aires.
//   - Origen Necochea: Av. 59 1461, Necochea, Buenos Aires.
//   - Servicios 100% gratis, con respaldos para que una limitación
//     de tráfico (429) o una caída no dejen sin envío:
//       1) Geocoding: Nominatim (OSM) → si falla, Photon (Komoot).
//       2) Ruta por calles: OpenRouteService si ORS_API_KEY está seteada
//          (clave gratuita en openrouteservice.org) → si no, OSRM → si
//          falla, distancia en línea recta (factor ~1.25x).
//   - MAX_BLOCKS es opcional (SHIPPING_MAX_BLOCKS): si se define, las
//     direcciones más allá de ese tope se rechazan como "fuera de zona".
// ============================================================

import { normalizeAddressKey } from "./utils/normalizeAddressKey.js";

// ============ Configuración Tandil ============
// Franquicia: hasta esta cantidad de cuadras se cobra solo la base
const TANDIL_FLAT_BLOCKS = Number(process.env.SHIPPING_FLAT_BLOCKS || 20);
// Costo fijo de la franquicia (base)
const TANDIL_BASE_COST = Number(process.env.SHIPPING_BASE_COST || 4000);
// Costo por cuadra extra por encima de la franquicia
const TANDIL_PER_BLOCK = Number(process.env.SHIPPING_PER_BLOCK || 100);
// Tope de reparto total en cuadras. OPCIONAL: si SHIPPING_MAX_BLOCKS no está
// definida (o es 0/negativa) NO hay tope de distancia — aplica la regla
// comercial: las primeras SHIPPING_FLAT_BLOCKS cuadras salen SHIPPING_BASE_COST
// y cada cuadra adicional SHIPPING_PER_BLOCK. (SHIPPING_MAX_KM quedó obsoleta:
// la regla es por cuadras y el reparto no tiene límite de cobertura.)
const TANDIL_MAX_BLOCKS = Math.max(0, Number(process.env.SHIPPING_MAX_BLOCKS || 0) || 0);
// Una cuadra en Tandil ≈ 130 m (los geocoders devuelven metros)
const TANDIL_BLOCK_METERS = Number(process.env.SHIPPING_BLOCK_METERS || 130);
// Origen Tandil: Chacabuco 660, Tandil, Buenos Aires, Argentina
const TANDIL_ORIGIN_QUERY = "Chacabuco 660, Tandil, Buenos Aires, Argentina";

// ============ Configuración Necochea ============
const NECOCHEA_FLAT_BLOCKS = Number(process.env.SHIPPING_NECOCHEA_FLAT_BLOCKS || 20);
const NECOCHEA_BASE_COST = Number(process.env.SHIPPING_NECOCHEA_BASE_COST || 4000);
const NECOCHEA_PER_BLOCK = Number(process.env.SHIPPING_NECOCHEA_PER_BLOCK || 100);
const NECOCHEA_MAX_BLOCKS = Math.max(0, Number(process.env.SHIPPING_NECOCHEA_MAX_BLOCKS || 0) || 0);
// Una cuadra en Necochea ≈ 100 m (los geocoders devuelven metros)
const NECOCHEA_BLOCK_METERS = Number(process.env.SHIPPING_NECOCHEA_BLOCK_METERS || 100);
// Origen Necochea: Av. 59 1461, Necochea, Buenos Aires, Argentina
const NECOCHEA_ORIGIN_QUERY = "Av. 59 1461, Necochea, Buenos Aires, Argentina";

const ORS_KEY = (process.env.ORS_API_KEY || "").trim();
// Multiplicador línea recta → calles (distancia de ruta aproximada)
const ROAD_FACTOR = 1.25;
// El local es fijo: cacheamos 24 h
const ORIGIN_TTL = 24 * 60 * 60 * 1000;
// Dirección → costo/cuadras: cacheamos 7 días (se repiten muchísimo y así no
// se vuelven a consultar los geocoders por la misma dirección).
const KM_TTL = 7 * 24 * 60 * 60 * 1000;
// Ante un fallo transitorio (429/caída) no volvemos a golpear el servicio
// por 90 s, así el cliente puede reintentar sin saturar nada.
const FAIL_TTL = 90 * 1000;

const GEO_TIMEOUT_MS = 5000; // reducido para que el total no crezca
const USER_AGENT = "FusionWok/1.0 (+https://fusionwok.net)";

// Coordenadas del local por variables de entorno (opcionales).
// Si ambas están definidas y son válidas, se evita geocodificar el origen.
function parseOriginCoords(latEnv, lngEnv, label) {
  const latStr = (process.env[latEnv] || "").trim();
  const lngStr = (process.env[lngEnv] || "").trim();
  if (!latStr || !lngStr) return null; // ausentes: caso normal, sin aviso
  const lat = Number(latStr);
  const lng = Number(lngStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    console.warn(`${latEnv}/${lngEnv}: valores no numéricos, se ignoran`);
    return null;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    console.warn(`${latEnv}/${lngEnv}: fuera de rango lat/lng, se ignoran`);
    return null;
  }
  // Heurística Argentina (aprox): lat ∈ [-56, -21], lng ∈ [-74, -53]
  if (lat < -56 || lat > -21 || lng < -74 || lng > -53) {
    console.warn(`${latEnv}/${lngEnv}: fuera de heurística Argentina, se ignoran`);
    return null;
  }
  return { lat, lng };
}

const ENV_TANDIL_ORIGIN = parseOriginCoords("SHIPPING_ORIGIN_LAT", "SHIPPING_ORIGIN_LNG", "Tandil");
const ENV_NECOCHEA_ORIGIN = parseOriginCoords("SHIPPING_NECOCHEA_ORIGIN_LAT", "SHIPPING_NECOCHEA_ORIGIN_LNG", "Necochea");

// Cache de orígenes por sucursal
const originCache = {
  tandil: { coords: null, at: 0 },
  necochea: { coords: null, at: 0 }
};

const blockCache = new Map(); // clave normalizada → { blocks, cost, at }
const transientFailCache = new Map(); // clave normalizada → { at } (fallos transitorios: 15s)
const definitiveFailCache = new Map(); // clave normalizada → { at, code } (unknown/zone: 90s)

// TTLs diferenciados
const TRANSIENT_FAIL_TTL = 15000; // caché negativo corto para transient
const DEFINITIVE_FAIL_TTL = 90 * 1000; // no cambiar TTL para unknown/zone
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
};

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

function enrichAddress(address, branch) {
  const a = String(address || "").trim();
  if (!a) return "";
  if (branch === "necochea") {
    return /necochea/i.test(a) ? a : `${a}, Necochea, Buenos Aires, Argentina`;
  }
  // tandil (default)
  return /tandil/i.test(a) ? a : `${a}, Tandil, Buenos Aires, Argentina`;
}

function getBranchConfig(branch) {
  if (branch === "necochea") {
    return {
      flatBlocks: NECOCHEA_FLAT_BLOCKS,
      baseCost: NECOCHEA_BASE_COST,
      perBlock: NECOCHEA_PER_BLOCK,
      maxBlocks: NECOCHEA_MAX_BLOCKS,
      blockMeters: NECOCHEA_BLOCK_METERS,
      originQuery: NECOCHEA_ORIGIN_QUERY,
      envOrigin: ENV_NECOCHEA_ORIGIN,
      cacheKey: "necochea"
    };
  }
  // tandil
  if (branch === "tandil") {
    return {
      flatBlocks: TANDIL_FLAT_BLOCKS,
      baseCost: TANDIL_BASE_COST,
      perBlock: TANDIL_PER_BLOCK,
      maxBlocks: TANDIL_MAX_BLOCKS,
      blockMeters: TANDIL_BLOCK_METERS,
      originQuery: TANDIL_ORIGIN_QUERY,
      envOrigin: ENV_TANDIL_ORIGIN,
      cacheKey: "tandil"
    };
  }
  // branch no soportada
  return null;
}

async function getOrigin(branch, opts = {}) {
  const config = getBranchConfig(branch);
  // Si hay coordenadas de entorno válidas, úsalas directo (sin geocodificar ni cachear).
  if (config.envOrigin) return config.envOrigin;
  const cache = originCache[config.cacheKey];
  if (cache.coords && Date.now() - cache.at < ORIGIN_TTL) return cache.coords;
  const o = await geocode(config.originQuery, opts);
  if (!o) throw unknown(`No pudimos ubicar la dirección del local en ${branch}.`);
  cache.coords = o;
  cache.at = Date.now();
  return o;
}

// Devuelve { cost, blocks, supported } para un envío en Tandil o Necochea.
// Reintentar es seguro: los fallos transitorios se cachean brevemente y los
// resultados por dirección se guardan para no repetir consultas.
export async function computeShipping(branch, address) {
  const a = String(address || "").trim();
  const config = getBranchConfig(branch);
  if (!config || !a) {
    return { cost: 0, blocks: 0, supported: !!config };
  }
  const key = `${config.cacheKey}:${normalizeAddressKey(a)}`;
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
    const km = await roadDistanceKm(await getOrigin(branch, { deadline: started + DEADLINE_MS }), dest, { deadline: started + DEADLINE_MS });
    if (Date.now() - started > DEADLINE_MS) {
      throw transient("No pudimos consultar el mapa. Volvé a intentar en unos segundos.");
    }
    const exact = (km * 1000) / config.blockMeters;

    // Fuera de zona de reparto: solo si hay un tope configurado.
    // Sin tope configurado el reparto no tiene límite de cobertura.
    if (config.maxBlocks > 0 && exact > config.maxBlocks) {
      definitiveFailCache.set(key, { at: Date.now(), code: "zone" });
      throw new ShippingError(
        "zone",
        `Esa dirección queda a ${Math.round(exact)} cuadras. Nuestro reparto cubre hasta ${config.maxBlocks} cuadras (~${Math.round((config.maxBlocks * config.blockMeters) / 1000)} km).`
      );
    }

    // Dentro de la franquicia: costo fijo.
    // Después: la primera cuadra entera o parcial que salga de la franquicia
    // paga como extra, igual que cada cuadra adicional.
    let cost, blocks;
    if (exact <= config.flatBlocks) {
      cost = config.baseCost;
      blocks = Math.round(exact);
    } else {
      const extra = Math.ceil(exact) - config.flatBlocks;
      cost = config.baseCost + extra * config.perBlock;
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
}
setInterval(pruneShippingCaches, 10 * 60 * 1000).unref();