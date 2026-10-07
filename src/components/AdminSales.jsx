import { useCallback, useEffect, useState } from "react";
import { adminSales, adminCashRegister, adminOpenCashRegister, adminCloseCashRegister } from "../api.js";
import { BRANCH_LIST } from "../data/branches.js";
import { formatPrice } from "../utils/format.js";
import { periodRange, dayShort, dayLabel, dateShort, dateTimeShort, isToday } from "../utils/dates.js";
import Dropdown from "./ui/Dropdown.jsx";
import DateRangePicker from "./ui/DateRangePicker.jsx";

const PERIODS = [
  { id: "today", label: "Hoy" },
  { id: "7d", label: "Últimos 7 días" },
  { id: "30d", label: "Últimos 30 días" },
  { id: "custom", label: "Personalizado" },
];

const PAYMENT_LABELS = { efectivo: "💰 Efectivo", mercadopago: "💳 Mercado Pago", transferencia: "🏦 Transferencia" };

// ============================================================
// AdminSales — ventas por período + arqueo de caja
// ============================================================
export default function AdminSales({ me }) {
  const isBranchAdmin = me?.role === "branch_admin";
  // El admin de sucursal opera SIEMPRE su caja: sin dropdown (el
  // server de todos modos filtra por la sesión).
  const [branchSel, setBranchSel] = useState(BRANCH_LIST[0]?.id || "");
  const branch = isBranchAdmin ? me.branch : branchSel;
  const [period, setPeriod] = useState("30d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sales, setSales] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const { from: f, to: t } = periodRange(period, from, to);
      const data = await adminSales({ branch, from: f.toISOString(), to: t.toISOString() });
      setSales(data);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, [branch, period, from, to]);

  useEffect(() => { load(); }, [load]);

  // Datos del gráfico. `byDay` viene ordenado por fecha y sólo trae días CON
  // ventas. El mayor de todos es el 100% de la altura del plot.
  const days = sales?.byDay || [];
  const dayMax = days.length > 0 ? Math.max(...days.map((d) => d.total), 1) : 1;
  // Con muchos días la columna del gráfico se angosta: primero achicamos el
  // monto y, si aun así no entra, lo ocultamos (queda en el title de la barra).
  const barsClass = ["sales-chart__bars", days.length >= 8 ? "is-dense" : "", days.length >= 12 ? "is-compact" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <section className="admin-sales">
      <div className="admin-stats__head">
        <h3>💵 Ventas</h3>
        <div className="admin-stats__period">
          {PERIODS.map((p) => (
            <button key={p.id} className={`period-btn ${period === p.id ? "is-active" : ""}`} onClick={() => setPeriod(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="admin-products__controls" style={{ marginBottom: 14 }}>
        {isBranchAdmin ? (
          <span className="badge badge--branch">{BRANCH_LIST.find((b) => b.id === branch)?.name}</span>
        ) : (
          <Dropdown value={branch} onChange={setBranchSel} options={BRANCH_LIST.map((b) => ({ value: b.id, label: b.name }))} />
        )}
      </div>

      {period === "custom" && (
        <div className="admin-stats__custom">
          <DateRangePicker from={from} to={to} onChange={({ from: f, to: t }) => { setFrom(f); setTo(t); }} />
        </div>
      )}

      {error && <div className="form-error">{error}</div>}

      {sales && (
        <>
          <div className="stats-grid">
            <div className="stat-card stat-card--main">
              <span className="stat-card__icon" aria-hidden="true">💰</span>
              <span className="stat-card__label">Venta generada (neta)</span>
              <strong className="stat-card__value">{formatPrice(sales.net)}</strong>
              <span className="stat-card__note">
                bruto {formatPrice(sales.total)} · devuelto {formatPrice(sales.devuelto ?? 0)}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-card__icon" aria-hidden="true">🧾</span>
              <span className="stat-card__label">Ticket promedio</span>
              <strong className="stat-card__value">{formatPrice(sales.average)}</strong>
            </div>
            <div className="stat-card">
              <span className="stat-card__icon" aria-hidden="true">📦</span>
              <span className="stat-card__label">Pedidos</span>
              <strong className="stat-card__value">{sales.count}</strong>
            </div>
          </div>

          <div className="payment-breakdown">
            {/* La nota va en la misma línea que el título, a la derecha; el
                texto sigue siendo un .hint pero alineado a la izquierda. */}
            <div className="payment-breakdown__head">
              <h4>Por método de pago</h4>
              <p className="hint payment-breakdown__note">Bruto, sin descontar devoluciones</p>
            </div>
            {sales.byMethod.length === 0 ? (
              <p className="hint">No hay ventas en este período.</p>
            ) : (
              <div className="payment-breakdown__list">
                {sales.byMethod.map((m) => (
                  <div className="payment-breakdown__row" key={m.method}>
                    <span>{PAYMENT_LABELS[m.method] || m.method}</span>
                    <span className="payment-breakdown__count">{m.count} pedidos</span>
                    <strong>{formatPrice(m.total)}</strong>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="sales-chart">
            <h4>📈 Ventas por día</h4>
            {days.length === 0 ? (
              <p className="hint">Sin ventas en este período.</p>
            ) : (
              <div className={barsClass}>
                {days.map((d) => {
                  const hoy = isToday(d.date);
                  return (
                    <div
                      className={`sales-chart__bar${hoy ? " is-today" : ""}`}
                      key={d.date}
                      title={`${dayShort(d.date)} ${dayLabel(d.date)} · ${d.count} pedidos · ${formatPrice(d.total)}`}
                    >
                      <span className="sales-chart__amount">{formatPrice(d.total)}</span>
                      <span className="sales-chart__plot">
                        <span
                          className={`sales-chart__fill${d.total > 0 ? "" : " is-zero"}`}
                          style={{ height: `${(d.total / dayMax) * 100}%` }}
                        />
                      </span>
                      <span className="sales-chart__day">
                        <span className="sales-chart__dow">{dayShort(d.date)}&nbsp;</span>
                        {dayLabel(d.date)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      <CashRegister branch={branch} />
    </section>
  );
}

// ============================================================
// Arqueo de caja (por sucursal)
// ============================================================
function CashRegister({ branch }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [openingAmount, setOpeningAmount] = useState("");
  const [closingCounted, setClosingCounted] = useState("");
  const [closingNotes, setClosingNotes] = useState("");
  const [closing, setClosing] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await adminCashRegister(branch);
      setData(d);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, [branch]);

  useEffect(() => {
    setResult(null);
    setClosing(false);
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  async function handleOpen(e) {
    e.preventDefault();
    if (String(openingAmount || "").trim() === "") {
      setError("Ingresá un monto inicial");
      return;
    }
    const amount = Number(openingAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      setError("Ingresá un monto inicial válido");
      return;
    }
    setBusy(true);
    try {
      await adminOpenCashRegister(branch, amount);
      setOpeningAmount("");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleClose(e) {
    e.preventDefault();
    if (String(closingCounted || "").trim() === "") {
      setError("Ingresá el monto contado");
      return;
    }
    const counted = Number(closingCounted);
    if (!Number.isFinite(counted) || counted < 0) {
      setError("Ingresá el monto contado");
      return;
    }
    setBusy(true);
    try {
      const res = await adminCloseCashRegister(data.open.id, counted, closingNotes);
      setResult(res);
      setClosingCounted("");
      setClosingNotes("");
      setClosing(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;

  // El server NO manda el efectivo cobrado como campo: manda `expectedNow`,
  // que ya es apertura + cobrado (server/admin-queries.js). La diferencia es
  // exactamente ese monto, sin recalcular nada. Si no hay caja abierta el
  // cálculo no se hace.
  const cobrado = Number.isFinite(data.open?.expectedNow)
    ? data.open.expectedNow - data.open.openingAmount
    : 0;

  return (
    <div className="cash-register">
      <h4>🧾 Arqueo de caja</h4>
      {error && <div className="form-error">{error}</div>}

      {!data.open ? (
        <form className="cash-register__open" onSubmit={handleOpen}>
          <p className="hint">No hay una caja abierta en esta sucursal.</p>
          <div className="field">
            <label htmlFor="opening-amount">Monto inicial</label>
            <input
              id="opening-amount"
              type="number"
              min="0"
              placeholder="Ej: 20000"
              value={openingAmount}
              onChange={(e) => setOpeningAmount(e.target.value)}
            />
          </div>
          <button className="btn btn--primary btn--block" disabled={busy}>
            {busy ? "Abriendo…" : "Abrir caja"}
          </button>
        </form>
      ) : (
        <div className="cash-register__open-state">
          {/* La cuenta de la caja: apertura + cobrado = esperado ahora. Los
              signos "+" y "=" van por CSS (::before) y el total en rojo. */}
          <div className="cash-register__ledger">
            <div className="cash-register__row">
              <span>Apertura</span>
              <strong>{formatPrice(data.open.openingAmount)}</strong>
            </div>
            <div className="cash-register__row cash-register__row--add">
              <span>Efectivo cobrado</span>
              <strong>{formatPrice(cobrado)}</strong>
            </div>
            <div className="cash-register__row cash-register__row--highlight cash-register__row--total">
              <span>Esperado ahora</span>
              <strong>{formatPrice(data.open.expectedNow)}</strong>
            </div>
          </div>

          <p className="cash-register__since">Caja abierta desde {dateTimeShort(data.open.openedAt)}</p>

          {!closing ? (
            <button className="btn btn--ghost btn--block" onClick={() => setClosing(true)}>
              Cerrar caja
            </button>
          ) : (
            <form className="cash-register__close" onSubmit={handleClose}>
              <div className="field">
                <label htmlFor="closing-counted">Monto contado en caja</label>
                <input
                  id="closing-counted"
                  type="number"
                  min="0"
                  placeholder="Contá el efectivo físico"
                  value={closingCounted}
                  onChange={(e) => setClosingCounted(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="closing-notes">Notas (opcional)</label>
                <textarea
                  id="closing-notes"
                  rows={2}
                  value={closingNotes}
                  onChange={(e) => setClosingNotes(e.target.value)}
                />
              </div>
              <div className="cash-register__close-actions">
                <button type="button" className="btn btn--ghost btn--block" onClick={() => setClosing(false)}>
                  Cancelar
                </button>
                <button className="btn btn--primary btn--block" disabled={busy}>
                  {busy ? "Cerrando…" : "Confirmar cierre"}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {result && (
        <div className={`cash-register__result ${result.difference === 0 ? "is-ok" : result.difference > 0 ? "is-over" : "is-under"}`}>
          <strong>
            {result.difference === 0
              ? "✅ Caja exacta"
              : result.difference > 0
              ? `Sobran ${formatPrice(result.difference)}`
              : `Faltan ${formatPrice(Math.abs(result.difference))}`}
          </strong>
          <span>Esperado: {formatPrice(result.expected)}</span>
        </div>
      )}

      {data.history.length > 0 && (
        <div className="cash-register__history">
          <h5>Historial</h5>
          {data.history.map((h) => {
            const dif = Number(h.difference) || 0;
            // Reutiliza los badges de estado de pago: ya tienen verde / ámbar /
            // rojo en el tema oscuro del admin. Sobra = ámbar, falta = rojo.
            const badge = dif === 0 ? "badge--pay-approved" : dif > 0 ? "badge--pay-pending" : "badge--pay-rejected";
            return (
              <div className="cash-register__hrow" key={h.id}>
                <span className="cash-register__hdate">{dateShort(h.closedAt)}</span>
                <span className="cash-register__hmoney">
                  <span>Apertura <b>{formatPrice(h.openingAmount)}</b></span>
                  <span>Contado <b>{formatPrice(h.closingCounted)}</b></span>
                </span>
                <span className={`badge ${badge}`}>
                  {dif === 0 ? "Exacta" : `${dif > 0 ? "+" : "−"}${formatPrice(Math.abs(dif))}`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
