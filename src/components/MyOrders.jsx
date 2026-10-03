import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getOrdersByPhone } from "../api.js";
import { formatPrice } from "../utils/format.js";
import { combineOrders } from "../utils/orders.js";
import { phonePlaceholderFor } from "../data/branches.js";
import { IconClock, IconRepeat, IconEmptySearch } from "./ui/icons.jsx";

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

export default function MyOrders({ cart, branch, onBack, onRepeat }) {
  const navigate = useNavigate();
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
  // Momento en que arrancó el cooldown actual: el "Reintentar en Xs" se
  // recalcula siempre desde acá, así nunca deriva ni queda en negativo.
  const cooldownStartedAt = useRef(0);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);

  // Cargar historial local
  useEffect(() => {
    if (cart?.history) setLocalHistory(cart.history);
  }, [cart?.history]);

  // Cargar teléfono guardado y buscar automáticamente
  useEffect(() => {
    const stored = getStoredPhone();
    if (stored) {
      setPhone(stored.phone);
      setPhoneSource(stored.source);
    }
  }, []);

  // Fetch por teléfono con caché
  const fetchOrders = useCallback(async (phoneNumber, isRefresh = false) => {
    const cleanPhone = phoneNumber.trim();
    if (!cleanPhone) {
      setLoading(false);
      return;
    }

    // Intentar caché (solo si no es refresh explícito)
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

  // Ejecutar búsqueda al tener teléfono
  useEffect(() => {
    if (phone) fetchOrders(phone);
  }, [phone, fetchOrders]);

  // Botón "Reintentar" con cooldown
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

  // Cuenta regresiva visible del cooldown: los segundos restantes se derivan
  // del timestamp de inicio (nunca de un contador independiente), clamp a 0 y
  // redondeo hacia arriba.
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

  // Guardar teléfono en fw.lookupPhone (si no está en fw.customer)
  const handlePhoneSubmit = useCallback((e) => {
    e.preventDefault();
    const clean = phone.trim();
    if (!clean) return;
    if (phoneSource !== "customer") {
      try {
        localStorage.setItem("fw.lookupPhone", clean);
      } catch { /* ignore */ }
      setPhoneSource("lookup");
    }
    fetchOrders(clean);
  }, [phone, phoneSource, fetchOrders]);

  const handlePhoneChange = useCallback((e) => {
    setPhone(e.target.value);
    setError("");
  }, []);

  // Aplicar filtro de pending_payment (solo < 2h) a los pedidos del servidor
  const filteredServerOrders = filterPendingPaymentOrders(serverOrders);
  const combined = combineOrders(filteredServerOrders, localHistory, branch?.id);
  
  // Separar: activos normales, "Esperando pago" (MP < 2h), e históricos
  const pendingPaymentOrders = combined.filter((c) => c.order.status === "pending_payment" && c.order.paymentMethod === "mercadopago");
  const normalActive = combined.filter((c) => c.isActive && !(c.order.status === "pending_payment" && c.order.paymentMethod === "mercadopago"));
  const historical = combined.filter((c) => !c.isActive);
  
  const hasAny = combined.length > 0;
  const hasServerData = serverOrders.length > 0;
  const showPhoneField = !phone; // no hay teléfono en customer ni lookup

  const formatDate24h = (iso) => {
    const d = new Date(iso);
    return d.toLocaleString("es-AR", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  };

  const getStatusBadge = (status) => {
    const labels = {
      received: "📥 Recibido", preparing: "👨‍🍳 En elaboración",
      ready: "✅ Listo", out_for_delivery: "🛵 En camino",
      completed: "🍜 Entregado", cancelled: "❌ Cancelado",
      pending_payment: "⏳ Esperando pago",
    };
    return labels[status] || status;
  };

  // Indicador de carga discreto
  const LoadingIndicator = () => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-text-soft)", fontSize: 13, marginTop: 8 }}>
      <svg className="icon-btn" style={{ width: 16, height: 16, animation: "spin 1s linear infinite" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
        <path d="M12 2a10 10 0 0 1 10 10" stroke="var(--color-primary)" strokeOpacity="1" />
      </svg>
      <span>{refreshing ? "Actualizando…" : "Cargando pedidos…"}</span>
    </div>
  );

  // Error state: mensaje claro + botón "Reintentar" prominente
  const ErrorState = () => error ? (
    <div className="track-card" style={{ marginBottom: 16 }}>
      <div style={{ background: "var(--color-primary-soft)", border: "1px solid rgba(229,52,46,0.25)", borderRadius: "var(--radius-sm)", padding: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <strong style={{ color: "var(--color-danger-text)" }}>No se pudieron cargar los pedidos</strong>
        </div>
        <p style={{ color: "var(--color-text-soft)", fontSize: 13, margin: "0 0 12px" }}>{error}</p>
        <div style={{ display: "flex", gap: 8 }}>
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

  // Estado vacío con botón "Ver el menú"
  const EmptyState = () => (
    <div className="track-card">
      <div className="empty-state">
        <IconEmptySearch style={{ width: 52, height: 52, margin: "0 auto 14px", color: "var(--color-border-hi)" }} />
        <p>No tenés pedidos todavía.</p>
        {onBack && (
          <button className="btn btn--primary" style={{ marginTop: 12 }} onClick={onBack}>
            Ver el menú
          </button>
        )}
      </div>
    </div>
  );

  // Render de una orden (común para activos e históricos)
  const renderOrder = ({ order, source, canRepeat }) => (
    <div key={order.orderNumber || order.id} className={order.orderNumber ? "my-order" : "order-card"}>
      {order.orderNumber ? (
        <>
          <Link className="my-order" to={`/track/${order.orderNumber}`}>
            <div className="my-order__head">
              <strong>{order.orderNumber}</strong>
              <span className="badge">{getStatusBadge(order.status)}</span>
            </div>
            <div className="my-order__meta">
              <span>{formatDate24h(order.createdAt || order.date)}</span>
              <strong>{formatPrice(order.total)}</strong>
            </div>
            <div className="cart-item__line" style={{ marginTop: 8 }}>
              <button className="btn btn--primary btn--block" onClick={(e) => { e.preventDefault(); navigate(`/track/${order.orderNumber}`); }}>
                Seguir
              </button>
              {canRepeat && cart && onRepeat && (
                <button className="btn btn--outline" onClick={(e) => { e.preventDefault(); onRepeat(order); }}>
                  <IconRepeat style={{ width: 18, height: 18 }} /> Repetir
                </button>
              )}
            </div>
          </Link>
        </>
      ) : (
        <>
          <div className="order-card__head">
            <span className="order-card__date">{formatDate24h(order.createdAt || order.date)}</span>
            <span className="order-card__total">{formatPrice(order.total)}</span>
          </div>
          <p className="order-card__lines">{order.items?.map((it) => `${it.qty}× ${it.name}`).join(" · ") || (source === "server" ? "—" : "Detalle no disponible")}</p>
          <div className="cart-item__line">
            {canRepeat && order.items?.length && cart && onRepeat && (
              <button className="btn btn--outline" onClick={() => onRepeat(order)}>
                <IconRepeat style={{ width: 18, height: 18 }} /> Repetir pedido
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="app">
      <div className="page">
        <div className="container">
          <h2 className="page__title">Mis pedidos</h2>
          <p className="page__sub">{branch ? branch.name : "Historial local y búsqueda por teléfono"}</p>

          {/* Campo de teléfono SOLO si no hay ninguno guardado */}
          {showPhoneField && (
            <div className="track-card" style={{ marginBottom: 16 }}>
              <h3>
                <IconClock style={{ width: 18, height: 18, display: "inline-block", verticalAlign: "middle", marginRight: 6 }} />
                Ingresá tu teléfono para ver tus pedidos
              </h3>
              <form onSubmit={handlePhoneSubmit} style={{ display: "grid", gap: 10 }}>
                <div className="field">
                  {/* El ejemplo va en minúscula ("ej:") porque va dentro de la
                      frase; el placeholder de la sucursal trae "Ej:". */}
                  <input
                    type="tel" inputMode="tel"
                    placeholder={`Tu celular (${phonePlaceholderFor(branch).toLowerCase()})`}
                    value={phone} onChange={handlePhoneChange}
                    disabled={loading}
                    autoComplete="tel"
                  />
                </div>
                <button className="btn btn--primary btn--block" type="submit" disabled={loading || !phone.trim()}>
                  {loading ? "Buscando…" : "Ver mis pedidos"}
                </button>
              </form>
            </div>
          )}

          {/* Error state: SIEMPRE visible si falló el fetch, nunca muestra "vacío" */}
          {ErrorState()}

          {/* Estados de carga */}
          {loading && !hasAny && !fetchFailed && !showPhoneField && (
            <div className="track-card">
              <div className="empty-state" style={{ padding: 24 }}>
                <div className="big">⏳</div>
                <p>Buscando tus pedidos…</p>
              </div>
            </div>
          )}

          {/* Resultados: SIEMPRE mostramos historial local */}
          {!loading && !showPhoneField && (
            <div>
              {/* "Esperando pago" (MP pending_payment < 2h) */}
              {pendingPaymentOrders.length > 0 && (
                <div className="track-card" style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <h3>⏳ Esperando pago ({pendingPaymentOrders.length})</h3>
                    <LoadingIndicator />
                  </div>
                  {pendingPaymentOrders.map(renderOrder)}
                </div>
              )}

              {/* Pedidos activos normales */}
              {normalActive.length > 0 && (
                <div className="track-card" style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <h3>Pedidos activos ({normalActive.length})</h3>
                    <LoadingIndicator />
                  </div>
                  {normalActive.map(renderOrder)}
                </div>
              )}

              {/* Históricos */}
              {historical.length > 0 && (
                <div className="track-card">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <h3>{historical.some((h) => h.order.orderNumber) ? "Historial" : "Pedidos anteriores"}</h3>
                    <LoadingIndicator />
                  </div>
                  {historical.map(renderOrder)}
                </div>
              )}

              {/* Vacío real: no hay pedidos NI error NI cargando */}
              {!hasAny && !fetchFailed && !error && <EmptyState />}
            </div>
          )}

        </div>
      </div>
      <style jsx>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}