import { memo, useEffect, useRef, useState } from "react";
import { formatPrice } from "../utils/format.js";
import { track } from "../utils/tracking.js";
import { IconSparkle, IconFlash } from "./ui/icons.jsx";
import ProductImage from "./ProductImage.jsx";

// Extrae { id, version } de URLs tipo /api/images/products/123?v=456
function parseProductImageUrl(url) {
  if (!url || typeof url !== "string") return { id: null, version: null };
  const m = url.match(/^\/api\/images\/products\/(\d+)(?:\?v=(\d+))?/);
  if (!m) return { id: null, version: null };
  return { id: m[1], version: m[2] || null };
}

// ============================================================
// Tarjeta de producto
// Dos estados deliberadamente distintos entre sí:
// - con foto (product--with-image): la imagen ES la tarjeta.
// - sin foto (product--no-image): no hay caja que explicar, es
//   una línea de menú tipográfico cerrada por un filete.
// Antes los dos Estados eran la misma caja y el que no tenía foto
// llevaba un cuadrado con degradado que se leía como un error. Hoy
// 6 de cada 10 platos no tienen foto, así que ese estado es el
// mayoritario y tiene que verse elegido, no un placeholder.
// Muestra nombre, descripción y precio. Si el producto tiene
// extras/variantes abre el modal de personalización; si no,
// "Agregar" lo manda directo al carrito (con feedback visual).
// qty: cuántas unidades de ESTE producto hay en el carrito (suma de
// todas sus líneas); se pinta en el botón redondo, con prioridad
// sobre el flash de confirmación.
// memo: al tipear en la búsqueda o cambiar de categoría solo se
// re-renderizan las tarjetas afectadas, no las 40+ del menú.
// ============================================================
const ProductCard = memo(function ProductCard({ product, categoryName, isTop, onAdd, onCustomize, qty = 0, isAboveFold = false }) {
  const hasExtras = product.extras && product.extras.length > 0;
  const hasOptions = product.optionGroups && product.optionGroups.length > 0;
  const customizable = hasExtras || hasOptions;
  const unavailable = product.available === false;
  const [added, setAdded] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);

  // Parsear la URL de la imagen para extraer id
  // Usar product.imageVersion (del menú API) como prioridad, sino parsear de la URL
  const { id: imageId } = parseProductImageUrl(product.image);
  const version = product.imageVersion || parseProductImageUrl(product.image).version;
  const hasImage = !!imageId && !imgFailed;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  function flash() {
    if (!mountedRef.current) return;
    setAdded(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (mountedRef.current) setAdded(false);
      });
    });
  }

  function handleClick() {
    if (unavailable) return;
    track("product_view");
    if (customizable) onCustomize(product);
    else {
      onAdd(product, { extras: [], notes: "" });
      flash();
    }
  }

  return (
    <div className={`product ${hasImage ? "product--with-image" : "product--no-image"} ${unavailable ? "product--unavailable" : ""}`}>
      {hasImage && (
        <div className="product__media">
          <ProductImage
            imageId={imageId}
            version={version}
            alt={product.name}
            displayWidth={160}
            displayHeight={160}
            aspectRatio={1}
            isAboveFold={isAboveFold}
            onImageError={() => setImgFailed(true)}
          />
        </div>
      )}
      <div className="product__info">
        {unavailable && <span className="product__unavailable-tag">Agotado</span>}
        {categoryName && <span className="product__cat">{categoryName}</span>}
        {isTop && <span className="product__top"><IconFlash /> Más pedido</span>}
        <h4 className="product__name">{product.name}</h4>
        {product.description && <p className="product__desc">{product.description}</p>}
        <div className="product__foot">
          <span className="product__price">{formatPrice(product.price)}</span>
          {customizable && (
            <span className="product__badge">
              <IconSparkle /> Personalizar
            </span>
          )}
        </div>
      </div>
      <button
        data-testid="add-to-cart"
        className={`product__add ${added ? "is-added" : ""}`}
        onClick={handleClick}
        disabled={unavailable}
        aria-label={
          unavailable
            ? `${product.name} no disponible`
            : qty > 0
              ? `Agregar ${product.name} (ya tenés ${qty} en el carrito)`
              : `Agregar ${product.name}`
        }
      >
        {/* El ✓ del flash manda 1,1 s; después queda la cantidad en el carrito.
            "99+" para que de 3 dígitos no desborde el círculo de 44 px. */}
        <span className="plus">{added ? "✓" : qty > 0 ? (qty > 99 ? "99+" : qty) : "+"}</span>
      </button>
    </div>
  );
});

export default ProductCard;
