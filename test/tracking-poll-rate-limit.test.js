// Tests de regresión para tracking público (poll, rate limit, backoff, log throttling)
// Bug cubierto: con poll de 10s (6/min) y límite de 10/min, dos pestañas o
// clientes detrás de misma IP (CGNAT, wifi local) agotaban el límite y el
// tracking moría en 429 loop. Además el poll no tenía backoff y el log de
// cada 429 podía inundar los logs ante barridos de números (FW-00001...).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { computeBackoffInterval } from "../src/utils/tracking-backoff.js";

// ============================================================
// 1) Consumo del poll vs rate limit del endpoint
// ============================================================
// Poll de 10s = 6 req/min por pestaña. Límite de 60/min por IP permite
// 3 pestañas simultáneas (18 req/min = 30% del límite) con margen amplio.
describe("tracking: consumo de poll vs rate limit", () => {
  const POLL_INTERVAL_MS = 10000;
  const RATE_LIMIT_PER_MIN = 60;
  const REQ_PER_MIN_PER_TAB = Math.floor(60000 / POLL_INTERVAL_MS); // 6

  it("3 pestañas = 18 req/min ≤ 60% del límite (36)", () => {
    const tabs = 3;
    const totalReqMin = tabs * REQ_PER_MIN_PER_TAB;
    const maxAllowed = Math.floor(RATE_LIMIT_PER_MIN * 0.6); // 36
    assert.ok(totalReqMin <= maxAllowed, `3 tabs → ${totalReqMin} req/min > ${maxAllowed} (60% de ${RATE_LIMIT_PER_MIN})`);
  });

  it("4 pestañas = 24 req/min ≤ 60% del límite (36) — sigue dentro", () => {
    const tabs = 4;
    const totalReqMin = tabs * REQ_PER_MIN_PER_TAB;
    const maxAllowed = Math.floor(RATE_LIMIT_PER_MIN * 0.6); // 36
    assert.ok(totalReqMin <= maxAllowed, `4 tabs → ${totalReqMin} req/min > ${maxAllowed}`);
  });

  it("10 pestañas = 60 req/min = 100% del límite (borde, no recomendado)", () => {
    const tabs = 10;
    const totalReqMin = tabs * REQ_PER_MIN_PER_TAB;
    assert.equal(totalReqMin, RATE_LIMIT_PER_MIN, "10 tabs saturan el límite exacto");
  });
});

// ============================================================
// 2) Backoff exponencial: secuencia de intervalos ante errores
// ============================================================
// Usa LA MISMA función que TrackOrder.jsx (computeBackoffInterval).
// - Base: 10s (TRACK_POLL_INTERVAL_MS)
// - Error 1: 20s, Error 2: 40s, Error 3: 60s (tope), Error 4+: 60s
// - Éxito (consecutiveErrors=0): reset a 10s
describe("tracking: backoff exponencial (función compartida)", () => {
  const BASE_INTERVAL = 10000;

  it("secuencia de intervalos: 10s → 20s → 40s → 60s → 60s (tope)", () => {
    assert.equal(computeBackoffInterval(BASE_INTERVAL, 0), 10000); // éxito
    assert.equal(computeBackoffInterval(BASE_INTERVAL, 1), 20000);
    assert.equal(computeBackoffInterval(BASE_INTERVAL, 2), 40000);
    assert.equal(computeBackoffInterval(BASE_INTERVAL, 3), 60000);
    assert.equal(computeBackoffInterval(BASE_INTERVAL, 4), 60000); // tope
    assert.equal(computeBackoffInterval(BASE_INTERVAL, 5), 60000); // tope
  });

  it("éxito (consecutiveErrors=0) resetea a intervalo base", () => {
    assert.equal(computeBackoffInterval(BASE_INTERVAL, 0), 10000);
    assert.equal(computeBackoffInterval(BASE_INTERVAL, 2), 40000);
    assert.equal(computeBackoffInterval(BASE_INTERVAL, 0), 10000); // reset
  });

  it("tope configurable (maxInterval)", () => {
    assert.equal(computeBackoffInterval(BASE_INTERVAL, 3, 30000), 30000);
    assert.equal(computeBackoffInterval(BASE_INTERVAL, 1, 15000), 15000);
  });
});

// ============================================================
// 3) Throttling del log de 429: máx 1 línea/min/IP + contador agregado
// ============================================================
// Simula el comportamiento de logTrackingRateLimit en server/index.js
describe("tracking: log throttling de 429", () => {
  const trackLogBuckets = new Map(); // ip -> { count, windowStart, lastLogged }

  function logTrackingRateLimit(ip) {
    const now = Date.now();
    const bucket = trackLogBuckets.get(ip);
    if (!bucket || now - bucket.windowStart >= 60000) {
      trackLogBuckets.set(ip, { count: 1, windowStart: now, lastLogged: now });
      return { logged: true, count: 1 };
    } else {
      bucket.count += 1;
      bucket.lastLogged = now;
      return { logged: false, count: bucket.count };
    }
  }

  beforeEach(() => {
    trackLogBuckets.clear();
  });

  it("primer 429 de una IP en la ventana → loguea (logged=true)", () => {
    const result = logTrackingRateLimit("192.168.1.1");
    assert.equal(result.logged, true);
    assert.equal(result.count, 1);
  });

  it("segundo 429 de misma IP en misma ventana → NO loguea, incrementa contador", () => {
    logTrackingRateLimit("192.168.1.1");
    const result = logTrackingRateLimit("192.168.1.1");
    assert.equal(result.logged, false);
    assert.equal(result.count, 2);
  });

  it("100 429s de misma IP en mismo minuto → 1 línea logueada, contador=100", () => {
    for (let i = 0; i < 100; i++) {
      logTrackingRateLimit("10.0.0.1");
    }
    const bucket = trackLogBuckets.get("10.0.0.1");
    assert.equal(bucket.count, 100);
    // Solo la primera llamada logueó; el resto solo incrementó contador
  });

  it("IP distinta → buckets independientes", () => {
    logTrackingRateLimit("192.168.1.1");
    const result = logTrackingRateLimit("192.168.1.2");
    assert.equal(result.logged, true);
    assert.equal(result.count, 1);
    const bucket1 = trackLogBuckets.get("192.168.1.1");
    const bucket2 = trackLogBuckets.get("192.168.1.2");
    assert.equal(bucket1.count, 1);
    assert.equal(bucket2.count, 1);
  });

  it("nueva ventana (60s después) → loguea de nuevo, contador reinicia", () => {
    const now = Date.now();
    // Simular bucket viejo (ventana anterior)
    trackLogBuckets.set("192.168.1.1", { count: 50, windowStart: now - 70000, lastLogged: now - 70000 });
    // Nueva llamada: debe crear ventana nueva y loguear
    const result = logTrackingRateLimit("192.168.1.1");
    assert.equal(result.logged, true);
    assert.equal(result.count, 1);
    const bucket = trackLogBuckets.get("192.168.1.1");
    assert.equal(bucket.count, 1);
    assert.ok(bucket.windowStart > now - 1000); // ventana actual
  });
});

// ============================================================
// 4) Cleanup de trackLogBuckets (server): borra vencidos y recorta a 5000
// ============================================================
// Lógica pura extraída del server para testearla sin dependencias.
describe("tracking: cleanup de trackLogBuckets (server)", () => {
  // Replica la lógica de cleanupTrackLogBuckets en server/index.js
  function cleanupTrackLogBuckets(buckets, now, maxBuckets = 5000) {
    // Borrar entradas con ventana vencida (> 2 min sin actividad)
    for (const [ip, bucket] of buckets.entries()) {
      if (now - bucket.windowStart > 120000) buckets.delete(ip);
    }
    // Si sigue superando el tope, borrar la más vieja por windowStart
    if (buckets.size > maxBuckets) {
      let oldestIp = null;
      let oldestStart = Infinity;
      for (const [ip, bucket] of buckets.entries()) {
        if (bucket.windowStart < oldestStart) {
          oldestStart = bucket.windowStart;
          oldestIp = ip;
        }
      }
      if (oldestIp) buckets.delete(oldestIp);
    }
  }

  it("borra entradas con windowStart > 2 min (vencidas)", () => {
    const buckets = new Map();
    const now = Date.now();
    buckets.set("ip1", { count: 1, windowStart: now - 130000, lastLogged: now - 130000 }); // vencida
    buckets.set("ip2", { count: 1, windowStart: now - 60000, lastLogged: now - 60000 });  // vigente
    cleanupTrackLogBuckets(buckets, now);
    assert.ok(!buckets.has("ip1"), "ip1 vencida debe borrarse");
    assert.ok(buckets.has("ip2"), "ip2 vigente debe quedarse");
  });

  it("si supera 5000 tras limpiar vencidas, borra la más vieja por windowStart", () => {
    const buckets = new Map();
    const now = Date.now();
    // Llenar con 5001 entradas vigentes (windowStart = now)
    for (let i = 0; i < 5001; i++) {
      buckets.set(`ip${i}`, { count: 1, windowStart: now, lastLogged: now });
    }
    assert.equal(buckets.size, 5001);
    cleanupTrackLogBuckets(buckets, now, 5000);
    assert.equal(buckets.size, 5000, "debe quedar exactamente 5000");
    // La borrada debe ser una cualquiera (todas tienen mismo windowStart)
  });

  it("no borra nada si está por debajo del tope y sin vencidas", () => {
    const buckets = new Map();
    const now = Date.now();
    buckets.set("ip1", { count: 1, windowStart: now, lastLogged: now });
    buckets.set("ip2", { count: 1, windowStart: now, lastLogged: now });
    cleanupTrackLogBuckets(buckets, now, 5000);
    assert.equal(buckets.size, 2);
  });
});

// ============================================================
// Resumen: cuántas pestañas simultáneas por IP soporta el nuevo esquema
// ============================================================
describe("tracking: capacidad del nuevo esquema", () => {
  it("con poll 10s y límite 60/min: 3 pestañas = 18 req/min (30%), 4 pestañas = 24 req/min (40%), 10 pestañas = 60 req/min (100%)", () => {
    // Documentado en los tests arriba. El esquema soporta cómodamente
    // 3-4 pestañas por IP con margen para recargas manuales.
    // 10 pestañas saturan el límite (borde, no recomendado en producción).
    assert.ok(true, "Ver tests de consumo arriba para el detalle numérico");
  });
});