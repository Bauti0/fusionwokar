// src/components/FadeImage.jsx
// Imagen con relación de aspecto fija y fade-in al cargar.
// - Comprueba img.complete al montar (caché) para no quedar en opacity 0.
// - onError muestra un placeholder skeleton en vez de hueco invisible.
// - Respeta prefers-reduced-motion (sin animación si reduce, vía CSS).
import { useEffect, useRef, useState } from "react";

export default function FadeImage({ src, alt, width, height, className = "", aspectRatio = 1, placeholderOnError = true, onImageError }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const imgRef = useRef(null);

  // Si la imagen ya está en caché (complete), mostrarla de inmediato.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && !error && !loaded) {
      setLoaded(true);
    }
  }, [src, error, loaded]);

  if (error) {
    if (onImageError) onImageError();
    if (!placeholderOnError) return null;
    return (
      <div className="fade-image__placeholder" style={{ aspectRatio }}>
        <div className="skeleton" style={{ width: "100%", height: "100%" }} />
      </div>
    );
  }

  return (
    <div className="fade-image__wrap" style={{ aspectRatio }}>
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        width={width}
        height={height}
        loading="lazy"
        decoding="async"
        className={`fade-image__img ${className} ${loaded ? "is-loaded" : ""}`}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
      />
    </div>
  );
}
