// src/components/ProductImage.jsx
// Componente único para imágenes de producto con:
// - Variantes responsive (srcset 400w/800w) y ?v= para cache inmutable
// - width/height + aspect-ratio para evitar layout shift
// - decoding="async", loading="lazy" (o "eager" para las primeras 4 del menú)
// - Fondo neutro del tema mientras carga, placeholder skeleton si falla
// - Sin ícono de imagen rota: muestra skeleton del mismo tamaño

import { memo, useEffect, useRef, useState } from "react";

const VALID_WIDTHS = [400, 800];

function buildSrcSet(imageId, version) {
  // Siempre incluye la original como fallback (w=auto)
  const base = `/api/images/products/${imageId}`;
  const v = version ? `?v=${version}` : "";
  const variants = VALID_WIDTHS.map(w => `${base}?w=${w}${v} ${w}w`).join(", ");
  return `${base}${v}, ${variants}`;
}

function buildSizes(displayWidth) {
  // displayWidth: ancho de visualización en px (ej: 160 para tarjetas, 44 para thumbnails)
  // sizes: "(max-width: 400px) 100vw, (max-width: 800px) 50vw, 33vw" etc.
  // Para simplicidad: si displayWidth <= 100 -> 100vw (móvil full), sino el valor fijo
  if (displayWidth <= 100) return "100vw";
  if (displayWidth <= 200) return `${displayWidth}px`;
  return `${displayWidth}px`;
}

export default memo(function ProductImage({
  imageId,
  version,
  displayWidth = 160,
  displayHeight = 160,
  alt = "",
  loading = "lazy",
  fetchPriority = "auto",
  className = "",
  aspectRatio = 1,
  // Para tarjetas del menú: index 0-3 = eager, resto = lazy
  isAboveFold = false,
}) {
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef(null);

  // Si la imagen ya está en caché (complete), mostrarla de inmediato
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && !error && !loaded) {
      setLoaded(true);
    }
  }, [imageId, version, error, loaded]);

  // Determinar loading y fetchPriority según isAboveFold
  const effectiveLoading = isAboveFold ? "eager" : loading;
  const effectiveFetchPriority = isAboveFold ? "high" : fetchPriority;

  if (error) {
    // Placeholder skeleton del mismo tamaño (sin ícono roto)
    return (
      <div
        className={`product-image__wrap product-image__error ${className}`}
        style={{
          width: displayWidth,
          height: displayHeight,
          aspectRatio,
          background: "var(--color-surface)",
        }}
        aria-hidden="true"
      >
        <div className="skeleton" style={{ width: "100%", height: "100%" }} />
      </div>
    );
  }

  const srcSet = buildSrcSet(imageId, version);
  const sizes = buildSizes(displayWidth);

  return (
    <div
      className={`product-image__wrap ${className} ${loaded ? "is-loaded" : ""}`}
      style={{
        width: displayWidth,
        height: displayHeight,
        aspectRatio,
        background: "var(--color-surface)",
      }}
    >
      <img
        ref={imgRef}
        src={`/api/images/products/${imageId}${version ? `?v=${version}` : ""}`}
        srcSet={srcSet}
        sizes={sizes}
        alt={alt}
        width={displayWidth}
        height={displayHeight}
        loading={effectiveLoading}
        fetchPriority={effectiveFetchPriority}
        decoding="async"
        className={`product-image__img ${className} ${loaded ? "is-loaded" : ""}`}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
      />
    </div>
  );
});