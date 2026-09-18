import { useCallback, useEffect, useState } from "react";
import { adminSales, adminCashRegister, adminOpenCashRegister, adminCloseCashRegister } from "../api.js";
import { BRANCH_LIST } from "../data/branches.js";
import { formatPrice } from "../utils/format.js";
import Dropdown from "./ui/Dropdown.jsx";
import DateRangePicker from "./ui/DateRangePicker.jsx";

const PERIODS = [
  { id: "today", label: "Hoy" },
  { id: "7d", label: "Últimos 7 días" },
  { id: "30d", label: "Últimos 30 días" },
  { id: "custom", label: "Personalizado" },
];

const PAYMENT_LABELS = { efectivo: "💰 Efectivo", mercadopago: "💳 Mercado Pago", transferencia: "🏦 Transferencia" };

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function periodRange(period, from, to) {
  const n = new Date();
  if (period === "today") return { from: startOfToday(), to: n };
  if (period === "7d") return { from: new Date(n.getTime() - 7 * 86400000), to: n };
  if (period === "30d") return { from: new Date(n.getTime() - 30 * 86400000), to: n };
  const f = from ? new Date(from) : new Date(n.getTime() - 30 * 86400000);
  const t = to ? new Date(to) : n;
  return { from: f, to: t };
}

// ============================================================
// AdminSales — ventas por período + arqueo de caja
// ============================================================
export default function AdminSales() {
  const [branch, setBranch] = useState(BRANCH_LIST[0]?.id || "");
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
        <Dropdown value={branch} onChange={setBranch} options={BRANCH_LIST.map((b) => ({ value: b.id, label: b.name }))} />
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
              <span className="stat-card__label">Total vendido</span>
              <strong className="stat-card__value">{formatPrice(sales.total)}</strong>
            </div>
            <div className="stat-card">
              <span className="stat-card__label">Ticket promedio</span>
              <strong className="stat-card__value">{formatPrice(sales.average)}</strong>
            </div>
            <div className="stat-card">
              <span className="stat-card__label">Pedidos</span>
              <strong className="stat-card__value">{sales.count}</strong>
            </div>
          </div>

          <div className="payment-breakdown">
            <h4>Por método de pago</h4>
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
          <div className="cash-register__row">
            <span>Apertura</span>
            <strong>{formatPrice(data.open.openingAmount)}</strong>
          </div>
          <div className="cash-register__row">
            <span>Desde</span>
            <span>{new Date(data.open.openedAt).toLocaleString("es-AR")}</span>
          </div>
          <div className="cash-register__row cash-register__row--highlight">
            <span>Esperado ahora (apertura + efectivo)</span>
            <strong>{formatPrice(data.open.expectedNow)}</strong>
          </div>

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
          {data.history.map((h) => (
            <div className="cash-register__hrow" key={h.id}>
              <span>{new Date(h.closedAt).toLocaleDateString("es-AR")}</span>
              <span>Apertura {formatPrice(h.openingAmount)}</span>
              <span>Contado {formatPrice(h.closingCounted)}</span>
              <strong className={h.difference === 0 ? "" : h.difference > 0 ? "is-over" : "is-under"}>
                {h.difference === 0 ? "Exacta" : h.difference > 0 ? `+${formatPrice(h.difference)}` : `-${formatPrice(Math.abs(h.difference))}`}
              </strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
