// ============================================================
// FUSIÓN WOK — Hook para horarios de sucursal (cliente)
// - Pide horarios al endpoint /api/branch-hours/:branchId
// - Cache en memoria con TTL (2-3 min) y refresh al enfocar pestaña
// - Mientras carga o si falla, usa branches.js como respaldo
// - Entrega ventanas al módulo compartido hoursCore
// ============================================================
import { useEffect, useRef, useState } from "react";
import { BRANCHES } from "../data/branches.js";
import {
  isOpenAt,
  toWallclock,
  nextOpening as coreNextOpening,
  closedLabel as coreClosedLabel,
  hoursSummary as coreHoursSummary,
  outsideHoursMessage as coreOutsideHoursMessage,
  branchWindowsFallback,
} from "../utils/hoursCore.js";

const CACHE_TTL = 2 * 60 * 1000; // 2 minutos
const REFRESH_ON_FOCUS_DELAY = 1000; // 1 seg después de enfocar

const cache = new Map(); // branchId -> { windows, timestamp, source }

function branchWindowsFromDays(days) {
  // Convierte { days: [{ dayOfWeek, closed, slots: [{open, close}] }] } a formato windows
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
  // data = { source: "db" | "fallback", days: [...] }
  const windows = branchWindowsFromDays(data.days);
  return { windows, source: data.source };
}

export function useBranchHours(branchId) {
  const [windows, setWindows] = useState(null);
  const [source, setSource] = useState(null); // "db" | "fallback" | null
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const refreshTimer = useRef(null);
  const focusListener = useRef(null);

  // Ventanas de respaldo (branches.js)
  const fallbackWindows = branchId ? branchWindowsFallback(branchId, BRANCHES) : null;

  // Ventanas efectivas: las del server si cargaron, sino fallback
  const effectiveWindows = windows ?? fallbackWindows;

  // Cargar horarios
  const load = async () => {
    if (!branchId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchBranchHours(branchId);
      if (result) {
        setWindows(result.windows);
        setSource(result.source);
        cache.set(branchId, { windows: result.windows, timestamp: Date.now(), source: result.source });
      } else {
        throw new Error("Respuesta inválida");
      }
    } catch (err) {
      setError(err.message);
      // En error, limpiamos windows para que se use el fallback
      setWindows(null);
      setSource("fallback");
    } finally {
      setLoading(false);
    }
  };

  // Iniciar carga y timers
  useEffect(() => {
    // Verificar caché
    const cached = cache.get(branchId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      setWindows(cached.windows);
      setSource(cached.source);
      setLoading(false);
    } else {
      load();
    }

    // Timer de refresh periódico
    refreshTimer.current = setInterval(() => {
      if (!document.hidden) load();
    }, CACHE_TTL);

    // Refresh al enfocar la pestaña
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

  // Funciones que usan las ventanas efectivas con zona Argentina
  const isOpenAtTime = (date) => {
    if (!effectiveWindows) return true;
    const arDate = toWallclock(date);
    return isOpenAt(arDate, effectiveWindows);
  };

  const isNowOpen = () => isOpenAtTime(new Date());

  const nextOpening = (from = new Date()) => {
    if (!effectiveWindows) return null;
    return coreNextOpening(effectiveWindows, from);
  };

  const closedLabel = (now = new Date()) => {
    if (!effectiveWindows) return null;
    return coreClosedLabel(effectiveWindows, now);
  };

  const hoursSummary = () => {
    if (!effectiveWindows) return "";
    return coreHoursSummary(effectiveWindows);
  };

  const outsideHoursMessage = () => {
    if (!effectiveWindows) return "Elegí una fecha y hora dentro de nuestros horarios.";
    return coreOutsideHoursMessage(effectiveWindows);
  };

  return {
    // Estado
    loading,
    error,
    source, // "db" | "fallback" | null
    // Funciones de consulta (usan zona Argentina)
    isOpenAtTime,
    isNowOpen,
    nextOpening,
    closedLabel,
    hoursSummary,
    outsideHoursMessage,
    // Ventanas crudas (para casos especiales)
    windows: effectiveWindows,
  };
}

// Exportar también la conversión para tests
export function branchWindowsFromDaysForTest(days) {
  return branchWindowsFromDays(days);
}