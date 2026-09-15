// ============================================================
// FUSIÓN WOK — Cálculo de envío (Tandil, por ahora)
// Regla real:
//   - Las primeras 20 cuadras a la redonda del local: $4.000 fijos.
//   - Cada cuadra extra: $100.
//   - La cuadra en Tandil ≈ 130 m (configurable con SHIPPING_BLOCK_METERS).
//   0 cuadras (la dirección del propio local) también paga $4.000.
//   - Origen: Chacabuco 660, Tandil, Buenos Aires.
//   - Servicios 100% gratis, con respaldos para que una limitación
//     de tráfico (429) o una caída no dejen sin envío:
//       1) Geocoding: Nominatim (OSM) → si falla, Photon (Komoot).
//       2) Ruta por calles: OpenRouteService si ORS_API_KEY está seteada
//          (clave gratuita en openrouteservice.org) → si no, OSRM → si
//          falla, distancia en línea recta (factor ~1.25x).
//   - MAX_BLOCKS evita que direcciones absurdas disparen el costo.
// Necochea aún NO implementado: devuelve costo 0.
// ============================================================

// Franquicia: hasta esta cantidad de cuadras se cobra solo la base
const FLAT_BLOCKS = Number(process.env.SHIPPING_FLAT_BLOCKS || 20);
// Costo fijo de la franquicia (base)
const SHIPPING_BASE_COST = Number(process.env.SHIPPING_BASE_COST || 4000);
// Costo por cuadra extra por encima de la franquicia
const SHIPPING_PER_BLOCK = Number(process.env.SHIPPING_PER_BLOCK || 100);
// Tope de reparto total en cuadras (~39 km con cuadras de 130 m)
const MAX_BLOCKS = Number(process.env.SHIPPING_MAX_BLOCKS || 300);
const ORS_KEY = (process.env.ORS_API_KEY || "").trim();
// Una cuadra en Tandil ≈ 130 m (los geocoders devuelven metros)
const BLOCK_METERS = Number(process.env.SHIPPING_BLOCK_METERS || 130);
// Multiplicador línea recta → calles (distancia de ruta aproximada)
const ROAD_FACTOR = 1.25;
// El local es fijo: cacheamos ~1 h
const ORIGIN_TTL = 60 * 60 * 1000;
// Dirección → cuadras: cacheamos 30 min
const KM_TTL = 30 * 60 * 1000;
// Ante un fallo transitorio (429/caída) no volvemos a golpear el servicio
// por 90 s, así el cliente puede reintentar sin saturar nada.
const FAIL_TTL = 90 * 1000;

const ORIGIN_QUERY = "Chacabuco 660, Tandil, Buenos Aires, Argentina";
const GEO_TIMEOUT_MS = 9000;
const USER_AGENT = "FusionWok-app/1.0 (contacto: instagram.com/fusionwoktandil)";

const blockCache = new Map(); // dirección → { blocks, cost, at }
const failCache = new Map(); // dirección → { at } (fallos transitorios)
let originCoords = null;
let originAt = 0;

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

// Espaciado mínimo entre llamadas externas (~1/s) para ser amables con los
// servicios gratuitos. Global: una petición externa por vez a lo sumo.
let lastExternalCall = 0;
let externalQueue = Promise.resolve();
function throttled(fn) {
  const run = externalQueue.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastExternalCall));
    if (wait) await sleep(wait);
    lastExternalCall = Date.now();
    return fn();
  });
  externalQueue = run.catch(() => {});
  return run;
}

const fetchJson = async (url) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), GEO_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
};

// Intenta de nuevo 2 veces (el 429 puede ser momentáneo)
const withRetry = async (fn, times = 2) => {
  let lastErr;
  for (let i = 0; i <= times; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < times) await sleep(600 * (i + 1));
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
  async (q) => {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const j = await fetchJson(url);
    const hit = Array.isArray(j) ? j[0] : null;
    if (!hit || hit.lat == null || hit.lon == null) return null;
    return { lat: Number(hit.lat), lng: Number(hit.lon) };
  },
  async (q) => {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1`;
    const j = await fetchJson(url);
    const c = j?.features?.[0]?.geometry?.coordinates;
    if (!c || !c.length) return null;
    return { lat: c[1], lng: c[0] };
  },
];

async function geocode(query) {
  return withRetry(() =>
    throttled(async () => {
      let sawTransient = false;
      for (const provider of GEO_PROVIDERS) {
        try {
          const c = await provider(query);
          if (c) return c;
        } catch {
          sawTransient = true;
        }
      }
      if (sawTransient) throw transient("No pudimos consultar el mapa. Volvé a intentar en unos segundos.");
      return null;
    })
  );
}

// Distancia por calles. Orden: OpenRouteService (si hay key) → OSRM → línea
// recta como red de seguridad para que siempre quede una cotización.
async function roadDistanceKm(from, to) {
  if (ORS_KEY) {
    try {
      return await withRetry(() =>
        throttled(async () => {
          const url =
            `https://api.openrouteservice.org/v2/directions/driving-car?api_key=` +
            `${encodeURIComponent(ORS_KEY)}&start=${from.lng},${from.lat}&end=${to.lng},${to.lat}`;
          const j = await fetchJson(url);
          const d = j?.routes?.[0]?.summary?.distance;
          if (typeof d !== "number" || d <= 0) throw new Error("ORS sin ruta");
          return d / 1000;
        })
      );
    } catch {
      /* si ORS falla, seguimos con OSRM */
    }
  }
  try {
    return await withRetry(() =>
      throttled(async () => {
        const url =
          `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat}` +
          `;${to.lng},${to.lat}?overview=false&alternatives=false`;
        const j = await fetchJson(url);
        const m = j?.routes?.[0]?.distance;
        if (typeof m !== "number" || m <= 0) throw new Error("OSRM sin ruta");
        return m / 1000;
      })
    );
  } catch {
    return haversineKm(from, to) * ROAD_FACTOR;
  }
}

function enrichAddress(address) {
  const a = String(address || "").trim();
  if (!a) return "";
  return /tandil/i.test(a) ? a : `${a}, Tandil, Buenos Aires, Argentina`;
}

async function getOrigin() {
  if (originCoords && Date.now() - originAt < ORIGIN_TTL) return originCoords;
  const o = await geocode(ORIGIN_QUERY);
  if (!o) throw unknown("No pudimos ubicar la dirección del local.");
  originCoords = o;
  originAt = Date.now();
  return o;
}

// Devuelve { cost, blocks, supported } para un envío en Tandil.
// Reintentar es seguro: los fallos transitorios se cachean brevemente y los
// resultados por dirección se guardan para no repetir consultas.
export async function computeShipping(branch, address) {
  const a = String(address || "").trim();
  if (branch !== "tandil" || !a) {
    return { cost: 0, blocks: 0, supported: branch === "tandil" };
  }
  const key = a.toLowerCase();

  const cached = blockCache.get(key);
  if (cached && Date.now() - cached.at < KM_TTL) {
    return { cost: cached.cost, blocks: cached.blocks, supported: true };
  }
  const failed = failCache.get(key);
  if (failed && Date.now() - failed.at < FAIL_TTL) {
    throw transient("El servicio de envío está saturado. Volvé a intentar en unos segundos.");
  }

  const dest = await geocode(enrichAddress(a));
  if (!dest) {
    failCache.set(key, { at: Date.now() });
    throw unknown("No pudimos ubicar esa dirección. Revisá calle y número.");
  }
  const km = await roadDistanceKm(await getOrigin(), dest);
  const exact = (km * 1000) / BLOCK_METERS;

  // Fuera de zona de reparto
  if (exact > MAX_BLOCKS) {
    failCache.set(key, { at: Date.now() });
    throw new ShippingError(
      "zone",
      `Esa dirección queda a ${Math.round(exact)} cuadras. Nuestro reparto cubre hasta ${MAX_BLOCKS} cuadras (~${Math.round((MAX_BLOCKS * BLOCK_METERS) / 1000)} km).`
    );
  }

  // Dentro de la franquicia (hasta 20 cuadras): costo fijo.
  // Después: la primera cuadra entera o parcial que salga de la franquicia
  // paga como extra ($100), igual que cada cuadra adicional.
  let cost, blocks;
  if (exact <= FLAT_BLOCKS) {
    cost = SHIPPING_BASE_COST;
    blocks = Math.round(exact);
  } else {
    const extra = Math.ceil(exact) - FLAT_BLOCKS;
    cost = SHIPPING_BASE_COST + extra * SHIPPING_PER_BLOCK;
    blocks = Math.ceil(exact);
  }
  blockCache.set(key, { blocks, cost, at: Date.now() });
  return { cost, blocks, supported: true };
}