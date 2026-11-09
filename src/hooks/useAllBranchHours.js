// ============================================================
// FUSIÓN WOK — Hook para horarios de TODAS las sucursales (cliente)
// Para la Landing que necesita mostrar estado de todas las sucursales
// ============================================================
import { useEffect, useRef, useState } from "react";
import { BRANCHES } from "../data/branches.js";
import {
  isOpenAt,
  toWallclock,
  closedLabel as coreClosedLabel,
  branchWindowsFallback,
} from "../utils/hoursCore.js";

const CACHE_TTL = 2 * 60 * 1000; // 2 minutos
const REFRESH_ON_FOCUS_DELAY = 1000;

const cache = new Map(); // branchId -> { windows, timestamp, source }

function branchWindowsFromDays(days) {
  const windows = [];
  for (const d of days) {
    if (d.closed) continue;
    for (const s of d.slots) {
      windows.push({ days: [d.dayOfWeek], from: s.open, to: s.close });
    }
  }
  return windows.length ? windows : null;
}

async function fetchBranchHours(branchId) {
  const res = await fetch(`/api/branch-hours/${encodeURIComponent(branchId)}`);
  if (!res.ok) return null;
  const data = await res.json();
  const windows = branchWindowsFromDays(data.days);
  return { windows, source: data.source };
}

export function useAllBranchHours(branchIds = []) {
  const [branchData, setBranchData] = useState({}); // branchId -> { windows, source, loading, error }
  const refreshTimer = useRef(null);
  const focusListener = useRef(null);

  // Ventanas efectivas por sucursal (server o fallback)
  const effectiveWindows = {};
  for (const branchId of branchIds) {
    const data = branchData[branchId];
    const fallback = branchWindowsFallback(branchId, BRANCHES);
    effectiveWindows[branchId] = data?.windows ?? fallback;
  }

  const loadAll = async () => {
    await Promise.all(
      branchIds.map(async (branchId) => {
        try {
          const result = await fetchBranchHours(branchId);
          if (result) {
            setBranchData((prev) => ({
              ...prev,
              [branchId]: { windows: result.windows, source: result.source, loading: false, error: null },
            }));
            cache.set(branchId, { windows: result.windows, timestamp: Date.now(), source: result.source });
          } else {
            throw new Error("Respuesta inválida");
          }
        } catch (err) {
          setBranchData((prev) => ({
            ...prev,
            [branchId]: { windows: null, source: "fallback", loading: false, error: err.message },
          }));
        }
      })
    );
  };

  useEffect(() => {
    // Verificar caché para cada sucursal
    const initialData = {};
    let allCached = true;
    for (const branchId of branchIds) {
      const cached = cache.get(branchId);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        initialData[branchId] = { windows: cached.windows, source: cached.source, loading: false, error: null };
      } else {
        allCached = false;
        initialData[branchId] = { windows: null, source: null, loading: true, error: null };
      }
    }
    setBranchData(initialData);

    if (!allCached) {
      loadAll();
    }

    // Timer de refresh periódico
    refreshTimer.current = setInterval(() => {
      if (!document.hidden) loadAll();
    }, CACHE_TTL);

    // Refresh al enfocar la pestaña
    focusListener.current = () => {
      setTimeout(() => {
        if (!document.hidden) loadAll();
      }, REFRESH_ON_FOCUS_DELAY);
    };
    window.addEventListener("focus", focusListener.current);

    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
      if (focusListener.current) window.removeEventListener("focus", focusListener.current);
    };
  }, [branchIds.join(",")]);

  // Funciones de consulta por sucursal
  const isNowOpen = (branchId) => {
    const windows = effectiveWindows[branchId];
    if (!windows) return true;
    const arNow = toWallclock(new Date());
    return isOpenAt(arNow, windows);
  };

  const closedLabel = (branchId) => {
    const windows = effectiveWindows[branchId];
    if (!windows) return null;
    return coreClosedLabel(windows, new Date());
  };

  return {
    branchData,
    effectiveWindows,
    isNowOpen,
    closedLabel,
  };
}