// ============================================================
// FUSIÓN WOK — Cálculo de envío (Tandil, por ahora)
// Costo = $4.000 base + $1.000 por km (redondeado al km entero).
//   - Origen: Chacabuco 660, Tandil, Buenos Aires.
//   - Geocodificación y distancia por ruta (driving).
//   - Proveedor: Google Maps si GOOGLE_MAPS_API_KEY está
//     seteada; si no, fallback gratuito: Nominatim (OSM) para
//     geocodificar + OSRM para la ruta. Ambos con caché.
//   - MAX_KM evita que direcciones absurdas disparen el costo.
// Necochea aún NO implementado: devuelve costo 0.
// ============================================================

const SHIPPING_BASE_COST = Number(process.env.SHIPPING_BASE_COST || 4000);
const SHIPPING_PER_KM = Number(process.env.SHIPPING_PER_KM || 1000);
const MAX_DELIVERY_KM = Number(process.env.SHIPPING_MAX_KM || 40);
const GOOGLE_KEY = (process.env.GOOGLE_MAPS_API_KEY || "").trim();

const ORIGIN_QUERY = "Chacabuco 660, Tandil, Buenos Aires, Argentina";
const GEO_TIMEOUT_MS = 9000;
const USER_AGENT = "FusionWok-app/1.0 (https://fusionwok.ar)";

// Caché del origen (la dirección del local no cambia): 1 h
let originCoords = null; // { lat, lng }
let originAt = 0;
const ORIGIN_TTL = 60 * 60 * 1000;

// Caché dirección → km (evita repetir geocoding por la misma calle): 30 min
const kmCache = new Map(); // dirección normalizada → { km, at }
const KM_TTL = 30 * 60 * 1000;

// Complementa la dirección con la ciudad para que el geocoder la encuentre
function enrichAddress(address) {
  const a = String(address || "").trim();
  if (!a) return "";
  return /tandil/i.test(a) ? a : `${a}, Tandil, Buenos Aires, Argentina`;
}

async function fetchJson(url) {
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
}

// Geocodifica una dirección → { lat, lng } o null
async function geocode(query) {
  if (GOOGLE_KEY) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${encodeURIComponent(GOOGLE_KEY)}`;
    const j = await fetchJson(url);
    const loc = j?.results?.[0]?.geometry?.location;
    if (j?.status === "OK" && loc) return { lat: loc.lat, lng: loc.lng };
  }
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const j = await fetchJson(url);
  const hit = Array.isArray(j) ? j[0] : null;
  if (hit && hit.lat && hit.lon) return { lat: Number(hit.lat), lng: Number(hit.lon) };
  return null;
}

// Distancia de ruta (driving) en km entre dos coordenadas
async function roadDistanceKm(from, to) {
  if (GOOGLE_KEY) {
    const url =
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${from.lat},${from.lng}` +
      `&destinations=${to.lat},${to.lng}&mode=driving` +
      `&key=${encodeURIComponent(GOOGLE_KEY)}`;
    const j = await fetchJson(url);
    const el = j?.rows?.[0]?.elements?.[0];
    if (el?.status === "OK" && typeof el.distance?.value === "number") {
      return el.distance.value / 1000;
    }
    throw new Error("Google Maps no pudo calcular la distancia");
  }
  // OSRM: router público y gratis (suficiente para un restaurante de barrio)
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false&alternatives=false`;
  const j = await fetchJson(url);
  const meters = j?.routes?.[0]?.distance;
  if (typeof meters === "number") return meters / 1000;
  throw new Error("El servicio de rutas no pudo calcular la distancia");
}

async function getOrigin() {
  if (originCoords && Date.now() - originAt < ORIGIN_TTL) return originCoords;
  const o = await geocode(ORIGIN_QUERY);
  if (!o) throw new Error("No pudimos geocodificar la dirección del local");
  originCoords = o;
  originAt = Date.now();
  return o;
}

// Devuelve { cost, km, supported }.
// Lanzo errores con mensajes "user-friendly" cuando no se puede calcular.
export async function computeShipping(branch, address) {
  const a = String(address || "").trim();
  // Solo Tandil por ahora; Necochea queda sin envío calculado.
  if (branch !== "tandil" || !a) {
    return { cost: 0, km: 0, supported: branch === "tandil" };
  }
  const key = a.toLowerCase();
  const hit = kmCache.get(key);
  let km;
  if (hit && Date.now() - hit.at < KM_TTL) {
    km = hit.km;
  } else {
    const dest = await geocode(enrichAddress(a));
    if (!dest) {
      throw new Error("No pudimos ubicar esa dirección. Revisá calle y número.");
    }
    km = await roadDistanceKm(await getOrigin(), dest);
    kmCache.set(key, { km, at: Date.now() });
  }
  const roundedKm = Math.max(1, Math.ceil(km));
  if (roundedKm > MAX_DELIVERY_KM) {
    throw new Error(
      `Esa dirección queda a ${roundedKm} km. Nuestro reparto cubre hasta ${MAX_DELIVERY_KM} km.`
    );
  }
  return { cost: SHIPPING_BASE_COST + roundedKm * SHIPPING_PER_KM, km: roundedKm, supported: true };
}