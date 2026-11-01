// src/utils/skeleton-delay.js
// Anti-parpadeo para skeleton loaders.
// - shouldShowSkeleton / shouldHideSkeleton: funciones puras, testeables.
// - useDelayedLoading: hook de React que las usa con setTimeout y cleanup.
//   Mostrar el skeleton solo si la carga supera los 200 ms; mantenerlo
//   al menos 300 ms visible para evitar parpadeo.

export const SHOW_AFTER_MS = 200;
export const MIN_VISIBLE_MS = 300;

// Devuelve true si ya pasó el umbral para mostrar el skeleton.
// Evita parpadeo en cargas rapidísimas (< 200 ms).
export function shouldShowSkeleton(elapsedMs, showAfter = SHOW_AFTER_MS) {
  return elapsedMs >= showAfter;
}

// Devuelve true si ya pasó el mínimo de visibilidad para ocultar el skeleton.
// Garantiza que el skeleton se vea al menos 300 ms.
export function shouldHideSkeleton(elapsedMs, minVisible = MIN_VISIBLE_MS) {
  return elapsedMs >= minVisible;
}

import { useCallback, useEffect, useRef, useState } from "react";

// Hook: devuelve true mientras se debe mostrar el skeleton.
export function useDelayedLoading(isLoading, options = {}) {
  const { showAfter = SHOW_AFTER_MS, minVisible = MIN_VISIBLE_MS } = options;
  const [delayed, setDelayed] = useState(false);
  const [showStart, setShowStart] = useState(null);
  const showTimerRef = useRef(null);
  const hideTimerRef = useRef(null);

  const clearTimers = useCallback(() => {
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // Cuando empieza a cargar y aún no se mostró, programar la muestra.
  if (isLoading && !delayed && showStart === null && !showTimerRef.current) {
    showTimerRef.current = setTimeout(() => {
      showTimerRef.current = null;
      setDelayed(true);
      setShowStart(Date.now());
    }, showAfter);
  }

  // Cuando dejó de cargar y se estaba mostrando, programar el ocultado.
  if (!isLoading && delayed && showStart !== null && !hideTimerRef.current) {
    const elapsed = Date.now() - showStart;
    if (shouldHideSkeleton(elapsed, minVisible)) {
      setDelayed(false);
      setShowStart(null);
    } else {
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = null;
        setDelayed(false);
        setShowStart(null);
      }, minVisible - elapsed);
    }
  }

  // Si dejó de cargar y nunca se mostró, asegurar estado limpio.
  if (!isLoading && !delayed && showStart !== null) {
    setShowStart(null);
  }

  return delayed;
}
