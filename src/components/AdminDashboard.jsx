import { useCallback, useEffect, useRef, useState } from "react";
import { adminDashboard } from "../api.js";
import { formatPrice } from "../utils/format.js";
import { ORDER_STATUSES, STATUS_CANCELLED, STATUS_PENDING_PAYMENT, paymentLabel } from "../constants.js";

// ============================================================
// AdminDashboard — resumen del día para el dueño
// - Venta neta, pedidos, ticket promedio
// - Pedidos por estado, medios de pago, producto más vendido
// - Superadmin: desglose por sucursal
// Un request al cargar + refresh cada 30s (pausa con document.hidden, backoff en error)
// ============================================================

const STATUS_LABELS = {
  ...Object.fromEntries([...ORDER_STATUSES, STATUS_CANCELLED, STATUS_PENDING_PAYMENT].map(s => [s.id, s.label])),
};

const PAYMENT_LABELS = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  mercadopago: "Mercado Pago",
};

export default function AdminDashboard({ me }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const timer = useRef(null);
  const backoff = useRef(1);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    if (!mounted.current) return;
    try {
      const res = await adminDashboard();
      if (!mounted.current) return;
      setData(res);
      setError("");
      backoff.current = 1; // reset backoff on success
    } catch (err) {
      if (!mounted.current) return;
      setError(err.message || "Error al cargar el resumen");
      // Backoff exponencial simple: 30s → 60s → 120s → máx 300s
      backoff.current = Math.min(backoff.current * 2, 10);
    }
  }, []);

  // Carga inicial
  useEffect(() => {
    load();
    // Refresh cada 30s, pero pausado si la pestaña no está visible
    timer.current = setInterval(() => {
      if (!document.hidden) load();
    }, 30000);
    return () => {
      mounted.current = false;
      clearInterval(timer.current);
    };
  }, [load]);

  // Reintento con backoff cuando hay error
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => {
      backoff.current = Math.min(backoff.current * 2, 10);
      load();
    }, backoff.current * 30000);
    return () => clearTimeout(t);
  }, [error, load]);

  if (loading && !data) {
    return (
      <section className="admin-stats" aria-live="polite">
        <div className="admin-stats__head">
          <h3>📋 Resumen del día</h3>
        </div>
        <div className="stats-grid">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="stat-card skeleton" aria-hidden="true">
              <div className="skeleton" style={{ height: 12, width: "60%", marginBottom: 8 }} />
              <div className="skeleton" style={{ height: 20, width: "40%" }} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (error && !data) {
    return (
      <section className="admin-stats">
        <div className="admin-stats__head">
          <h3>📋 Resumen del día</h3>
        </div>
        <div className="form-error">{error}</div>
        <button className="btn btn--ghost btn--sm" onClick={load}>Reintentar</button>
      </section>
    );
  }

  if (!data || data.pedidos === 0) {
    return (
      <section className="admin-stats">
        <div className="admin-stats__head">
          <h3>📋 Resumen del día</h3>
        </div>
        <p className="hint">Todavía no hay ventas hoy</p>
      </section>
    );
  }

  const { ventaNeta, ventaBruta, devuelto, ticketPromedio, pedidos, pedidosPorEstado, mediosPago, productoMasVendido, porSucursal } = data;

  // Estado orden: recibido → preparando → listo → en camino → entregado → cancelado → esperando pago
  const statusOrder = [
    "received", "preparing", "ready", "out_for_delivery", "completed",
    "cancelled", "pending_payment"
  ];

  const estadosOrdenados = statusOrder
    .filter(s => pedidosPorEstado[s] != null)
    .map(s => ({
      id: s,
      label: STATUS_LABELS[s] || s,
      count: pedidosPorEstado[s],
      emoji: [...ORDER_STATUSES, STATUS_CANCELLED, STATUS_PENDING_PAYMENT].find(x => x.id === s)?.emoji || "📦",
    }));

  return (
    <section className="admin-stats">
      <div className="admin-stats__head">
        <h3>📋 Resumen del día</h3>
      </div>

      <div className="stats-grid">
        <div className="stat-card stat-card--main">
          <span className="stat-card__icon" aria-hidden="true">💰</span>
          <span className="stat-card__label">Venta neta de hoy</span>
          <strong className="stat-card__value">{formatPrice(ventaNeta)}</strong>
          <span className="stat-card__note">
            bruto {formatPrice(ventaBruta)} · devuelto {formatPrice(devuelto ?? 0)}
          </span>
        </div>

        <div className="stat-card">
          <span className="stat-card__icon" aria-hidden="true">📦</span>
          <span className="stat-card__label">Pedidos confirmados</span>
          <strong className="stat-card__value">{pedidos}</strong>
        </div>

        <div className="stat-card">
          <span className="stat-card__icon" aria-hidden="true">🧾</span>
          <span className="stat-card__label">Ticket promedio</span>
          <strong className="stat-card__value">{formatPrice(ticketPromedio)}</strong>
        </div>

        {me?.role === "superadmin" && porSucursal && (
          <>
            <div className="stat-card">
              <span className="stat-card__icon" aria-hidden="true">📍</span>
              <span className="stat-card__label">Tandil (neto)</span>
              <strong className="stat-card__value">{formatPrice(porSucursal.tandil.ventaNeta)}</strong>
              <span className="stat-card__note">{porSucursal.tandil.pedidos} pedidos · devuelto {formatPrice(porSucursal.tandil.devuelto)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-card__icon" aria-hidden="true">📍</span>
              <span className="stat-card__label">Necochea (neto)</span>
              <strong className="stat-card__value">{formatPrice(porSucursal.necochea.ventaNeta)}</strong>
              <span className="stat-card__note">{porSucursal.necochea.pedidos} pedidos · devuelto {formatPrice(porSucursal.necochea.devuelto)}</span>
            </div>
          </>
        )}
      </div>

      {/* Pedidos por estado */}
      <div className="top-products" style={{ marginTop: 20 }}>
        <h4 style={{ margin: "0 0 10px", fontSize: 14 }}>📊 Pedidos por estado</h4>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {estadosOrdenados.map(e => (
            <span key={e.id} className="top-products__list" style={{
              flex: "1 1 auto", minWidth: 120, maxWidth: "100%",
              justifyContent: "space-between", padding: "9px 12px",
              background: "var(--color-surface)", border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)", fontSize: "13.5px",
            }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span aria-hidden="true">{e.emoji}</span>
                <span>{e.label}</span>
              </span>
              <strong style={{ color: "var(--color-primary)" }}>{e.count}</strong>
            </span>
          ))}
        </div>
      </div>

      {/* Medios de pago */}
      <div className="top-products" style={{ marginTop: 20 }}>
        <h4 style={{ margin: "0 0 10px", fontSize: 14 }}>💳 Medios de pago (bruto)</h4>
        {mediosPago.length === 0 ? (
          <p className="hint">Sin pagos confirmados hoy</p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {mediosPago.map(m => (
              <span key={m.method} className="top-products__list" style={{
                flex: "1 1 auto", minWidth: 140, maxWidth: "100%",
                justifyContent: "space-between", padding: "9px 12px",
                background: "var(--color-surface)", border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)", fontSize: "13.5px",
              }}>
                <span>{PAYMENT_LABELS[m.method] || m.method}</span>
                <strong style={{ color: "var(--color-primary)" }}>{formatPrice(m.total)}</strong>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Producto más vendido */}
      <div className="top-products" style={{ marginTop: 20 }}>
        <h4 style={{ margin: "0 0 10px", fontSize: 14 }}>🏆 Producto más vendido (hoy)</h4>
        {productoMasVendido ? (
          <div className="top-products__list" style={{ maxWidth: "100%" }}>
            <li style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
              background: "var(--color-surface)", border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)", padding: "12px 14px", fontSize: "14px",
            }}>
              <span className="top-products__name" style={{ fontWeight: 700, fontSize: "15px" }}>
                {productoMasVendido.name}
              </span>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                <span className="top-products__qty" style={{ fontSize: "16px" }}>{productoMasVendido.qty} u</span>
                <span style={{ fontSize: "12px", color: "var(--color-text-soft)" }}>
                  {formatPrice(productoMasVendido.revenue)} neto
                </span>
              </div>
            </li>
          </div>
        ) : (
          <p className="hint">Todavía no hay productos vendidos hoy</p>
        )}
      </div>
    </section>
  );
}