import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getOrdersByPhone } from "../api.js";
import { formatPrice } from "../utils/format.js";
import { combineOrders } from "../utils/orders.js";
import { phonePlaceholderFor } from "../data/branches.js";
import { IconClock, IconRepeat, IconEmptySearch, IconArrowLeft, IconStore } from "./ui/icons.jsx";

const CACHE_KEY = "fw.myOrdersCache";
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutos
const REFRESH_COOLDOWN_MS = 5000; // 5 segundos entre actualizaciones
const PENDING_PAYMENT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 horas

function readCache(phone) {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { phone: cachedPhone, orders, timestamp } = JSON.parse(raw);
    if (cachedPhone !== phone) return null;
    if (Date.now() - timestamp > CACHE_TTL_MS) return null;
    return orders;
  } catch {
    return null;
  }
}

function writeCache(phone, orders) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ phone, orders, timestamp: Date.now() }));
  } catch {
    /* ignore */
  }
}

function getStoredPhone() {
  try {
    const customer = JSON.parse(localStorage.getItem("fw.customer") || "null");
    if (customer?.phone) return { phone: customer.phone, source: "customer" };
  } catch {
    /* ignore */
  }
  try {
    const lookup = localStorage.getItem("fw.lookupPhone");
    if (lookup) return { phone: lookup, source: "lookup" };
  } catch {
    /* ignore */
  }
  return null;
}

// Filtra pedidos pending_payment de MP: solo los menores a 2h
function filterPendingPaymentOrders(orders) {
  const now = Date.now();
  return orders.filter((o) => {
    if (o.status !== "pending_payment") return true;
    if (o.paymentMethod !== "mercadopago") return true; // otros métodos no filtramos
    const created = new Date(o.createdAt).getTime();
    return now - created < PENDING_PAYMENT_MAX_AGE_MS;
  });
}

// Badge de estado limpio: solo texto, color por estado, sin emoji
function StatusBadge({ status }) {
  const config = {
    received: { label: "Recibido", tone: "warn" },
    preparing: { label: "En elaboración", tone: "warn" },
    ready: { label: "Listo", tone: "success" },
    out_for_delivery: { label: "En camino", tone: "success" },
    completed: { label: "Entregado", tone: "success" },
    cancelled: { label: "Cancelado", tone: "danger" },
    pending_payment: { label: "Esperando pago", tone: "warn" },
  };
  const c = config[status] || { label: status, tone: "warn" };
  return <span className={`status-badge status-badge--${c.tone}`}>{c.label}</span>;
}

// Tarjeta de pedido unificada (server + local)
function OrderCard({ order, source, canRepeat, onRepeat, cart, branch }) {
  const formatDate24h = (iso) => {
    const d = new Date(iso);
    return d.toLocaleString("es-AR", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  };

  if (order.orderNumber) {
    return (
      <Link className="order-card order-card--link" to={`/track/${order.orderNumber}`}>
        <div className="order-card__top">
          <strong className="order-card__number">{order.orderNumber}</strong>
          <StatusBadge status={order.status} />
        </div>
        <div className="order-card__meta">
          <span className="order-card__date">{formatDate24h(order.createdAt || order.date)}</span>
          <strong className="order-card__total">{formatPrice(order.total)}</strong>
        </div>
        {canRepeat && cart && onRepeat && (
          <button
            className="order-card__repeat"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRepeat(order); }}
            aria-label="Repetir pedido"
          >
            <IconRepeat style={{ width: 16, height: 16 }} />
            <span>Repetir</span>
          </button>
        )}
      </Link>
    );
  }

  return (
    <article className="order-card">
      <div className="order-card__top">
        <span className="order-card__date">{formatDate24h(order.createdAt || order.date)}</span>
        <strong className="order-card__total">{formatPrice(order.total)}</strong>
      </div>
      <p className="order-card__lines">
        {order.items?.map((it) => `${it.qty}× ${it.name}`).join(" · ") || (source === "server" ? "—" : "Detalle no disponible")}
      </p>
      {canRepeat && order.items?.length && cart && onRepeat && (
        <button className="order-card__repeat" onClick={() => onRepeat(order)}>
          <IconRepeat style={{ width: 16, height: 16 }} />
          <span>Repetir pedido</span>
        </button>
      )}
    </article>
  );
}

export default function MyOrders({ cart, branch, onBack, onRepeat }) {
  const [serverOrders, setServerOrders] = useState([]);
  const [localHistory, setLocalHistory] = useState([]);
  const [phone, setPhone] = useState("");
  const [phoneSource, setPhoneSource] = useState(null); // "customer" | "lookup" | null
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false);
  const cooldownTimer = useRef(null);
  const cooldownStartedAt = useRef(0);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [activeTab, setActiveTab] = useState("activos");

  useEffect(() => {
    if (cart?.history) setLocalHistory(cart.history);
  }, [cart?.history]);

  useEffect(() => {
    const stored = getStoredPhone();
    if (stored) {
      setPhone(stored.phone);
      setPhoneSource(stored.source);
    }
  }, []);

  const fetchOrders = useCallback(async (phoneNumber, isRefresh = false) => {
    const cleanPhone = phoneNumber.trim();
    if (!cleanPhone) {
      setLoading(false);
      return;
    }

    if (!isRefresh) {
      const cached = readCache(cleanPhone);
      if (cached) {
        setServerOrders(cached);
        setLoading(false);
        setFetchFailed(false);
        return;
      }
    }

    setError("");
    if (isRefresh) setRefreshing(true); else setLoading(true);

    let alive = true;
    try {
      const data = await getOrdersByPhone(cleanPhone);
      if (alive) {
        const orders = data.orders || [];
        setServerOrders(orders);
        writeCache(cleanPhone, orders);
        setFetchFailed(false);
      }
    } catch (err) {
      if (alive) {
        const msg = err.message || "";
        if (msg.includes("429") || msg.includes("rate limit")) {
          setError("Demasiadas consultas. Esperá unos minutos y probá 'Reintentar'.");
        } else {
          setError("No se pudieron cargar los pedidos del servidor.");
        }
        setFetchFailed(true);
      }
    } finally {
      if (alive) {
        if (isRefresh) setRefreshing(false); else setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (phone) fetchOrders(phone);
  }, [phone, fetchOrders]);

  const handleRefresh = useCallback(() => {
    if (refreshCooldown || !phone) return;
    fetchOrders(phone, true);
    cooldownStartedAt.current = Date.now();
    setRefreshCooldown(true);
    cooldownTimer.current = setTimeout(() => {
      setRefreshCooldown(false);
      setCooldownRemaining(0);
    }, REFRESH_COOLDOWN_MS);
  }, [phone, refreshCooldown, fetchOrders]);

  useEffect(() => {
    if (!refreshCooldown) return undefined;
    const update = () => {
      const remainingMs = REFRESH_COOLDOWN_MS - (Date.now() - cooldownStartedAt.current);
      setCooldownRemaining(Math.max(0, Math.ceil(remainingMs / 1000)));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [refreshCooldown]);

  const handlePhoneSubmit = useCallback((e) => {
    e.preventDefault();
    const clean = phone.trim();
    if (!clean) return;
    if (phoneSource !== "customer") {
      try { localStorage.setItem("fw.lookupPhone", clean); } catch { /* ignore */ }
      setPhoneSource("lookup");
    }
    fetchOrders(clean);
  }, [phone, phoneSource, fetchOrders]);

  const handlePhoneChange = useCallback((e) => {
    setPhone(e.target.value);
    setError("");
  }, []);

  const filteredServerOrders = filterPendingPaymentOrders(serverOrders);
  const combined = combineOrders(filteredServerOrders, localHistory, branch?.id);

  const pendingPaymentOrders = combined.filter((c) => c.order.status === "pending_payment" && c.order.paymentMethod === "mercadopago");
  const normalActive = combined.filter((c) => c.isActive && !(c.order.status === "pending_payment" && c.order.paymentMethod === "mercadopago"));
  const historical = combined.filter((c) => !c.isActive);

  const groups = [
    { id: "activos", label: "Activos", orders: normalActive },
    { id: "esperando", label: "Esperando pago", orders: pendingPaymentOrders },
    { id: "historial", label: historical.some((h) => h.order.orderNumber) ? "Historial" : "Pedidos anteriores", orders: historical },
  ].filter((g) => g.orders.length > 0);

  const visibleGroup = groups.find((g) => g.id === activeTab) || groups[0] || null;
  const hasAny = combined.length > 0;
  const showPhoneField = !phone;

  const LoadingIndicator = () => (
    <div className="loading-indicator" role="status" aria-live="polite">
      <svg className="loading-indicator__spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
        <path d="M12 2a10 10 0 0 1 10 10" stroke="var(--color-primary)" strokeOpacity="1" />
      </svg>
      <span>{refreshing ? "Actualizando…" : "Cargando pedidos…"}</span>
    </div>
  );

  const ErrorState = () => error ? (
    <div className="error-state">
      <div className="error-state__icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
      <div className="error-state__content">
        <strong>No se pudieron cargar los pedidos</strong>
        <p>{error}</p>
        <div className="error-state__actions">
          <button className="btn btn--primary" onClick={handleRefresh} disabled={refreshCooldown}>
            {refreshCooldown ? `Reintentar en ${cooldownRemaining}s` : "Reintentar"}
          </button>
          {phoneSource === "lookup" && (
            <button className="btn btn--ghost" onClick={() => {
              try { localStorage.removeItem("fw.lookupPhone"); } catch {}
              setPhone("");
              setPhoneSource(null);
              setError("");
            }}>
              Cambiar teléfono
            </button>
          )}
        </div>
      </div>
    </div>
  ) : null;

  const EmptyState = () => (
    <div className="empty-state">
      <IconEmptySearch className="empty-state__icon" />
      <p>No tenés pedidos todavía.</p>
      {onBack && (
        <button className="btn btn--primary" style={{ marginTop: 12 }} onClick={onBack}>
          <IconStore className="btn__icon" width="20" height="20" />
          Ver el menú
        </button>
      )}
    </div>
  );

  return (
    <div className="app">
      <div className="page">
        <div className="container">
          <header className="my-orders__header">
            <h1 className="my-orders__title">Mis pedidos</h1>
            <p className="my-orders__subtitle">{branch ? branch.name : "Historial local y búsqueda por teléfono"}</p>
          </header>

          {showPhoneField && (
            <div className="phone-field">
              <h2>
                <IconClock style={{ width: 20, height: 20, display: "inline-block", verticalAlign: "middle", marginRight: 8 }} />
                Ingresá tu teléfono para ver tus pedidos
              </h2>
              <form onSubmit={handlePhoneSubmit} className="phone-field__form">
                <div className="field">
                  <input
                    type="tel" inputMode="tel"
                    placeholder={`Tu celular (${phonePlaceholderFor(branch).toLowerCase()})`}
                    value={phone} onChange={handlePhoneChange}
                    disabled={loading} autoComplete="tel"
                  />
                </div>
                <button className="btn btn--primary btn--block" type="submit" disabled={loading || !phone.trim()}>
                  {loading ? "Buscando…" : "Ver mis pedidos"}
                </button>
              </form>
            </div>
          )}

          {ErrorState()}

          {loading && !hasAny && !fetchFailed && !showPhoneField && (
            <div className="skeleton-container">
              <div className="orders-skeleton" aria-hidden="true">
                <div className="skeleton sk-order" />
                <div className="skeleton sk-order" />
                <div className="skeleton sk-order" />
              </div>
              <p className="hint">Buscando tus pedidos…</p>
            </div>
          )}

          {!loading && !showPhoneField && (
            <div>
              {groups.length > 1 && (
                <nav className="orders-tabs" role="tablist" aria-label="Grupos de pedidos">
                  {groups.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      role="tab"
                      aria-selected={visibleGroup?.id === g.id}
                      className={`orders-tab ${visibleGroup?.id === g.id ? "is-active" : ""}`}
                      onClick={() => setActiveTab(g.id)}
                    >
                      {g.label}
                      <span className="orders-tab__count">{g.orders.length}</span>
                    </button>
                  ))}
                </nav>
              )}

              {visibleGroup && (
                <div className="orders-list">
                  {refreshing && <LoadingIndicator />}
                  {visibleGroup.orders.map(({ order, source, canRepeat }) => (
                    <OrderCard
                      key={order.orderNumber || order.id}
                      order={order}
                      source={source}
                      canRepeat={canRepeat}
                      onRepeat={onRepeat}
                      cart={cart}
                      branch={branch}
                    />
                  ))}
                </div>
              )}

              {!hasAny && !fetchFailed && !error && <EmptyState />}
            </div>
          )}

        {onBack && (
            <button className="my-orders__back" onClick={onBack} aria-label={branch ? "Volver al menú" : "Volver al inicio"}>
              <IconArrowLeft style={{ width: 20, height: 20 }} />
              <span>{branch ? "Volver al menú" : "Volver al inicio"}</span>
            </button>
          )}

        </div>
      </div>
      <style jsx>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}