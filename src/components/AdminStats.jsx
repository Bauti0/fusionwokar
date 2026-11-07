import { useCallback, useEffect, useRef, useState } from "react";
import { adminStats } from "../api.js";
import { formatPrice } from "../utils/format.js";
import { periodRange } from "../utils/dates.js";
import DateRangePicker from "./ui/DateRangePicker.jsx";
import { useDelayedLoading } from "../utils/skeleton-delay.js";
import { IconChart, IconCash, IconReceipt, IconCart, IconLocation, IconUser, IconMoney, IconFlash } from "./ui/icons.jsx";

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

const branchLabel = (v) => (typeof v === "number" && Number.isFinite(v) ? `${v}%` : "0%");

export default function AdminStats({ me }) {
  const [period, setPeriod] = useState("30d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [statsSettled, setStatsSettled] = useState(false);
  const timer = useRef(null);
  // stats === null y !statsSettled solo en la primera carga y al cambiar de filtro.
  // El auto-refresh de 30 s nunca pasa por null: sobreescribe con datos, así que el
  // skeleton no reaparece en el refresco. Si el primer fetch falla, statsSettled=true
  // evita el skeleton eterno.
  const showSkeleton = useDelayedLoading(stats === null && !statsSettled, { showAfter: 200, minVisible: 300 });

  // Al cambiar de período o rango personalizado, resetear stats para que el
  // skeleton reaparezca ante el nuevo contexto. El auto-refresh no toca estas
  // dependencias, así que no se dispara ahí.
  useEffect(() => {
    setStats(null);
    setStatsSettled(false);
  }, [period, from, to]);

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
    } finally {
      setStatsSettled(true);
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
      <>
        <div className="admin-stats__head">
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
                <span className="stat-card__icon" aria-hidden="true"><IconCash /></span>
                <span className="stat-card__label">Venta generada (neta)</span>
                <strong className="stat-card__value">{formatPrice(stats.ventaNeta)}</strong>
                <span className="stat-card__note">
                  bruto {formatPrice(stats.ventaBruta)} · devuelto {formatPrice(stats.devuelto ?? 0)}
                </span>
              </div>
              {me?.role === "branch_admin" ? (
                <>
                  <div className="stat-card">
                    <span className="stat-card__icon" aria-hidden="true"><IconReceipt /></span>
                    <span className="stat-card__label">Ticket Promedio</span>
                    <strong className="stat-card__value">{formatPrice(stats.ticketPromedio)}</strong>
                  </div>
                  <div className="stat-card">
                    <span className="stat-card__icon" aria-hidden="true"><IconCart /></span>
                    <span className="stat-card__label">Pedidos</span>
                    <strong className="stat-card__value">{stats.pedidos}</strong>
                  </div>
                </>
              ) : (
                <>
                  <div className="stat-card">
                    <span className="stat-card__icon" aria-hidden="true"><IconLocation /></span>
                    <span className="stat-card__label">Venta neta · Tandil</span>
                    <strong className="stat-card__value">{formatPrice(stats.ventaTandil)}</strong>
                    <span className="stat-card__note">devuelto {formatPrice(stats.devueltoTandil ?? 0)}</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-card__icon" aria-hidden="true"><IconLocation /></span>
                    <span className="stat-card__label">Venta neta · Necochea</span>
                    <strong className="stat-card__value">{formatPrice(stats.ventaNecochea)}</strong>
                    <span className="stat-card__note">devuelto {formatPrice(stats.devueltoNecochea ?? 0)}</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-card__icon" aria-hidden="true"><IconReceipt /></span>
                    <span className="stat-card__label">Ticket Promedio</span>
                    <strong className="stat-card__value">{formatPrice(stats.ticketPromedio)}</strong>
                  </div>
                  <div className="stat-card">
                    <span className="stat-card__icon" aria-hidden="true"><IconCart /></span>
                    <span className="stat-card__label">Pedidos</span>
                    <strong className="stat-card__value">{stats.pedidos}</strong>
                  </div>
                  <div className="stat-card">
                    <span className="stat-card__icon" aria-hidden="true"><IconUser /></span>
                    <span className="stat-card__label">Visitantes (personas)</span>
                    <strong className="stat-card__value">{stats.visitas}</strong>
                  </div>
                </>
              )}
            </div>

            <div className="top-products">
              <div className="top-products__col">
                <h4><IconFlash /> Más vendidos (cantidad)</h4>
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
                <h4><IconMoney /> Que más facturan (netos)</h4>
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
          showSkeleton ? (
            <div className="stats-skeleton" aria-busy="true">
              <span className="sr-only">Cargando estadísticas…</span>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="stat-card stat-card--skeleton">
                  <div className="skeleton stat-skeleton__icon" style={{ width: "40px", height: "40px", borderRadius: "50%" }} />
                  <div className="skeleton stat-skeleton__label" style={{ width: "55%" }} />
                  <div className="skeleton stat-skeleton__value" style={{ width: "45%" }} />
                  <div className="skeleton sk-line--sm stat-skeleton__note" style={{ width: "70%" }} />
                </div>
              ))}
              <div className="top-products-skeleton">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton top-product-skeleton" style={{ width: "45%" }} />
                ))}
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton top-product-skeleton" style={{ width: "45%" }} />
                ))}
              </div>
            </div>
          ) : (
            <p className="hint">Cargando estadísticas…</p>
          )
        )}
      </>
    );
}