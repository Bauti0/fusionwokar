// ============================================================
// FUSIÓN WOK — Configuración de envío por sucursal (guardada en BD)
// ============================================================
// Valores que el operador puede editar desde el panel (uno por sucursal):
//   origen (dirección, lat, lng), precio base, cuadras incluidas,
//   precio por cuadra extra y máximo de cuadras de reparto, más el
//   interruptor de cálculo automático (auto_enabled).
//
// Los valores de `.env` / código de hoy son ahora SOLO el valor inicial
// de la semilla y el respaldo ante fallos de BD:
//   - al arrancar, si una sucursal no tiene fila en BD, se crea con estos
//     valores (leídos del .env o del código, tal como se leían hoy);
//   - si la BD falla, se usan los mismos valores como respaldo,
//     SIN romper el checkout.
// Nunca se pisa una fila existente.
//
// Secretos (ORS_API_KEY) y constantes técnicas (radio de sanidad 50 km,
// radio de búsqueda, factor ruta, metros por cuadra) NO viven en la BD
// ni se exponen en las respuestas públicas; se mantienen acá y en .env.
// ============================================================

// Radio de sanity: si el punto elegido queda más lejos del origen, se trata
// como "no ubicada" (envío a confirmar). 50 km para todas las sucursales.
export const SANITY_RADIUS_KM = 50;
// Radio de búsqueda para anclar el geocodificador ORS a Necochea.
export const SEARCH_RADIUS_KM = 14;
// Multiplicador línea recta → calles (distancia de ruta aproximada).
export const ROAD_FACTOR = 1.25;
// Metros que mide una cuadra (conversión metros → cuadras). Constante
// técnica: no es editable desde el panel ni se guarda en BD.
export const DEFAULT_BLOCK_METERS = {
  tandil: 130,
  necochea: 100,
};

// Valores iniciales de la semilla (los de .env / código cuando no hay env
// vars específicas). Coordenadas del local: si están, se usan directamente.
export const DEFAULT_SHIPPING = {
  tandil: {
    geocoder: "legacy",
    originAddress: "Chacabuco 660, Tandil, Buenos Aires, Argentina",
    originLat: null,
    originLng: null,
    city: "Tandil",
    region: "Buenos Aires",
    country: "Argentina",
    center: { lat: -37.32154, lng: -59.13024 },
    sanityRadiusKm: SANITY_RADIUS_KM,
    blockMeters: DEFAULT_BLOCK_METERS.tandil,
    flatBlocks: 20,
    baseCost: 4000,
    perBlock: 100,
    maxBlocks: 0, // 0 = sin tope de cobertura
    autoEnabled: 1,
  },
  necochea: {
    geocoder: "ors-anclado",
    originAddress: "Diagonal San Martín 1258, Necochea, Buenos Aires, Argentina",
    originLat: null,
    originLng: null,
    city: "Necochea",
    region: "Buenos Aires",
    country: "Argentina",
    center: { lat: -38.5670514, lng: -58.7293811 },
    searchRadiusKm: SEARCH_RADIUS_KM,
    sanityRadiusKm: SANITY_RADIUS_KM,
    blockMeters: DEFAULT_BLOCK_METERS.necochea,
    flatBlocks: 20,
    baseCost: 4000,
    perBlock: 100,
    maxBlocks: 0, // 0 = sin tope de cobertura
    autoEnabled: 1,
  },
};

export const VALID_BRANCHES = ["necochea", "tandil"];

// Lee una variable numérica de envío con prioridad por sucursal sobre la
// global, igual que lo hacía el código original (branchEnv).
function envNumber(branch, suffix, fallback) {
  const upper = String(branch || "").toUpperCase();
  const v = Number(
    process.env[`SHIPPING_${suffix}_${upper}`] ||
      process.env[`SHIPPING_${suffix}`] ||
      fallback
  );
  return Number.isFinite(v) ? v : fallback;
}

// Construye la configuración efectiva a partir del entorno / código
// (semilla o respaldo de BD). Es la misma fuente que leía el sistema hoy.
export function envConfig(branch) {
  const d = DEFAULT_SHIPPING[branch] || DEFAULT_SHIPPING.tandil;
  return {
    geocoder: d.geocoder,
    originAddress: d.originAddress,
    originLat: d.originLat,
    originLng: d.originLng,
    city: d.city,
    region: d.region,
    country: d.country,
    center: d.center,
    searchRadiusKm: d.searchRadiusKm,
    sanityRadiusKm: d.sanityRadiusKm,
    blockMeters: envNumber(branch, "BLOCK_METERS", d.blockMeters),
    flatBlocks: envNumber(branch, "FLAT_BLOCKS", d.flatBlocks),
    baseCost: envNumber(branch, "BASE_COST", d.baseCost),
    perBlock: envNumber(branch, "PER_BLOCK", d.perBlock),
    maxBlocks: Math.max(0, envNumber(branch, "MAX_BLOCKS", d.maxBlocks)),
    autoEnabled: 1,
  };
}

// Caché en memoria: 30 s por sucursal. Se invalida al guardar.
const SETTINGS_TTL = 30 * 1000;
const cache = new Map(); // branch → { config, at }

// Callback opcional para avisar a shipping.js que invalide sus propios
// cachés (origen) cuando la configuración se guarda. Se registra desde
// shipping.js para evitar dependencia circular.
let onSettingsSaved = null;
export function onShippingSettingsSaved(cb) {
  onSettingsSaved = cb;
}

function rowToConfig(branch, row) {
  const d = DEFAULT_SHIPPING[branch] || DEFAULT_SHIPPING.tandil;
  return {
    geocoder: d.geocoder,
    originAddress: row.origin_address != null ? String(row.origin_address) : d.originAddress,
    originLat: row.origin_lat != null ? Number(row.origin_lat) : d.originLat,
    originLng: row.origin_lng != null ? Number(row.origin_lng) : d.originLng,
    city: d.city,
    region: d.region,
    country: d.country,
    center: d.center,
    searchRadiusKm: d.searchRadiusKm,
    sanityRadiusKm: d.sanityRadiusKm,
    blockMeters: d.blockMeters,
    flatBlocks: row.flat_blocks != null ? Number(row.flat_blocks) : d.flatBlocks,
    baseCost: row.base_cost != null ? Number(row.base_cost) : d.baseCost,
    perBlock: row.per_block != null ? Number(row.per_block) : d.perBlock,
    maxBlocks: row.max_blocks != null ? Number(row.max_blocks) : d.maxBlocks,
    autoEnabled: row.auto_enabled == null ? d.autoEnabled : Number(row.auto_enabled) === 0 ? 0 : 1,
    updatedAt: row.updated_at || null,
    updatedBy: row.updated_by || null,
  };
}

// Devuelve la configuración efectiva de envío para una sucursal.
// - Si hay fila en BD, la usa.
// - Si no hay fila, devuelve los valores del entorno / código (sin escribir;
//   el arranque del server encarga de sembrar todas las sucursales).
// - Si la BD falla, devuelve los mismos valores como respaldo y lo registra
//   en el log, SIN romper el checkout.
export async function getShippingSettings(db, branch) {
  const now = Date.now();
  const cached = cache.get(branch);
  if (cached && now - cached.at < SETTINGS_TTL) return cached.config;

  let config;
  try {
    const row = await db
      .prepare("SELECT * FROM branch_shipping_settings WHERE branch = ?")
      .get(branch);
    if (row) {
      config = rowToConfig(branch, row);
      // Sólo la configuración guardada en BD se cachea (30 s); el fallback de
      // entorno/código se lee fresco cada vez, para que los cambios de entorno
      // surtan efecto sin esperar el TTL.
      cache.set(branch, { config, at: now });
      return config;
    }
    config = envConfig(branch);
  } catch (err) {
    console.warn(
      `[shipping-settings] BD falló para "${branch}", usando valores de respaldo: ${err.message}`
    );
    config = envConfig(branch);
  }
  return config;
}

export async function saveShippingSettings({ db, branch, values, adminUserId, adminUsername, adminRole }) {
  const d = DEFAULT_SHIPPING[branch] || DEFAULT_SHIPPING.tandil;
  const previous = await getShippingSettings(db, branch); // caché, BD o respaldo

  const ts = new Date().toISOString();
  const by = adminUsername || "superadmin";

  const originAddress = values.origin_address != null ? String(values.origin_address).trim() : previous.originAddress || d.originAddress;
  const originLat = values.origin_lat != null ? Number(values.origin_lat) : previous.originLat;
  const originLng = values.origin_lng != null ? Number(values.origin_lng) : previous.originLng;
  const baseCost = Number(values.base_cost ?? previous.baseCost);
  const flatBlocks = Number(values.flat_blocks ?? previous.flatBlocks);
  const perBlock = Number(values.per_block ?? previous.perBlock);
  const maxBlocks = Number(values.max_blocks ?? previous.maxBlocks);
  const autoEnabled = values.auto_enabled == null ? previous.autoEnabled : Number(values.auto_enabled) === 0 ? 0 : 1;

  const changed = [];
  const addChange = (field, oldValue, newValue) => {
    if (String(oldValue) !== String(newValue)) changed.push({ field, old: String(oldValue), new: String(newValue) });
  };
  addChange("origen", previous.originAddress, originAddress);
  addChange("origen_lat", previous.originLat, originLat);
  addChange("origen_lng", previous.originLng, originLng);
  addChange("precio base", previous.baseCost, baseCost);
  addChange("cuadras incluidas", previous.flatBlocks, flatBlocks);
  addChange("precio por cuadra extra", previous.perBlock, perBlock);
  addChange("máximo de cuadras", previous.maxBlocks, maxBlocks);
  addChange("cálculo automático", previous.autoEnabled, autoEnabled);

  const sql = `
    INSERT INTO branch_shipping_settings
      (branch, origin_address, origin_lat, origin_lng, base_cost, flat_blocks, per_block, max_blocks, auto_enabled, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(branch) DO UPDATE SET
      origin_address = excluded.origin_address,
      origin_lat = excluded.origin_lat,
      origin_lng = excluded.origin_lng,
      base_cost = excluded.base_cost,
      flat_blocks = excluded.flat_blocks,
      per_block = excluded.per_block,
      max_blocks = excluded.max_blocks,
      auto_enabled = excluded.auto_enabled,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `;
  const args = [
    branch,
    originAddress,
    originLat,
    originLng,
    baseCost,
    flatBlocks,
    perBlock,
    maxBlocks,
    autoEnabled,
    ts,
    by,
  ];

  const statements = [{ sql, args }];
  for (const c of changed) {
    statements.push({
      sql: `INSERT INTO branch_shipping_settings_log
            (branch, admin_user_id, admin_username, admin_role, field, old_value, new_value, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [branch, adminUserId, by, adminRole, c.field, c.old, c.new, ts],
    });
  }

  await db.batch(statements, "write");

  cache.delete(branch);
  if (onSettingsSaved) onSettingsSaved(branch);
  return { ok: true, branch, changed };
}
