import { memo, useCallback, useEffect, useRef, useState } from "react";
import ProductCard from "./ProductCard.jsx";
import CustomizeModal from "./CustomizeModal.jsx";
import { useBranchHours } from "../hooks/useBranchHours.js";
import BranchHoursInfo from "./BranchHoursInfo.jsx";
import { IconSearch, IconEmptySearch, IconAlertCircle } from "./ui/icons.jsx";

// ============================================================
// Vista de menú de una sucursal
// - Banner compacto con sucursal, dirección y horarios
// - Búsqueda por nombre de producto
// - Categorías como tabs (chips sticky) con subgrupos
// - qtys: cantidad de cada producto en el carrito (la pinta la tarjeta)
// memo: el estado del carrito vive en StoreApp y llega por props, así que
// tocar el carrito SÍ re-renderiza este menú; el memo de ProductCard hace
// que solo se repinten las tarjetas cuya cantidad cambió.
// ============================================================

// Los nombres de categoría y de subgrupo llegan del panel en
// MAYÚSCULAS ("PROMOS Y COMBOS 晋升", "APTO (SIN TACC) ノータック").
// El menú se lee mejor en sentence case, así que se reescriben
// sólo las letras ASCII: el coreano, el chino y los emojis de
// decoración quedan intactos. El separador con espacio entre un
// emoji y la palabra evita "🔥NOVEDAD" pegado.
function sentenceCase(text) {
  return String(text)
    .toLowerCase()
    .replace(/(\p{Extended_Pictographic})(?=\p{L})/gu, "$1 ")
    .replace(/\p{L}/u, (c) => c.toUpperCase());
}

// La API puede devolver varios grupos sin nombre seguidos (un grupo
// por producto, que es como nacen cuando se cargan desde el panel).
// Cada grupo abría su propia grilla, así que en desktop cada plato
// caía solo en la columna 1 y la mitad derecha quedaba vacía. Los
// grupos sin nombre consecutivos se fusionan en una sola grilla; los
// que tienen nombre siguen separando con su título.
function mergeGroupRuns(groups) {
  const runs = [];
  for (const group of groups) {
    const last = runs[runs.length - 1];
    if (group.name) {
      runs.push({ name: group.name, products: group.products.slice() });
    } else if (last && !last.name) {
      last.products = last.products.concat(group.products);
    } else {
      runs.push({ name: null, products: group.products.slice() });
    }
  }
  return runs;
}

const Menu = memo(function Menu({ menu, branch, pause = null, onAdd, orderMode, qtys = {}, usingFallbackMenu = false }) {
  const [query, setQuery] = useState("");
  const [customizing, setCustomizing] = useState(null);
  const [activeCat, setActiveCat] = useState(() => menu.categories[0]?.id || "");
  const catsRef = useRef(null);
  const [catsHint, setCatsHint] = useState(false);

  // Horarios de la sucursal actual (hook con cache y refresh)
  const { closedLabel, hoursSummary, structuredHours, loading: hoursLoading } = useBranchHours(branch.id);

  // Al cambiar de sucursal (o refrescar el menú) la categoría activa se
  // reinicia a la primera: si quedara apuntando a una categoría de la otra
  // sucursal, la sección se vería vacía sin entender por qué.
  useEffect(() => {
    setActiveCat(menu.categories[0]?.id || "");
  }, [menu]);

  useEffect(() => {
    const el = catsRef.current;
    if (!el) return;
    const update = () => setCatsHint(el.scrollWidth > el.clientWidth + 4 && el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
    update();
    const onWheel = (e) => {
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const canScroll = (dx > 0 && el.scrollLeft < max) || (dx < 0 && el.scrollLeft > 0);
      if (!canScroll) return;
      e.preventDefault();
      el.scrollLeft += dx;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      ro.disconnect();
    };
  }, [activeCat]);

  const search = query.trim().toLowerCase();
  const hasSearch = search.length > 0;

  function countProducts(category) {
    return category.groups.reduce((acc, g) => acc + g.products.length, 0);
  }

  const handleAdd = useCallback((product, opts) => {
    onAdd(product, opts);
  }, [onAdd]);

  const topIds = menu.topProductIds || [];
  const closed = closedLabel();
  const hoursText = hoursSummary() || branch.hours[orderMode]; // fallback al texto fijo si no hay resumen
  // Pausa de pedidos de esta sucursal (viene del menú o de un 423 del
  // checkout). Se muestra el pill y la línea con el motivo y la hora
  // de reapertura; el botón de confirmar se bloquea en el checkout.
  const paused = !!pause?.paused;

  return (
    <div className="menu">
      <div className="menu__banner">
        <div className="menu__banner-inner">
          <div className="menu__banner-top">
            <h1>Nuestro <span className="menu__title-accent">menú</span></h1>
          </div>
          <BranchHoursInfo
            branch={branch}
            pause={pause}
            structuredHours={structuredHours}
            mode="full"
          />
        </div>
      </div>

      {usingFallbackMenu && (
        <div className="menu__fallback-banner" role="status" aria-live="polite">
          <IconAlertCircle size={16} />
          <span>No pudimos actualizar el menú; los precios pueden diferir.</span>
        </div>
      )}

      <div className="menu__sticky">
        <div className="menu__search">
          <div className="menu__search-field">
            <IconSearch className="menu__search-icon" />
            <input
              type="search"
              placeholder="Buscar un plato…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        {!hasSearch && (
          <div className={`menu__cats-wrap ${catsHint ? "is-clipped-right" : ""}`}>
            <nav className="menu__cats" ref={catsRef} aria-label="Categorías del menú">
              {menu.categories.map((cat) => (
                <button
                  key={cat.id}
                  className={`cat-chip ${activeCat === cat.id ? "is-active" : ""}`}
                  aria-pressed={activeCat === cat.id}
                  onClick={() => setActiveCat(cat.id)}
                >
                  {sentenceCase(cat.name)}
                  <span className="cat-chip__count">{countProducts(cat)}</span>
                </button>
              ))}
            </nav>
          </div>
        )}
      </div>

      <div className="menu__content">
        {hasSearch ? (
          <SearchResults menu={menu} search={search} onAdd={handleAdd} onCustomize={setCustomizing} qtys={qtys} onClearSearch={setQuery} />
        ) : (
          menu.categories
            .filter((cat) => cat.id === activeCat)
            .map((cat) => (
              <section className="category" key={cat.id}>
                <div className="category__head">
                  <h2 className="category__name">{sentenceCase(cat.name)}</h2>
                  <span className="category__count">{countProducts(cat)} platos</span>
                </div>
                <div className="category__body">
                  {mergeGroupRuns(cat.groups).map((run, ri) => (
                    <div className="category__group" key={ri}>
                      {run.name && (
                        <div className="subcategory">
                          <span className="subcategory__name">{sentenceCase(run.name)}</span>
                        </div>
                      )}
                      <div className="category__products">
                        {run.products.map((product) => (
                          <ProductCard
                            key={product.id}
                            product={product}
                            isTop={topIds.includes(product.id)}
                            onAdd={handleAdd}
                            onCustomize={setCustomizing}
                            qty={qtys[product.id] || 0}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))
        )}
      </div>

      {customizing && (
        <CustomizeModal
          product={customizing}
          onClose={() => setCustomizing(null)}
          onConfirm={(product, opts) => {
            handleAdd(product, opts);
            setCustomizing(null);
          }}
        />
      )}
    </div>
  );
});

export default Menu;

// Resultados de búsqueda aplanados (muestra la categoría de cada plato)
function SearchResults({ menu, search, onAdd, onCustomize, qtys = {}, onClearSearch }) {
  const results = [];
  for (const cat of menu.categories) {
    for (const group of cat.groups) {
      for (const product of group.products) {
        if (product.name.toLowerCase().includes(search)) {
          results.push({ ...product, categoryName: sentenceCase(cat.name) });
        }
      }
    }
  }

  if (results.length === 0) {
    return (
      <div className="empty-state">
        <IconEmptySearch className="empty-state__icon" />
        <p>No encontramos ningún producto con esa búsqueda.</p>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => onClearSearch("")}
        >
          Ver todo el menú
        </button>
      </div>
    );
  }

  return (
    <>
      <p className="menu__hint">
        {results.length} resultado{results.length > 1 ? "s" : ""}
      </p>
      <div className="menu__results">
        {results.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            categoryName={product.categoryName}
            isTop={(menu.topProductIds || []).includes(product.id)}
            onAdd={onAdd}
            onCustomize={onCustomize}
            qty={qtys[product.id] || 0}
          />
        ))}
      </div>
    </>
  );
}
