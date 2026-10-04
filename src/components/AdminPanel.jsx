import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  adminOrders,
  adminSetStatus,
  adminLogout,
  adminOrder,
  adminSetShipping,
  adminRefund,
  adminStats,
  adminBranchPause,
  adminSetBranchPause,
} from "../api.js";
import { BRANCHES, BRANCH_LIST } from "../data/branches.js";
import { arClockLabel } from "../utils/schedule.js";
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
import { IconEmptySearch, IconRepeat, IconPlus } from "./ui/icons.jsx";
import Dropdown from "./ui/Dropdown.jsx";
import Switch from "./ui/Switch.jsx";
import ConfirmModal from "./ui/ConfirmModal.jsx";
import PauseModal from "./ui/PauseModal.jsx";
import TicketPrint from "./TicketPrint.jsx";
import AdminStats from "./AdminStats.jsx";
import AdminProducts from "./AdminProducts.jsx";
import AdminCoupons from "./AdminCoupons.jsx";
import AdminCustomers from "./AdminCustomers.jsx";
import AdminSales from "./AdminSales.jsx";
import AdminNewOrder from "./AdminNewOrder.jsx";
import AdminUsers from "./AdminUsers.jsx";

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
// Un pedido programado para más adelante (con +1h de holgura) no cuenta como
// "en curso" ni dispara el aviso sonoro hasta que llegue su momento.
function isFutureScheduled(o) {
  if (!o?.scheduledFor) return false;
  const t = new Date(o.scheduledFor).getTime();
  return !Number.isNaN(t) && t > Date.now() + 60 * 60000;
}
function isActiveOrder(o) {
  return ACTIVE_STATUS_IDS.has(o.status) && o.paymentStatus !== "rejected" && !isFutureScheduled(o);
}

// Hash corto del commit con el que se compiló la app. vite.config.js lo
// inyecta como constante global (ver "define") al arrancar el dev server o
// al hacer el build; el "?" es el fallback cuando no se pudo leer el hash
// (build sin la carpeta .git) y en ese caso no se dibuja nada.
const BUILD_COMMIT = typeof __APP_COMMIT__ === "undefined" ? "?" : __APP_COMMIT__;

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

export default function AdminPanel({ me, onLogout }) {
  const [section, setSection] = useState("orders"); // "orders" | "stats" | "products" | "coupons"
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  // Pedido original al rehacer: se pasa a AdminNewOrder para precargar
  // productos, modo de entrega y cliente. Se limpia al volver, al crear
  // el pedido nuevo y con el botón "Nuevo pedido" del toolbar.
  const [repeatOrder, setRepeatOrder] = useState(null);
  const [lastWhatsApp, setLastWhatsApp] = useState("");
  // El admin de sucursal NO elige sucursal: su `branch` es SIEMPRE
  // me.branch (el server además filtra por la sesión, esto es solo
  // lo que se le muestra). El dropdown queda para el superadmin.
  const isBranchAdmin = me?.role === "branch_admin";
  const [branchFilter, setBranchFilter] = useState("");
  const branch = isBranchAdmin ? me.branch : branchFilter;
  const [status, setStatus] = useState("");
  const [payment, setPayment] = useState("");
  const [search, setSearch] = useState("");
  const [includePending, setIncludePending] = useState(true);
  const [printOrder, setPrintOrder] = useState(null);
  const [printComanda, setPrintComanda] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [shippingInput, setShippingInput] = useState("");
  const [shippingBlocksInput, setShippingBlocksInput] = useState("");
  const [busyShipping, setBusyShipping] = useState(false);
  const [refundInput, setRefundInput] = useState("");
  const [refundConfirm, setRefundConfirm] = useState(null); // { amount, full }
  const [refundForm, setRefundForm] = useState(false);
  // Clave del identificador recién copiado ("order" / "payment"), para el
  // "✓ Copiado" del botón. Vacío = ninguno copiado.
  const [copiedId, setCopiedId] = useState("");
  const pageRef = useRef(1);
  const seenRef = useRef(loadSeen());
  const [unseenIds, setUnseenIds] = useState(() => new Set());
  const [today, setToday] = useState(null);
  // ---------- pausa de pedidos por sucursal ----------
  // Estado ({ <id>: { paused, until, message } }) y branch del modal de
  // pausa abierto (null = cerrado). "Reanudar" es directo (sin modal).
  const [branchPauses, setBranchPauses] = useState({});
  const [pauseTarget, setPauseTarget] = useState(null);
  const [pauseBusyId, setPauseBusyId] = useState("");
  const dialogRef = useDialogA11y({ onClose: () => setSelected(null), isActive: !!selected });

  // "Rehacer": abre "Nuevo pedido" precargado con los productos, cantidades,
  // modo de entrega y datos del cliente del pedido original. No copia pago,
  // estado ni número (es un pedido nuevo de mostrador) y la sucursal sigue
  // saliendo de la sesión (fixedBranch / filtro), nunca del pedido original.
  function rehacerPedido(order) {
    setRepeatOrder(order);
    setSection("new-order");
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

  // ---------- pausa de pedidos por sucursal ----------
  // El GET responde solo las sucursales visibles para la sesión: el
  // branch_admin la suya, el superadmin las dos.
  const loadPauses = useCallback(async () => {
    try {
      const d = await adminBranchPause();
      setBranchPauses(d.branches || {});
    } catch {
      // Sin estado de pausa no se muestra nada: el panel sigue funcionando
      // igual (la pausa se controla igual desde el server).
    }
  }, []);

  // Aplica una pausa o una reanudación y actualiza el estado AL INSTANTE
  // con la respuesta del server: un "Reanudar" tiene que reabrir la vista
  // en el mismo click, sin esperar al polling de 10 s. Si falla, el error
  // se propaga: el modal lo muestra adentro, "Reanudar" lo muestra en el
  // form-error de la pestaña.
  async function applyPause(payload) {
    const res = await adminSetBranchPause(payload);
    setBranchPauses((prev) => ({ ...prev, [res.branch]: res.pause }));
    return res;
  }

  async function handleResume(branchId) {
    setPauseBusyId(branchId);
    try {
      await applyPause({ branch: branchId, action: "resume" });
    } catch (err) {
      setError(err.message || "No se pudo reanudar los pedidos");
    } finally {
      setPauseBusyId("");
    }
  }

  // Carga inicial + auto-refresh cada 10 segundos. Se dispara también cuando
  // cambia la identidad de `load` (es decir, cambió un filtro), así el panel
  // NUNCA consulta con filtros viejos (antes había llamadas inmediatas en los
  // onChange del filtro que viajaban con el valor anterior al estado).
  // El polling también refresca las pausas: refleja cambios hechos desde
  // otra pestaña o por el admin de la otra sucursal.
  useEffect(() => {
    load();
    loadPauses();
    const t = setInterval(() => {
      load({ showSpinner: false });
      loadPauses();
    }, 10000);
    return () => clearInterval(t);
  }, [load, loadPauses]);

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
    setShippingInput(order.shipping?.pending ? String(order.shipping?.cost || 0) : "");
    setShippingBlocksInput(order.shipping?.pending ? String(order.shipping?.blocks || 0) : "");
    setRefundInput("");
    setError("");
  }

  // Carga el costo de envío confirmado por WhatsApp de un pedido pendiente
  async function handleSetShipping() {
    const cost = Number(shippingInput);
    if (!Number.isFinite(cost) || cost < 0) {
      setError("Ingresá un costo de envío válido.");
      return;
    }
    const blocks = Number(shippingBlocksInput);
    if (!Number.isFinite(blocks) || blocks < 0) {
      setError("Ingresá una cantidad válida de cuadras.");
      return;
    }
    setBusyShipping(true);
    try {
      const res = await adminSetShipping(selected.id, cost, blocks);
      setSelected(res.order);
      load({ showSpinner: false });
    } catch (err) {
      if (err.message === "No autorizado" || err.message === "Sesión expirada") onLogout();
      else setError(err.message);
    } finally {
      setBusyShipping(false);
    }
  }

  // ============================================================
  // Devoluciones (Mercado Pago)
  // Solo sobre pagos aprobados: el monto nunca puede superar lo que
  // quedó sin devolver. `amount` vacío = devolver todo lo restante.
  // ============================================================
  const refundable =
    selected?.paymentMethod === "mercadopago"
      ? Math.max(0, (selected.total || 0) - (selected.refundedAmount || 0))
      : 0;
  const canRefund = selected?.paymentStatus === "approved" && refundable > 0;

  // Copia un identificador (Order MP / ID de pago) al portapapeles.
  // Es solo feedback visual: si el portapapeles falla (contexto http
  // sin API segura, permiso denegado, navegador viejo) el catch se
  // traga el error y no muestra la confirmación, sin romper el modal.
  async function copyId(value, key) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(key);
      setTimeout(() => setCopiedId(""), 1500);
    } catch {
      /* sin portapapeles: no se confirma nada */
    }
  }

  function openRefundConfirm(amount) {
    // Sin monto → devolución total de lo que queda.
    if (amount === undefined || amount === null || amount === "") {
      setRefundConfirm({ amount: null, full: true, refundable });
      return;
    }
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n) || n <= 0) {
      setError("Ingresá un monto válido.");
      return;
    }
    if (n > refundable) {
      setError(`El monto supera lo que queda por devolver ($${refundable}).`);
      return;
    }
    setRefundConfirm({ amount: n, full: n === refundable, refundable });
  }

  async function handleRefundConfirm() {
    try {
      const res = await adminRefund(selected.id, refundConfirm.amount);
      setSelected(res.order);
      setRefundInput("");
      load({ showSpinner: false });
    } catch (err) {
      if (err.message === "No autorizado" || err.message === "Sesión expirada") onLogout();
      // Se re-lanza para que el ConfirmModal muestre el error sin cerrarse.
      throw err;
    }
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
          {me?.role === "superadmin" && (
            <button
              className={`admin-nav__btn ${section === "users" ? "is-active" : ""}`}
              onClick={() => setSection("users")}
            >
              🔐 Cuentas
            </button>
          )}
          {/* Commit con el que se compiló la app (lo inyecta vite.config.js
              al hacer el build). Sirve para saber de un vistazo qué versión
              está corriendo el panel. Si no se pudo leer el hash ("?") no se
              dibuja nada. */}
          {BUILD_COMMIT !== "?" && <span className="admin-nav__commit">commit: {BUILD_COMMIT}</span>}
        </nav>

        <div className="container admin__body">

        {section === "stats" && <AdminStats me={me} />}

        {section === "products" && <AdminProducts me={me} />}

        {section === "coupons" && <AdminCoupons me={me} />}

        {section === "customers" && <AdminCustomers me={me} />}

        {section === "sales" && <AdminSales me={me} />}

        {section === "users" && me?.role === "superadmin" && (
          <AdminUsers me={me} onLogout={onLogout} />
        )}

        {section === "new-order" && (
          <AdminNewOrder
            onBack={() => {
              setRepeatOrder(null);
              setSection("orders");
            }}
            onCreated={() => {
              setRepeatOrder(null);
              load({ showSpinner: false });
            }}
            initialBranch={branch}
            fixedBranch={isBranchAdmin ? me.branch : ""}
            repeatOrder={repeatOrder}
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
              onClick={() => {
                setRepeatOrder(null);
                setSection("new-order");
              }}
            >
              <IconPlus style={{ width: 14, height: 14 }} /> Nuevo pedido
            </button>
          </div>
        </div>

        {/* Pausa de pedidos: un control por sucursal visible para la sesión
            (el branch_admin ve solo la suya; el superadmin, una por cada
            una). Fila propia debajo de la cabecera, para que se vea en
            mobile sin pelearle el lugar al resumen del día. */}
        <div className="admin-pause">
          {(isBranchAdmin ? [me.branch] : BRANCH_LIST.map((b) => b.id)).map((id) => {
            const state = branchPauses[id];
            return (
              <div key={id} className="admin-pause__item">
                {!isBranchAdmin && <span className="badge badge--branch">{BRANCHES[id]?.name || id}</span>}
                {state?.paused ? (
                  <>
                    <span className="badge badge--shipping-pending">
                      ⏸ Pedidos pausados{state.until ? ` · hasta las ${arClockLabel(state.until)}` : " · hasta reanudar"}
                    </span>
                    {state.message && <span className="admin-pause__msg">“{state.message}”</span>}
                    <button
                      type="button"
                      className="btn btn--danger-outline btn--sm"
                      onClick={() => handleResume(id)}
                      disabled={pauseBusyId === id}
                    >
                      {pauseBusyId === id ? "Reanudando…" : "Reanudar pedidos"}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setPauseTarget(id)}
                  >
                    ⏸ Pausar pedidos
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="admin-filters">
          <input
            type="search"
            placeholder="Buscar por número, nombre o teléfono…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="admin-search"
          />
          {isBranchAdmin ? (
            // Sucursal fija: el admin de sucursal no puede filtrar la otra
            <span className="badge badge--branch">{BRANCHES[branch]?.name}</span>
          ) : (
            <Dropdown
              value={branch}
              onChange={setBranchFilter}
              options={[
                { value: "", label: "Todas las sucursales" },
                ...BRANCH_LIST.map((b) => ({ value: b.id, label: b.name })),
              ]}
              placeholder="Sucursal"
            />
          )}
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
              { value: "refunded", label: "Devueltos" },
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
                          <IconRepeat style={{ width: 14, height: 14 }} /> Rehacer
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
            className="modal modal--order"
            role="dialog"
            aria-modal="true"
            aria-labelledby="order-modal-title"
            ref={dialogRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal__head modal__head--order">
              <div className="order-head">
                <h3 id="order-modal-title" className="order-head__num">
                  {selected.orderNumber}
                </h3>
                <span className="badge">
                  {statusEmoji(selected.status)} {statusLabel(selected.status)}
                </span>
                <span className={`badge badge--pay badge--pay-${selected.paymentStatus}`}>
                  {selected.paymentMethod === "mercadopago" ? "💳 " : "💰 "}
                  {paymentLabel(selected.paymentStatus)}
                </span>
              </div>
              <button className="modal__close" onClick={() => setSelected(null)} aria-label="Cerrar">✕</button>
            </div>
            <div className="modal__body">
              <div className="detail-grid detail-grid--order">
                <div className="detail-block">
                  <h4>Cliente</h4>
                  <p className="detail-strong">{selected.customer.name}</p>
                  <p>{selected.customer.phone}</p>
                  {selected.orderMode === "delivery" && selected.address && (
                    <p className="detail-wrap">📍 {selected.address}</p>
                  )}
                  {selected.orderMode === "delivery" && selected.notes && (
                    <p className="detail-note detail-wrap">📝 {selected.notes}</p>
                  )}
                </div>
                <div className="detail-block">
                  <h4>Sucursal / Entrega</h4>
                  <p className="detail-strong">{BRANCHES[selected.branch]?.name}</p>
                  <p>{selected.orderMode === "delivery" ? "🛵 Delivery" : "🥡 Retiro"}</p>
                  <p>{new Date(selected.createdAt).toLocaleString("es-AR")}</p>
                  <div className="order-chips">
                    {selected.shipping?.pending && (
                      <span className="badge badge--shipping-pending">⚠️ Envío a confirmar</span>
                    )}
                    {selected.scheduledFor && (
                      <span className="badge">
                        🕒 Programado: {new Date(selected.scheduledFor).toLocaleString("es-AR")}
                      </span>
                    )}
                  </div>
                  {selected.shipping?.pending && (
                    <div className="shipping-confirm">
                      <h4>Cargar envío confirmado</h4>
                      <p className="detail-note">
                        El costo se acordó por WhatsApp. Al cargarlo se ajustan el total, el ticket y el arqueo.
                      </p>
                      <div className="shipping-confirm__fields">
                        <input
                          type="number"
                          inputMode="numeric"
                          min="0"
                          step="100"
                          placeholder="Costo de envío ($)"
                          value={shippingInput}
                          onChange={(e) => setShippingInput(e.target.value)}
                        />
                        <input
                          type="number"
                          inputMode="numeric"
                          min="0"
                          step="1"
                          placeholder="Cuadras"
                          value={shippingBlocksInput}
                          onChange={(e) => setShippingBlocksInput(e.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          disabled={busyShipping}
                          onClick={handleSetShipping}
                        >
                          {busyShipping ? "Cargando…" : "Guardar envío"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Pago: tarjeta de ancho completo. Antes vivía como tercera
                  columna del grid, que a 560px de modal lo dejaba en ~165px y
                  los IDs de Mercado Pago (sin wrap) ensanchaban la columna:
                  de ahí el scroll horizontal del modal. */}
              <div className="detail-block">
                <h4>Pago</h4>
                <div className="pay-card">
                  <div className="pay-card__head">
                    <span className={`badge badge--pay badge--pay-${selected.paymentStatus}`}>
                      {paymentLabel(selected.paymentStatus)} · {selected.paymentMethod}
                    </span>
                  </div>

                  {(selected.mpOrderId || selected.mpPaymentId) && (
                    <dl className="pay-card__ids">
                      {selected.mpOrderId && (
                        <div className="pay-card__id">
                          <dt>Order MP</dt>
                          <dd>
                            <code className="pay-card__code">{selected.mpOrderId}</code>
                            <button
                              type="button"
                              className={`copy-btn ${copiedId === "order" ? "is-copied" : ""}`}
                              aria-label="Copiar Order MP"
                              onClick={() => copyId(selected.mpOrderId, "order")}
                            >
                              {copiedId === "order" ? "✓ Copiado" : "Copiar"}
                            </button>
                          </dd>
                        </div>
                      )}
                      {selected.mpPaymentId && (
                        <div className="pay-card__id">
                          <dt>ID pago</dt>
                          <dd>
                            <code className="pay-card__code">{selected.mpPaymentId}</code>
                            <button
                              type="button"
                              className={`copy-btn ${copiedId === "payment" ? "is-copied" : ""}`}
                              aria-label="Copiar ID de pago"
                              onClick={() => copyId(selected.mpPaymentId, "payment")}
                            >
                              {copiedId === "payment" ? "✓ Copiado" : "Copiar"}
                            </button>
                          </dd>
                        </div>
                      )}
                    </dl>
                  )}

                    {selected.refunds?.length > 0 && (
                    <div className="refunds">
                      {selected.refunds.map((r) => (
                        <div className="refunds__row" key={r.id}>
                          <span className="refunds__arrow">↩</span>
                          <span className="refunds__amount">{formatPrice(r.amount)}</span>
                          <span className="refunds__date">
                            {new Date(r.at).toLocaleString("es-AR", {
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: false,
                            })}
                          </span>
                        </div>
                      ))}
                      <div
                        className="refunds__bar"
                        aria-hidden="true"
                        style={{
                          "--refunds-pct": `${Math.min(
                            100,
                            Math.round(
                              ((selected.refundedAmount || 0) / (selected.total || 1)) * 100
                            )
                          )}%`,
                        }}
                      >
                        <span className="refunds__bar-fill" />
                      </div>
                      <p className="refunds__total">
                        Devuelto: {formatPrice(selected.refundedAmount)} de{" "}
                        {formatPrice(selected.total)}
                      </p>
                    </div>
                  )}

                  {canRefund && (
                    <div className="refund-open">
                      <div className="refund-open__text">
                        <span className="refund-open__label">Devolver dinero</span>
                        <span className="refund-open__hint">
                          Quedan {formatPrice(refundable)} por devolver
                        </span>
                      </div>
                      <button
                        type="button"
                        className="refund-open__btn"
                        onClick={() => setRefundForm(true)}
                      >
                        Devolver
                      </button>
                    </div>
                  )}

                  {selected.paymentMethod === "mercadopago" &&
                    selected.paymentStatus === "approved" &&
                    !canRefund && (
                      <p className="refund-done">✓ Pedido devuelto por completo</p>
                    )}
                </div>
              </div>

              <div className="detail-block">
                <h4>Productos</h4>
                <div className="summary summary--order">
                  {selected.items.map((item) => (
                    <div className="summary__row" key={item.key || `${item.productId}-${item.name}`}>
                      <span className="summary__name">
                        {item.qty}× {item.name}
                        {item.extras?.length
                          ? ` (${item.extras.map((e) => e.label).join(", ")})`
                          : ""}
                        {item.notes ? ` — "${item.notes}"` : ""}
                      </span>
                      <span className="summary__price">
                        {formatPrice(item.unitPrice * item.qty)}
                      </span>
                    </div>
                  ))}
                  {selected.discount > 0 && (
                    <div className="summary__row">
                      <span className="summary__name">
                        Descuento ({selected.couponCode})
                      </span>
                      <span className="summary__price">−{formatPrice(selected.discount)}</span>
                    </div>
                  )}
                  <div className="summary__row summary__row--total">
                    <span className="summary__name">Total</span>
                    <span className="summary__price">{formatPrice(selected.total)}</span>
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

              <div className="modal__footer modal__footer--order">
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

      {refundForm && canRefund && (
        <div className="modal-backdrop" onClick={() => setRefundForm(false)}>
          <div
            className="modal refund-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="refund-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal__head">
              <h3 id="refund-modal-title">Devolver dinero</h3>
              <button
                type="button"
                className="modal__close"
                onClick={() => setRefundForm(false)}
                aria-label="Cerrar"
              >
                ✕
              </button>
            </div>

            <div className="modal__body">
              <p className="refund-modal__lead">
                Quedan <strong>{formatPrice(refundable)}</strong> por devolver.
              </p>

              <div className="field">
                <label htmlFor="refund-modal-amount">Monto a devolver</label>
                <div className="refund-modal__field">
                  <span className="refund-modal__prefix" aria-hidden="true">$</span>
                  <input
                    id="refund-modal-amount"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max={refundable}
                    placeholder="Monto parcial"
                    value={refundInput}
                    onChange={(e) => setRefundInput(e.target.value)}
                  />
                </div>
                <span className="hint">Máximo: {formatPrice(refundable)}</span>
              </div>
            </div>

            <div className="modal__footer">
              <button
                type="button"
                className="btn btn--block refund-modal__btn-partial"
                onClick={() => {
                  setRefundForm(false);
                  openRefundConfirm(refundInput);
                }}
              >
                Devolver monto
              </button>
              <button
                type="button"
                className="btn btn--block refund-modal__btn-full"
                onClick={() => {
                  setRefundForm(false);
                  openRefundConfirm();
                }}
              >
                Devolver todo ({formatPrice(refundable)})
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--block"
                onClick={() => setRefundForm(false)}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {printOrder && <TicketPrint order={printOrder} onClose={() => setPrintOrder(null)} />}
      {printComanda && (
        <TicketPrint order={printComanda} variant="comanda" onClose={() => setPrintComanda(null)} />
      )}

      {/* Pausa de pedidos: el branch del modal abierto (solo pausar; reanudar
          es directo desde la cabecera). El error del server se muestra
          adentro del modal, igual que PromptModal. */}
      {pauseTarget && (
        <PauseModal
          branchName={BRANCHES[pauseTarget]?.name || pauseTarget}
          onSubmit={async ({ minutes, indefinite, message }) => {
            await applyPause({ branch: pauseTarget, action: "pause", minutes, indefinite, message });
          }}
          onClose={() => setPauseTarget(null)}
        />
      )}

      {refundConfirm && (
        <ConfirmModal          variant="danger"
          title={refundConfirm.full ? "Devolver el total" : "Devolver un monto"}
          message={
            refundConfirm.full ? (
              <>
                <span className="confirm-refund__amount">
                  {formatPrice(refundConfirm.refundable)}
                </span>
                <span className="confirm-refund__line">
                  Se va a devolver a {selected?.name || "el cliente"} por Mercado Pago. El
                  pedido quedará marcado como devuelto y sale de la venta.
                </span>
              </>
            ) : (
              <>
                <span className="confirm-refund__amount">
                  {formatPrice(refundConfirm.amount)}
                </span>
                <span className="confirm-refund__line">
                  Se va a devolver a {selected?.name || "el cliente"} por Mercado Pago.
                  Quedarán {formatPrice(refundConfirm.refundable - refundConfirm.amount)}{" "}
                  sin devolver.
                </span>
              </>
            )
          }
          confirmText={refundConfirm.full ? "Devolver todo" : "Devolver"}
          onConfirm={handleRefundConfirm}
          onClose={() => setRefundConfirm(null)}
        />
      )}
    </div>
  );
}