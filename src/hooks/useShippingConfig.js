// ============================================================
// FUSIÓN WOK — Hook de configuración de envío de la tienda (cliente)
// - Pide la configuración pública a /api/shipping-config/:branch
// - Cache en memoria con TTL (2 min) y refresh al enfocar pestaña
// - Mientras carga o si falla, usa los valores actuales del código
// ============================================================
import { useEffect, useRef, useState } from "react";
import { DEFAULT_SHIPPING_CONFIG } from "../utils/shippingText.js";

const CACHE_TTL = 2 * 60 * 1000; // 2 minutos
const REFRESH_ON_FOCUS_DELAY = 1000; // 1 seg después de enfocar

const cache = new Map(); // branchId → { config, timestamp }

async function fetchShippingConfig(branchId) {
  const res = await fetch(`/api/shipping-config/${encodeURIComponent(branchId)}`);
  if (!res.ok) return null;
  return res.json(); // { auto_enabled, base_cost, flat_blocks, per_block, max_blocks }
}

export function useShippingConfig(branchId) {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const refreshTimer = useRef(null);
  const focusListener = useRef(null);

  const fallbackConfig = DEFAULT_SHIPPING_CONFIG;
  const effectiveConfig = config ?? fallbackConfig;

  const load = async () => {
    if (!branchId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchShippingConfig(branchId);
      if (result) {
        setConfig(result);
        cache.set(branchId, { config: result, timestamp: Date.now() });
        setError(null);
      } else {
        throw new Error("Respuesta inválida");
      }
    } catch (err) {
      setError(err.message);
      setConfig(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!branchId) return;
    const cached = cache.get(branchId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      setConfig(cached.config);
      setLoading(false);
    } else {
      load();
    }

    refreshTimer.current = setInterval(() => {
      if (!document.hidden) load();
    }, CACHE_TTL);

    focusListener.current = () => {
      setTimeout(() => {
        if (!document.hidden) load();
      }, REFRESH_ON_FOCUS_DELAY);
    };
    window.addEventListener("focus", focusListener.current);

    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
      if (focusListener.current) window.removeEventListener("focus", focusListener.current);
    };
  }, [branchId]);

  return {
    config: effectiveConfig,
    loading,
    error,
    source: config ? "api" : "fallback",
  };
}
