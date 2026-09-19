import { useCallback, useEffect, useRef, useState } from "react";
import { adminStats } from "../api.js";
import { formatPrice } from "../utils/format.js";
import { periodRange } from "../utils/dates.js";
import DateRangePicker from "./ui/DateRangePicker.jsx";

// ============================================================
// AdminStats — estadísticas del panel
// - Venta neta (total + por sucursal), ticket promedio, pedidos
// - Productos más vendidos (cantidad) y que más facturan (netos)
// - Filtros de período: Hoy / 7 días / 30 días / personalizado
// ============================================================

const PERIODS = [
  { id: "today", label: "Hoy" },
  { id: "7d", label: "Últimos 7 días" },
  { id: "30d", label: "Últimos 30 días" },
  { id: "custom", label: "Personalizado" },
];

export default function AdminStats() {
  const [period, setPeriod] = useState("30d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const { from: f, to: t } = periodRange(period, from, to);
      const data = await adminStats({
        from: f.toISOString(),
        to: t.toISOString(),
      });
      setStats(data);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, [period, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  // auto-refresh cada 30s
  useEffect(() => {
    timer.current = setInterval(() => load(), 30000);
    return () => clearInterval(timer.current);
  }, [load]);

  return (
    <section className="admin-stats">
      <div className="admin-stats__head">
        <h3>📊 Estadísticas</h3>
        <div className="admin-stats__period">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              className={`period-btn ${period === p.id ? "is-active" : ""}`}
              onClick={() => setPeriod(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {period === "custom" && (
        <div className="admin-stats__custom">
          <DateRangePicker
            from={from}
            to={to}
            onChange={({ from: f, to: t }) => {
              setFrom(f);
              setTo(t);
            }}
          />
        </div>
      )}

      {error && <div className="form-error">{error}</div>}

      {stats ? (
        <>
          <div className="stats-grid">
            <div className="stat-card stat-card--main">
              <span className="stat-card__label">Venta Neta Generada</span>
              <strong className="stat-card__value">{formatPrice(stats.ventaNeta)}</strong>
            </div>
            <div className="stat-card">
              <span className="stat-card__label">Venta Neta · Necochea</span>
              <strong className="stat-card__value">{formatPrice(stats.ventaNecochea)}</strong>
            </div>
            <div className="stat-card">
              <span className="stat-card__label">Venta Neta · Tandil</span>
              <strong className="stat-card__value">{formatPrice(stats.ventaTandil)}</strong>
            </div>
            <div className="stat-card">
              <span className="stat-card__label">Ticket Promedio</span>
              <strong className="stat-card__value">{formatPrice(stats.ticketPromedio)}</strong>
            </div>
            <div className="stat-card">
              <span className="stat-card__label">Pedidos</span>
              <strong className="stat-card__value">{stats.pedidos}</strong>
            </div>
            <div className="stat-card">
              <span className="stat-card__label">Visitantes (personas)</span>
              <strong className="stat-card__value">{stats.visitas}</strong>
            </div>
          </div>

          <div className="split-stats">
            <div className="split-stat">
              <span className="split-stat__label">Necochea</span>
              <div className="split-stat__bar">
                <span
                  className="split-stat__fill split-stat__fill--necochea"
                  style={{ width: branchShare(stats.ventaNecochea, stats.ventaNeta) }}
                />
              </div>
              <strong className="split-stat__value">
                {branchShare(stats.ventaNecochea, stats.ventaNeta)} · {formatPrice(stats.ventaNecochea)}
              </strong>
            </div>
            <div className="split-stat">
              <span className="split-stat__label">Tandil</span>
              <div className="split-stat__bar">
                <span
                  className="split-stat__fill split-stat__fill--tandil"
                  style={{ width: branchShare(stats.ventaTandil, stats.ventaNeta) }}
                />
              </div>
              <strong className="split-stat__value">
                {branchShare(stats.ventaTandil, stats.ventaNeta)} · {formatPrice(stats.ventaTandil)}
              </strong>
            </div>
          </div>

          <div className="funnel">
            <h4>🥘 Embudo de conversión</h4>
            <div className="funnel__list">
              {[
                { name: "Visitas", value: stats.visitas },
                { name: "Productos vistos", value: stats.productosVistos },
                { name: "Checkouts iniciados", value: stats.checkouts },
                { name: "Pedidos confirmados", value: stats.pedidos },
              ].map((f, i) => {
                const pct = stats.visitas > 0 ? Math.round((f.value / stats.visitas) * 1000) / 10 : 0;
                return (
                  <div className="funnel__row" key={f.name}>
                    <div className="funnel__stage">
                      <span className="funnel__num">{i + 1}</span>
                      <span className="funnel__name">{f.name}</span>
                      <span className="funnel__count">{f.value}</span>
                    </div>
                    <div className="funnel__bar">{i > 0 && <span className="funnel__fill" style={{ width: `${pct}%` }} />}</div>
                    {i > 0 && <span className="funnel__conv">{pct}%</span>}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="top-products">
            <div className="top-products__col">
              <h4>🔥 Más vendidos (cantidad)</h4>
              {stats.topSelling.length === 0 ? (
                <p className="hint">Todavía no hay ventas en este período.</p>
              ) : (
                <ol className="top-products__list">
                  {stats.topSelling.map((p) => (
                    <li key={p.name}>
                      <span className="top-products__name">{p.name}</span>
                      <span className="top-products__qty">{p.qty}u</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="top-products__col">
              <h4>💰 Que más facturan (netos)</h4>
              {stats.topRevenue.length === 0 ? (
                <p className="hint">Todavía no hay ventas en este período.</p>
              ) : (
                <ol className="top-products__list">
                  {stats.topRevenue.map((p) => (
                    <li key={p.name}>
                      <span className="top-products__name">{p.name}</span>
                      <span className="top-products__qty">{formatPrice(p.revenue)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </>
      ) : (
        <p className="hint">Cargando estadísticas…</p>
      )}
    </section>
  );
}