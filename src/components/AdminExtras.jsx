import { useCallback, useEffect, useState } from "react";
import { adminExtras, adminUpdateExtra } from "../api.js";
import { BRANCH_LIST } from "../data/branches.js";
import Dropdown from "./ui/Dropdown.jsx";
import Tooltip from "./ui/Tooltip.jsx";

// ============================================================
// AdminExtras — sección "Adicionales" del panel
// Lista cada adicional UNA sola vez por sucursal (aunque esté
// copiado en muchos productos, como el teriyaki en todos los
// woks) y permite:
//   - cambiar el precio → se aplica a TODOS los productos que lo
//     tienen;
//   - ocultarlo/mostrarlo → el oculto desaparece del menú público
//     y no se puede cobrar en pedidos nuevos.
// El admin de sucursal opera SOLO la suya (el server la fuerza).
// ============================================================

export default function AdminExtras({ me }) {
  const isBranchAdmin = me?.role === "branch_admin";
  const [branchId, setBranchId] = useState(isBranchAdmin ? me.branch : BRANCH_LIST[0]?.id || "");
  const [extras, setExtras] = useState([]);
  const [prices, setPrices] = useState({}); // id -> string del input
  const [saving, setSaving] = useState(null); // id que está guardando
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const data = await adminExtras(branchId);
      setExtras(data.extras);
      const init = {};
      for (const e of data.extras) init[e.id] = String(e.price);
      setPrices(init);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleToggle(extra) {
    setSaving(extra.id);
    setError("");
    try {
      await adminUpdateExtra(extra.id, { branch: branchId, available: !extra.available });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(null);
    }
  }

  async function handleSavePrice(extra) {
    const raw = String(prices[extra.id] ?? "").trim();
    if (raw === "" || raw === String(extra.price)) return;
    const price = Number(raw);
    if (!Number.isInteger(price) || price < 0) {
      setError("Precio inválido");
      return;
    }
    setSaving(extra.id);
    setError("");
    try {
      await adminUpdateExtra(extra.id, { branch: branchId, price });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="admin-products admin-extras">
      <div className="admin-products__toolbar">
        <div className="admin-products__controls">
          {isBranchAdmin ? (
            <span className="badge badge--branch">
              {BRANCH_LIST.find((b) => b.id === branchId)?.name || branchId}
            </span>
          ) : (
            <Dropdown
              value={branchId}
              onChange={setBranchId}
              options={BRANCH_LIST.map((b) => ({ value: b.id, label: b.name }))}
            />
          )}
        </div>
      </div>
      <p className="hint">
        El cambio de precio o de visibilidad se aplica a <strong>todos</strong> los productos de la
        sucursal que tienen ese adicional.
      </p>

      {error && <div className="form-error">{error}</div>}

      {loading && !extras.length ? (
        <p className="hint">Cargando adicionales…</p>
      ) : extras.length === 0 ? (
        <div className="admin-empty">No hay adicionales en esta sucursal.</div>
      ) : (
        <div className="admin-products__list">
          {extras.map((e) => (
            <div className={`admin-product ${e.available ? "" : "is-hidden"}`} key={e.id}>
              <div className="admin-product__info">
                <div className="admin-product__title">
                  <strong>{e.label}</strong>
                  <span className="hint">
                    {e.subgroupLabel || "Adicional"} · en {e.productCount}{" "}
                    {e.productCount === 1 ? "producto" : "productos"}
                  </span>
                </div>
                <label className="admin-extras__price">
                  <span>$</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="1"
                    value={prices[e.id] ?? ""}
                    disabled={saving === e.id}
                    onChange={(ev) => setPrices((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") handleSavePrice(e);
                    }}
                    onBlur={() => handleSavePrice(e)}
                    aria-label={`Precio de ${e.label}`}
                  />
                </label>
              </div>
              <div className="admin-product__actions">
                <Tooltip label={e.available ? "Ocultar del menú" : "Mostrar en el menú"}>
                  <button
                    className="btn btn--ghost btn--sm"
                    disabled={saving === e.id}
                    onClick={() => handleToggle(e)}
                    aria-label={e.available ? `Ocultar ${e.label}` : `Mostrar ${e.label}`}
                  >
                    {e.available ? "🙈" : "👁️"}
                  </button>
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
