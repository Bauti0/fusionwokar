import { memo, useCallback, useEffect, useRef, useState } from "react";
import ProductCard from "./ProductCard.jsx";
import CustomizeModal from "./CustomizeModal.jsx";
import { closedLabel, pauseNotice } from "../utils/schedule.js";
import { IconSearch, IconClock, IconEmptySearch } from "./ui/icons.jsx";

// ============================================================
// Vista de menú de una sucursal
// - Banner compacto con sucursal, dirección y horarios
// - Búsqueda por nombre de producto
// - Categorías como tabs (chips sticky) con subgrupos
// memo: el catálogo no se re-renderiza cuando el carrito cambia
// (el estado del carrito vive en StoreApp, no aquí).
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

const Menu = memo(function Menu({ menu, branch, pause = null, onAdd, orderMode }) {
  const [query, setQuery] = useState("");
  const [customizing, setCustomizing] = useState(null);
  const [activeCat, setActiveCat] = useState(() => menu.categories[0]?.id || "");
  const catsRef = useRef(null);
  const [catsHint, setCatsHint] = useState(false);

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
  const closed = closedLabel(branch.id);
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
          <p className="menu__meta">
            <span className="menu__branch">
              <span className="branch-dot" aria-hidden="true" />
              {branch.name}
            </span>
            <span className="menu__hours">
              <IconClock className="menu__hours-icon" />
              {branch.hours[orderMode]}
            </span>
            {closed && (
              <span className="menu__closed">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
                {closed}
              </span>
            )}
            {paused && (
              <span className="menu__closed">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="6" y="5" width="4" height="14" rx="1" />
                  <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
                Pausado
              </span>
            )}
            <span className="menu__address">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 21s-7-5.1-7-11a7 7 0 1 1 14 0c0 5.9-7 11-7 11z" />
                <circle cx="12" cy="10" r="2.5" />
              </svg>
              {branch.address}
            </span>
          </p>
          {paused && (
            <p className="menu__paused">
              <IconClock className="menu__hours-icon" />
              <span>{pauseNotice(pause)}</span>
            </p>
          )}
          {branch.deliveryInfo && (
            <p className="menu__delivery">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 7h11v8H3z" />
                <path d="M14 10h4l3 3v2h-7" />
                <circle cx="7" cy="17" r="1.6" />
                <circle cx="17" cy="17" r="1.6" />
              </svg>
              <span>{branch.deliveryInfo}</span>
            </p>
          )}
        </div>
      </div>

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
          <SearchResults menu={menu} search={search} onAdd={handleAdd} onCustomize={setCustomizing} />
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
function SearchResults({ menu, search, onAdd, onCustomize }) {
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
          />
        ))}
      </div>
    </>
  );
}
