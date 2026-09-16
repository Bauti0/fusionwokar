import { memo, useRef, useState } from "react";
import { formatPrice } from "../utils/format.js";
import { track } from "../utils/tracking.js";
import { IconSparkle } from "./ui/icons.jsx";

// ============================================================
// Tarjeta de producto
// Muestra nombre, descripción y precio. Si el producto tiene
// extras/variantes abre el modal de personalización; si no,
// "Agregar" lo manda directo al carrito (con feedback visual).
// memo: al tipear en la búsqueda o cambiar de categoría solo se
// re-renderizan las tarjetas afectadas, no las 40+ del menú.
// ============================================================
const ProductCard = memo(function ProductCard({ product, categoryName, isTop, onAdd, onCustomize }) {
  const hasExtras = product.extras && product.extras.length > 0;
  const unavailable = product.available === false;
  const [added, setAdded] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const timer = useRef(null);

  // Si la foto no carga (archivo borrado, ruta rota…) caemos al mismo estado
  // visual que los productos sin foto: el div "product__media--blank". El
  // estado persiste para no volver a intentar la misma imagen rota en cada
  // re-render (React podría re-montar el <img> con el mismo src).
  const hasImage = !!product.image && !imgFailed;

  function flash() {
    setAdded(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAdded(false), 1100);
  }

  function handleClick() {
    if (unavailable) return;
    track("product_view");
    if (hasExtras) onCustomize(product);
    else {
      onAdd(product, { extras: [], notes: "" });
      flash();
    }
  }

  return (
    <div className={`product ${unavailable ? "product--unavailable" : ""} ${hasImage ? "product--with-image" : ""}`}>
      {hasImage ? (
        <div className="product__media">
          <img src={product.image} alt={product.name} width="132" height="132" loading="lazy" onError={() => setImgFailed(true)} />
        </div>
      ) : (
        <div className="product__media product__media--blank" aria-hidden="true" />
      )}
      <div className="product__info">
        {categoryName && <span className="product__cat">{categoryName}</span>}
        {isTop && <span className="product__top">🔥 Más pedido</span>}
        <h4 className="product__name">{product.name}</h4>
        {product.description && <p className="product__desc">{product.description}</p>}
        <div className="product__foot">
          <span className="product__price">{formatPrice(product.price)}</span>
          {hasExtras && (
            <span className="product__badge">
              <IconSparkle /> Personalizar
            </span>
          )}
        </div>
      </div>
      <button
        className={`product__add ${added ? "is-added" : ""}`}
        onClick={handleClick}
        disabled={unavailable}
        aria-label={unavailable ? `${product.name} no disponible` : `Agregar ${product.name}`}
      >
        <span className="plus">{added ? "✓" : "+"}</span>
      </button>
      {unavailable && <span className="product__unavailable-tag">Agotado</span>}
    </div>
  );
});

export default ProductCard;
