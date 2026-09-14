import { useCallback, useEffect, useState } from "react";
import {
  adminCoupons,
  adminCreateCoupon,
  adminToggleCoupon,
  adminDeleteCoupon,
} from "../api.js";
import { formatPrice } from "../utils/format.js";
import useDialogA11y from "../hooks/useDialogA11y.js";
import Dropdown from "./ui/Dropdown.jsx";
import DateTimePicker from "./ui/DateTimePicker.jsx";
import ConfirmModal from "./ui/ConfirmModal.jsx";

// ============================================================
// AdminCoupons — cupones de descuento
// - Crear cupones (% o monto fijo, mínimo de compra, usos, vencimiento)
// - Activar / desactivar / eliminar
// - La validación se hace server-side al crear el pedido
// ============================================================

const EMPTY = {
  code: "",
  type: "percent",
  value: "",
  minTotal: "",
  maxUses: "",
  expiresAt: "",
};

function typeLabel(type, value) {
  return type === "percent" ? `${value}%` : formatPrice(value);
}

export default function AdminCoupons() {
  const [coupons, setCoupons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [confirmState, setConfirmState] = useState(null);
  const dialogRef = useDialogA11y({ onClose: () => setCreating(false), isActive: creating });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminCoupons();
      setCoupons(data.coupons);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(e) {
    e.preventDefault();
    setError("");
    try {
      await adminCreateCoupon({
        code: form.code,
        type: form.type,
        value: Number(form.value),
        minTotal: form.minTotal ? Number(form.minTotal) : 0,
        maxUses: form.maxUses ? Number(form.maxUses) : 0,
        expiresAt: form.expiresAt || "",
      });
      setCreating(false);
      setForm(EMPTY);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleToggle(coupon) {
    try {
      await adminToggleCoupon(coupon.id, !coupon.active);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function handleDelete(coupon) {
    setConfirmState({
      title: "Eliminar cupón",
      message: `¿Eliminar el cupón "${coupon.code}"?`,
      confirmText: "Eliminar",
      onConfirm: async () => {
        await adminDeleteCoupon(coupon.id);
        await load();
      },
    });
  }

  return (
    <section className="admin-coupons">
      <div className="admin-products__toolbar">
        <h3>🏷️ Cupones de descuento</h3>
        <button className="btn btn--primary btn--sm" onClick={() => { setCreating(true); setError(""); }}>
          ➕ Crear cupón
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}

      {loading && coupons.length === 0 ? (
        <p className="hint">Cargando cupones…</p>
      ) : coupons.length === 0 ? (
        <div className="admin-empty">Todavía no hay cupones. Creá uno para ofrecer descuentos.</div>
      ) : (
        <div className="coupons-list">
          {coupons.map((c) => (
            <div className={`coupon-card ${c.active ? "" : "is-hidden"}`} key={c.id}>
              <div className="coupon-card__main">
                <strong className="coupon-card__code">{c.code}</strong>
                <span className="coupon-card__value">{typeLabel(c.type, c.value)}</span>
              </div>
              <div className="coupon-card__meta">
                {c.minTotal > 0 && <span>Mínimo {formatPrice(c.minTotal)}</span>}
                {c.maxUses > 0 && <span>{c.usedCount}/{c.maxUses} usos</span>}
                {c.expiresAt && <span>Vence {new Date(c.expiresAt).toLocaleDateString("es-AR")}</span>}
                {!c.expiresAt && <span>Sin vencimiento</span>}
              </div>
              <div className="coupon-card__actions">
                <button className="btn btn--ghost btn--sm" onClick={() => handleToggle(c)}>
                  {c.active ? "🙈 Desactivar" : "👁️ Activar"}
                </button>
                <button className="btn btn--danger btn--sm" onClick={() => handleDelete(c)} aria-label={`Eliminar cupón ${c.code}`}>🗑️</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="coupon-modal-title"
            ref={dialogRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal__head">
              <h3 id="coupon-modal-title">Nuevo cupón</h3>
              <button className="modal__close" onClick={() => setCreating(false)} aria-label="Cerrar">✕</button>
            </div>
            <form className="modal__body" onSubmit={handleCreate}>
              <div className="field">
                <label htmlFor="cup-code">Código</label>
                <input
                  id="cup-code"
                  type="text"
                  required
                  maxLength={30}
                  placeholder="Ej: WOK10"
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                />
              </div>
              <div className="field">
                <label>Tipo</label>
                <Dropdown
                  value={form.type}
                  onChange={(v) => setForm({ ...form, type: v })}
                  options={[
                    { value: "percent", label: "Porcentaje (%)" },
                    { value: "fixed", label: "Monto fijo ($)" },
                  ]}
                  ariaLabel="Tipo de cupón"
                />
              </div>
              <div className="field">
                <label htmlFor="cup-value">
                  Valor ({form.type === "percent" ? "ej: 10 = 10%" : "ej: 1500 = $1.500"})
                </label>
                <input
                  id="cup-value"
                  type="number"
                  min="1"
                  max={form.type === "percent" ? 100 : undefined}
                  required
                  value={form.value}
                  onChange={(e) => setForm({ ...form, value: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="cup-min">Pedido mínimo (opcional)</label>
                <input
                  id="cup-min"
                  type="number"
                  min="0"
                  placeholder="0 = sin mínimo"
                  value={form.minTotal}
                  onChange={(e) => setForm({ ...form, minTotal: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="cup-uses">Usos máximos (opcional)</label>
                <input
                  id="cup-uses"
                  type="number"
                  min="0"
                  placeholder="0 = ilimitado"
                  value={form.maxUses}
                  onChange={(e) => setForm({ ...form, maxUses: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Vencimiento (opcional)</label>
                <DateTimePicker
                  value={form.expiresAt}
                  onChange={(v) => setForm({ ...form, expiresAt: v })}
                  placeholder="Sin vencimiento"
                  ariaLabel="Vencimiento del cupón"
                />
              </div>

              {error && <div className="form-error">{error}</div>}

              <div className="modal__footer">
                <button type="submit" className="btn btn--primary btn--block">Crear cupón</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {confirmState && (
        <ConfirmModal
          variant="danger"
          title={confirmState.title}
          message={confirmState.message}
          confirmText={confirmState.confirmText}
          onConfirm={confirmState.onConfirm}
          onClose={() => setConfirmState(null)}
        />
      )}
    </section>
  );
}