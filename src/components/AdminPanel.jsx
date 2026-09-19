import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  adminOrders,
  adminSetStatus,
  adminLogout,
  adminOrder,
  adminStats,
} from "../api.js";
import { BRANCHES, BRANCH_LIST } from "../data/branches.js";
import {
  ORDER_STATUSES,
  STATUS_CANCELLED,
  statusLabel,
  statusEmoji,
  paymentLabel,
} from "../constants.js";
import { formatPrice } from "../utils/format.js";
import { playNewOrderChime } from "../utils/notifySound.js";
import useDialogA11y from "../hooks/useDialogA11y.js";
import { IconEmptySearch } from "./ui/icons.jsx";
import Dropdown from "./ui/Dropdown.jsx";
import Switch from "./ui/Switch.jsx";
import TicketPrint from "./TicketPrint.jsx";
import AdminStats from "./AdminStats.jsx";
import AdminProducts from "./AdminProducts.jsx";
import AdminCoupons from "./AdminCoupons.jsx";
import AdminCustomers from "./AdminCustomers.jsx";
import AdminSales from "./AdminSales.jsx";
import AdminNewOrder from "./AdminNewOrder.jsx";

// ============================================================
// AdminPanel — gestión de pedidos
// - Estadísticas y embudo (con filtro de período)
// - Filtros por sucursal, estado, pago y búsqueda libre
//   (número, nombre, teléfono) + paginación ("Cargar más")
// - Detalle completo + cambio de estado + aviso por WhatsApp
// - Impresión de ticket térmico (80mm)
// - Cupones de descuento
// ============================================================

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h}h ${min % 60}m`;
  const d = Math.floor(h / 24);
  if (d < 30) return `hace ${d}d ${h % 24}h`;
  const mo = Math.floor(d / 30);
  return `hace ${mo} ${mo === 1 ? "mes" : "meses"}`;
}

// Estados que cuentan como "en curso" (todavía no se entregó ni se canceló)
const ACTIVE_STATUS_IDS = new Set(["received", "preparing", "ready", "out_for_delivery"]);
function isActiveOrder(o) {
  return ACTIVE_STATUS_IDS.has(o.status) && o.paymentStatus !== "rejected";
}

// IDs ya vistos por el admin, persistidos para no repetir el sonido
// en cada recarga de la página.
const SEEN_KEY = "fw.admin.seenOrders";
function loadSeen() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveSeen(set) {
  const arr = Array.from(set).slice(-400); // acotado, no crece sin límite
  localStorage.setItem(SEEN_KEY, JSON.stringify(arr));
}

function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="live-clock" title="Hora local (Argentina)">
      🕐 {now.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}
    </span>
  );
}

export default function AdminPanel({ onLogout }) {
  const [section, setSection] = useState("orders"); // "orders" | "stats" | "products" | "coupons"
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [lastWhatsApp, setLastWhatsApp] = useState("");
  const [branch, setBranch] = useState("");
  const [status, setStatus] = useState("");
  const [payment, setPayment] = useState("");
  const [search, setSearch] = useState("");
  const [includePending, setIncludePending] = useState(false);
  const [printOrder, setPrintOrder] = useState(null);
  const [printComanda, setPrintComanda] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const pageRef = useRef(1);
  const seenRef = useRef(loadSeen());
  const [unseenIds, setUnseenIds] = useState(() => new Set());
  const [today, setToday] = useState(null);
  const dialogRef = useDialogA11y({ onClose: () => setSelected(null), isActive: !!selected });
  const navigate = useNavigate();

  // "Rehacer": vuelve a cargar un pedido en el carrito del cliente (store).
  // Usa el mismo bridge de localStorage que useCart.repeatOrder: escribe los
  // items en fw.cart.<branch> y navega a "/" para que el checkout quede listo.
  function rehacerPedido(order) {
    const cartKey = `fw.cart.${order.branch}`;
    let current = [];
    try {
      current = JSON.parse(localStorage.getItem(cartKey) || "[]");
    } catch {
      current = [];
    }
    if (!Array.isArray(current)) current = [];
    const byKey = new Map(current.map((it) => [it.key, it]));
    for (const it of order.items || []) {
      const key = `${it.productId}|${(it.extras || [])
        .map((e) => e.id)
        .sort()
        .join(",")}`;
      const line = {
        key,
        productId: it.productId,
        name: it.name,
        unitPrice: it.unitPrice,
        extras: it.extras || [],
        notes: it.notes || "",
        qty: it.qty,
      };
      const existing = byKey.get(key);
      if (existing) byKey.set(key, { ...existing, qty: existing.qty + line.qty });
      else byKey.set(key, line);
    }
    try {
      localStorage.setItem(cartKey, JSON.stringify(Array.from(byKey.values())));
    } catch {}
    try {
      localStorage.setItem("fw.lastBranch", order.branch);
    } catch {}
    const cust = { name: order.customer?.name || "", phone: order.customer?.phone || "" };
    if (order.orderMode === "delivery") {
      cust.notes = order.notes || "";
      if (order.address) cust.address = order.address;
    }
    try {
      localStorage.setItem("fw.customer", JSON.stringify(cust));
    } catch {}
    try {
      localStorage.setItem(
        "fw.afterRepeat",
        JSON.stringify({ orderMode: order.orderMode || "delivery", openCart: true })
      );
    } catch {}
    navigate("/");
  }

  // Mini resumen del día ("Hoy: $X · N pedidos") para la pestaña de pedidos
  useEffect(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    adminStats({ from: from.toISOString() })
      .then(setToday)
      .catch(() => {});
  }, []);

  const filtersRef = useRef("");

  const load = useCallback(
    async ({ append = false, showSpinner = true } = {}) => {
      if (showSpinner) setLoading(true);
      const filterKey = [branch, status, payment, search, includePending ? "1" : "0"].join("|");
      if (filterKey !== filtersRef.current) {
        filtersRef.current = filterKey;
        pageRef.current = 1;
      }
      const p = append ? pageRef.current + 1 : pageRef.current;
      try {
        const data = await adminOrders({
          branch,
          status,
          payment,
          search,
          includePending: includePending ? "1" : "",
          page: p,
        });
        pageRef.current = p;
        setHasMore(data.hasMore);
        setOrders((prev) => (append ? [...prev, ...data.orders] : data.orders));
        setError("");
      } catch (err) {
        // Tanto "No autorizado" como "Sesión expirada" significan que el token
        // ya no sirve: se cierra la sesión en lugar de dejar un panel fantasma.
        if (err.message === "No autorizado" || err.message === "Sesión expirada") onLogout();
        else setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [branch, status, payment, search, includePending, onLogout]
  );

  // Carga inicial + auto-refresh cada 10 segundos. Se dispara también cuando
  // cambia la identidad de `load` (es decir, cambió un filtro), así el panel
  // NUNCA consulta con filtros viejos (antes había llamadas inmediatas en los
  // onChange del filtro que viajaban con el valor anterior al estado).
  useEffect(() => {
    load();
    const t = setInterval(() => load({ showSpinner: false }), 10000);
    return () => clearInterval(t);
  }, [load]);

  // Detecta pedidos "en curso" nuevos (no vistos todavía) y suena un
  // aviso corto. No suena en la primera carga de la página, solo
  // cuando aparece uno realmente nuevo durante la sesión.
  const loadedOnceRef = useRef(false);
  const prevNotSeenRef = useRef(new Set());
  useEffect(() => {
    const activeIds = orders.filter(isActiveOrder).map((o) => o.id);
    const notSeen = activeIds.filter((id) => !seenRef.current.has(id));
    const isNew = notSeen.some((id) => !prevNotSeenRef.current.has(id));
    // El sonido se dispara FUERA del setState (un updater de React puede
    // ejecutarse dos veces en StrictMode y sonar de más) y solo cuando aparece
    // un pedido nuevo durante la sesión, no en la primera carga.
    if (loadedOnceRef.current && isNew) setTimeout(playNewOrderChime, 0);
    prevNotSeenRef.current = new Set(notSeen);
    setUnseenIds(new Set(notSeen));
    if (orders.length > 0) loadedOnceRef.current = true;
  }, [orders]);

  function markSeen(id) {
    if (!seenRef.current.has(id)) {
      seenRef.current.add(id);
      saveSeen(seenRef.current);
    }
    setUnseenIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function markAllSeen() {
    orders.filter(isActiveOrder).forEach((o) => seenRef.current.add(o.id));
    saveSeen(seenRef.current);
    setUnseenIds(new Set());
  }

  // Búsqueda sin debounce: al cambiar cualquier filtro (incluida la búsqueda)
  // cambia la identidad de `load` y el efecto de carga se re-dispara con el
  // valor NUEVO, sin llamadas duplicadas ni consultas con filtros viejos.

  function openDetailAndMarkSeen(order) {
    markSeen(order.id);
    openDetail(order);
  }

  async function handleSetStatus(orderId, newStatus) {
    try {
      const res = await adminSetStatus(orderId, newStatus);
      if (res.whatsappLink) setLastWhatsApp(res.whatsappLink);
      if (selected?.id === orderId) {
        setSelected(await adminOrder(orderId));
      }
      load({ showSpinner: false });
    } catch (err) {
      if (err.message === "No autorizado" || err.message === "Sesión expirada") onLogout();
      else setError(err.message);
    }
  }

  function openDetail(order) {
    setSelected(order);
    setLastWhatsApp("");
  }

  async function handleLogout() {
    try {
      await adminLogout();
    } catch {
      /* aunque falle, se cierra la sesión local */
    }
    onLogout();
  }

  return (
    <div className="admin">
      <header className="admin__header">
        <div className="admin__header-inner container">
          <div className="admin__title">
            <img src="/assets/logo-wok.jpeg" alt="Fusión Wok" />
            <div>
              <strong>Panel de pedidos</strong>
              <span>{orders.filter(isActiveOrder).length} activos</span>
            </div>
          </div>
          <div className="admin__actions">
            <Link className="btn btn--ghost btn--sm" to="/">
              Ver tienda
            </Link>
            <button className="btn btn--ghost btn--sm" onClick={handleLogout}>
              Salir
            </button>
          </div>
        </div>
      </header>

      <div className="admin-layout">
        <nav className="admin-nav">
          <button
            className={`admin-nav__btn ${section === "orders" ? "is-active" : ""}`}
            onClick={() => setSection("orders")}
          >
            📦 Pedidos
            {unseenIds.size > 0 && <span className="admin-nav__badge">{unseenIds.size}</span>}
          </button>
          <button
            className={`admin-nav__btn ${section === "stats" ? "is-active" : ""}`}
            onClick={() => setSection("stats")}
          >
            📊 Estadísticas
          </button>
          <button
            className={`admin-nav__btn ${section === "products" ? "is-active" : ""}`}
            onClick={() => setSection("products")}
          >
            🍜 Productos
          </button>
          <button
            className={`admin-nav__btn ${section === "coupons" ? "is-active" : ""}`}
            onClick={() => setSection("coupons")}
          >
            🏷️ Cupones
          </button>
          <button
            className={`admin-nav__btn ${section === "customers" ? "is-active" : ""}`}
            onClick={() => setSection("customers")}
          >
            👥 Clientes
          </button>
          <button
            className={`admin-nav__btn ${section === "sales" ? "is-active" : ""}`}
            onClick={() => setSection("sales")}
          >
            💵 Ventas
          </button>
        </nav>

        <div className="container admin__body">

        {section === "stats" && <AdminStats />}

        {section === "products" && <AdminProducts />}

        {section === "coupons" && <AdminCoupons />}

        {section === "customers" && <AdminCustomers />}

        {section === "sales" && <AdminSales />}

        {section === "new-order" && (
          <AdminNewOrder
            onBack={() => setSection("orders")}
            onCreated={() => load({ showSpinner: false })}
            initialBranch={branch}
          />
        )}

        {section === "orders" && (
        <>
        <div className="admin-orders-head">
          {today && (
          <div className="admin-day">
            <span className="admin-day__label">Hoy</span>
            <strong className="admin-day__total">{formatPrice(today?.ventaNeta ?? 0)}</strong>
            <span className="admin-day__sep">·</span>
            <span>{today?.pedidos ?? 0} {today?.pedidos === 1 ? "pedido" : "pedidos"}</span>
            <LiveClock />
          </div>
          )}
          <div className="admin-orders-toolbar">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => setSection("new-order")}
            >
              ➕ Nuevo pedido
            </button>
          </div>
        </div>
        <div className="admin-filters">
          <input
            type="search"
            placeholder="🔎 Buscar por número, nombre o teléfono…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="admin-search"
          />
          <Dropdown
            value={branch}
            onChange={setBranch}
            options={[
              { value: "", label: "Todas las sucursales" },
              ...BRANCH_LIST.map((b) => ({ value: b.id, label: b.name })),
            ]}
            placeholder="Sucursal"
          />
          <Dropdown
            value={status}
            onChange={setStatus}
            options={[
              { value: "", label: "Estado: todos" },
              ...ORDER_STATUSES.map((s) => ({ value: s.id, label: s.label })),
              { value: "cancelled", label: "Cancelados" },
            ]}
            placeholder="Estado"
          />
          <Dropdown
            value={payment}
            onChange={setPayment}
            options={[
              { value: "", label: "Pago: todos" },
              { value: "approved", label: "Pagados" },
              { value: "pending", label: "Pago pendiente" },
              { value: "rejected", label: "Rechazados" },
            ]}
            placeholder="Pago"
          />
          <Switch
            id="include-pending"
            checked={includePending}
            onChange={setIncludePending}
            label="Incluir MP sin pagar"
          />
        </div>

        {error && <div className="form-error">{error}</div>}

        {loading && orders.length === 0 ? (
          <p className="hint">Cargando pedidos…</p>
        ) : orders.length === 0 ? (
          <div className="admin-empty admin-empty--icon">
            <IconEmptySearch className="empty-state__icon" />
            <strong>No hay pedidos con estos filtros.</strong>
            <span>Probá con otra búsqueda o ajustá los filtros.</span>
          </div>
        ) : (
          <div className="admin-orders-wrap">
            {(() => {
              const activeOrders = orders.filter(isActiveOrder);
              const historicOrders = orders.filter((o) => !isActiveOrder(o));
              const splitView = !status; // solo separamos si no hay filtro de estado puntual

const renderOrder = (o) => {
                  const b = BRANCHES[o.branch];
                  const cancelled = o.status === STATUS_CANCELLED.id;
                  const unseen = unseenIds.has(o.id);
                  return (
                    <div
                      key={o.id}
                      className={`admin-order ${cancelled ? "is-cancelled" : ""} ${o.paymentStatus === "rejected" ? "is-rejected" : ""} ${unseen ? "is-unseen" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => openDetailAndMarkSeen(o)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openDetailAndMarkSeen(o);
                        }
                      }}
                    >
                      {unseen && <span className="admin-order__dot" aria-hidden="true" />}
                      <div className="admin-order__top">
                        <strong className="admin-order__num">{o.orderNumber}</strong>
                        <span className="admin-order__time">{timeAgo(o.createdAt)}</span>
                      </div>
                      <div className="admin-order__mid">
                        <span className="badge badge--branch">{b?.name}</span>
                        <span className="admin-order__name">{o.customer.name}</span>
                        {o.source === "whatsapp" && <span className="badge badge--source">💬 WhatsApp</span>}
                        {o.source === "counter" && o.orderMode === "delivery" && (
                          <span className="badge badge--source">🛵 Delivery</span>
                        )}
                        {o.source === "counter" && o.orderMode !== "delivery" && (
                          <span className="badge badge--source">🧍 Mostrador</span>
                        )}
                        {o.shipping?.pending && <span className="badge badge--shipping-pending">⚠️ Envío a confirmar</span>}
                        {o.scheduledFor && <span className="badge" title={`Programado: ${new Date(o.scheduledFor).toLocaleString("es-AR")}`}>🕒</span>}
                      </div>
                      <div className="admin-order__bottom">
                        <span className="badge">{statusEmoji(o.status)} {statusLabel(o.status)}</span>
                        <span className={`badge badge--pay badge--pay-${o.paymentStatus}`}>
                          {o.paymentMethod === "mercadopago" ? "💳 " : "💰 "}
                          {paymentLabel(o.paymentStatus)}
                        </span>
                        <strong className="admin-order__total">{formatPrice(o.total)}</strong>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm admin-order__redo"
                          onClick={(e) => {
                            e.stopPropagation();
                            rehacerPedido(o);
                          }}
                        >
                          🔁 Rehacer
                        </button>
                      </div>
                    </div>
                  );
                };

              if (!splitView) {
                return <div className="admin-orders">{orders.map(renderOrder)}</div>;
              }

              return (
                <>
                  <div className="admin-orders__section-head">
                    <h3>En curso</h3>
                    <span className="admin-orders__count">{activeOrders.length}</span>
                    {unseenIds.size > 0 && (
                      <button type="button" className="btn btn--ghost btn--sm" onClick={markAllSeen}>
                        Marcar todo como visto
                      </button>
                    )}
                  </div>
                  {activeOrders.length === 0 ? (
                    <div className="admin-empty admin-empty--sm">No hay pedidos en curso ahora mismo.</div>
                  ) : (
                    <div className="admin-orders">{activeOrders.map(renderOrder)}</div>
                  )}

                  <div className="admin-orders__section-head admin-orders__section-head--historic">
                    <h3>Históricos</h3>
                    <span className="admin-orders__count">{historicOrders.length}</span>
                  </div>
                  {historicOrders.length === 0 ? (
                    <div className="admin-empty admin-empty--sm">Todavía no hay pedidos históricos.</div>
                  ) : (
                    <div className="admin-orders">{historicOrders.map(renderOrder)}</div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {hasMore && (
          <button
            className="btn btn--ghost btn--block"
            style={{ marginTop: 12 }}
            onClick={() => load({ append: true })}
            disabled={loading}
          >
            {loading ? "Cargando…" : "Cargar más pedidos"}
          </button>
        )}
        </>
        )}
      </div>
      </div>

      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="order-modal-title"
            ref={dialogRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal__head">
              <h3 id="order-modal-title">{selected.orderNumber}</h3>
              <button className="modal__close" onClick={() => setSelected(null)} aria-label="Cerrar">✕</button>
            </div>
            <div className="modal__body">
              <div className="detail-grid">
                <div className="detail-block">
                  <h4>Cliente</h4>
                  <p>{selected.customer.name}</p>
                  <p>{selected.customer.phone}</p>
                  {selected.orderMode === "delivery" && selected.address && (
                    <p>📍 {selected.address}</p>
                  )}
                  {selected.orderMode === "delivery" && selected.notes && (
                    <p className="detail-note">📝 {selected.notes}</p>
                  )}
                </div>
                <div className="detail-block">
                  <h4>Sucursal / Entrega</h4>
                  <p>{BRANCHES[selected.branch]?.name}</p>
                  <p>{selected.orderMode === "delivery" ? "🛵 Delivery" : "🥡 Retiro"}</p>
                  {selected.shipping?.pending && <p className="badge badge--shipping-pending">⚠️ Envío a confirmar</p>}
                  <p>{new Date(selected.createdAt).toLocaleString("es-AR")}</p>
                  {selected.scheduledFor && (
                    <p className="badge">🕒 Programado: {new Date(selected.scheduledFor).toLocaleString("es-AR")}</p>
                  )}
                </div>
                <div className="detail-block">
                  <h4>Pago</h4>
                  <p className={`badge badge--pay badge--pay-${selected.paymentStatus}`}>
                    {paymentLabel(selected.paymentStatus)} · {selected.paymentMethod}
                  </p>
                  {selected.mpPaymentId && <p>ID pago: {selected.mpPaymentId}</p>}
                </div>
              </div>

              <div className="detail-block">
                <h4>Productos</h4>
                <div className="summary">
                  {selected.items.map((item) => (
                    <div className="summary__row" key={item.key || `${item.productId}-${item.name}`}>
                      <span>
                        {item.qty}× {item.name}
                        {item.extras?.length
                          ? ` (${item.extras.map((e) => e.label).join(", ")})`
                          : ""}
                        {item.notes ? ` — "${item.notes}"` : ""}
                      </span>
                      <span>{formatPrice(item.unitPrice * item.qty)}</span>
                    </div>
                  ))}
                  {selected.discount > 0 && (
                    <div className="summary__row">
                      <span>Descuento ({selected.couponCode})</span>
                      <span>−{formatPrice(selected.discount)}</span>
                    </div>
                  )}
                  <div className="summary__row summary__row--total">
                    <span>Total</span>
                    <span>{formatPrice(selected.total)}</span>
                  </div>
                </div>
              </div>

              <div className="detail-block">
                <h4>Estado</h4>
                <div className="status-actions">
                  {ORDER_STATUSES.map((s) => (
                    <button
                      key={s.id}
                      className={`status-btn ${selected.status === s.id ? "is-active" : ""}`}
                      onClick={() => handleSetStatus(selected.id, s.id)}
                    >
                      {s.emoji} {s.label}
                    </button>
                  ))}
                  <button
                    className={`status-btn status-btn--danger ${selected.status === "cancelled" ? "is-active" : ""}`}
                    onClick={() => handleSetStatus(selected.id, "cancelled")}
                  >
                    ❌ {statusLabel("cancelled")}
                  </button>
                </div>
              </div>

              <div className="modal__footer">
                <button
                  className="btn btn--primary btn--block"
                  onClick={() => setPrintOrder(selected)}
                >
                  🖨️ Imprimir ticket
                </button>
                <button
                  className="btn btn--ghost btn--block"
                  onClick={() => setPrintComanda(selected)}
                >
                  🍳 Imprimir comanda (cocina)
                </button>
                {lastWhatsApp && (
                  <a
                    className="btn btn--ghost btn--block"
                    href={lastWhatsApp}
                    target="_blank"
                    rel="noreferrer"
                  >
                    📲 Enviar novedad por WhatsApp
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {printOrder && <TicketPrint order={printOrder} onClose={() => setPrintOrder(null)} />}
      {printComanda && (
        <TicketPrint order={printComanda} variant="comanda" onClose={() => setPrintComanda(null)} />
      )}
    </div>
  );
}