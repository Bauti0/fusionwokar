import { useCallback, useEffect, useRef, useState } from "react";
import { adminExtras, adminUpdateExtra } from "../api.js";
import { BRANCH_LIST } from "../data/branches.js";
import Dropdown from "./ui/Dropdown.jsx";
import Switch from "./ui/Switch.jsx";

// ============================================================
// AdminExtras — sección "Adicionales" del panel
// Lista cada adicional UNA sola vez por sucursal (aunque esté
// copiado en muchos productos, como el teriyaki en todos los
// woks), agrupados por categoría, y permite:
//   - cambiar el precio → se aplica a TODOS los productos que lo
//     tienen;
//   - ocultarlo/mostrarlo → el oculto desaparece del menú público
//     y no se puede cobrar en pedidos nuevos.
// El admin de sucursal opera SOLO la suya (el server la fuerza).
// Guardado: el precio se guarda al salir del campo o con Enter; la
// visibilidad, al tocar el interruptor (mismo comportamiento de
// siempre, solo cambia cómo se ve).
// ============================================================

// Clave de AGRUPACIÓN (solo presentación): minúsculas, sin acentos,
// sin "s" final ("GALLETAS" y "galleta" caen juntas). No modifica
// ningún dato: el título del grupo sale del subgroupLabel original
// del primer adicional del grupo que lo tenga.
function groupKey(extra) {
  return (extra.subgroupLabel || extra.subgroup || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/s$/, "");
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Agrupa por clave y devuelve [{ title, extras }] en orden de
// aparición. El título: subgroupLabel original del grupo (si alguien
// lo tiene); si no, el subgroup del primero capitalizado; sin datos,
// "ADICIONALES".
function groupExtras(extras) {
  const groups = new Map();
  for (const extra of extras) {
    const key = groupKey(extra) || "otros";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(extra);
  }
  return Array.from(groups.values()).map((list) => {
    const titled = list.find((e) => e.subgroupLabel);
    const titledSub = list.find((e) => e.subgroup);
    return {
      title: titled ? titled.subgroupLabel : titledSub ? capitalize(titledSub.subgroup) : "ADICIONALES",
      extras: list,
    };
  });
}

export default function AdminExtras({ me }) {
  const isBranchAdmin = me?.role === "branch_admin";
  const [branchId, setBranchId] = useState(isBranchAdmin ? me.branch : BRANCH_LIST[0]?.id || "");
  const [extras, setExtras] = useState([]);
  const [prices, setPrices] = useState({}); // id -> string del input
  // Estado de guardado POR FILA: saving | saved | error. La región
  // aria-live de cada fila lo anuncia sin mover el foco.
  const [statuses, setStatuses] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Timers del "✓ Guardado" (2s), uno por fila; se limpian al
  // desmontar para no dejar timers colgados.
  const savedTimersRef = useRef({});

  useEffect(() => {
    const timers = savedTimersRef.current;
    return () => {
      for (const id of Object.keys(timers)) clearTimeout(timers[id]);
    };
  }, []);

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const data = await adminExtras(branchId);
      setExtras(data.extras);
      const init = {};
      for (const e of data.extras) init[e.id] = String(e.price);
      setPrices(init);
      setStatuses({});
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

  // Marca el resultado de guardar en la fila (presentación sobre la
  // promesa que ya resolvía la lógica de siempre).
  function setStatus(id, state) {
    clearTimeout(savedTimersRef.current[id]);
    delete savedTimersRef.current[id];
    setStatuses((prev) => ({ ...prev, [id]: state }));
    if (state === "saved") {
      savedTimersRef.current[id] = setTimeout(() => {
        setStatuses((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        delete savedTimersRef.current[id];
      }, 2000);
    }
  }

  async function handleToggle(extra) {
    // Doble toque mientras guarda: la fila ya está en curso.
    if (statuses[extra.id] === "saving") return;
    setStatus(extra.id, "saving");
    setError("");
    try {
      await adminUpdateExtra(extra.id, { branch: branchId, available: !extra.available });
      await load();
      // load() limpia statuses; el aviso se setea después de recargar.
      setStatus(extra.id, "saved");
    } catch (err) {
      setError(err.message);
      setStatus(extra.id, "error");
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
    setStatus(extra.id, "saving");
    setError("");
    try {
      await adminUpdateExtra(extra.id, { branch: branchId, price });
      await load();
      setStatus(extra.id, "saved");
    } catch (err) {
      setError(err.message);
      setStatus(extra.id, "error");
    }
  }

  const groups = groupExtras(extras);

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

      {/* Cartel informativo: lo más importante de la pantalla. */}
      <div className="admin-extras__notice" role="note">
        <span className="admin-extras__notice-icon" aria-hidden="true">i</span>
        <p>
          Cada cambio se aplica a <strong>todos</strong> los productos de la sucursal que tienen
          ese adicional. El precio se guarda al salir del campo; la visibilidad, al tocarlo.
        </p>
      </div>

      {error && <div className="form-error">{error}</div>}

      {loading && !extras.length ? (
        <p className="hint">Cargando adicionales…</p>
      ) : extras.length === 0 ? (
        <div className="admin-empty">No hay adicionales en esta sucursal.</div>
      ) : (
        groups.map((group) => (
          <section className="admin-extras__group" key={group.title}>
            <h4 className="admin-cat__name">{group.title}</h4>
            <div className="admin-cat">
              {group.extras.map((e) => {
                const status = statuses[e.id];
                const busy = status === "saving";
                return (
                  <div className={`admin-extras__row ${e.available ? "" : "admin-extras__row--hidden"}`} key={e.id}>
                    <div className="admin-extras__info">
                      <strong className="admin-extras__name">{e.label}</strong>
                      <span className="admin-extras__sub">
                        en {e.productCount} {e.productCount === 1 ? "producto" : "productos"}
                      </span>
                    </div>
                    <div className="admin-extras__controls">
                      <label className="admin-extras__price">
                        <span className="admin-extras__currency" aria-hidden="true">$</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min="0"
                          step="1"
                          value={prices[e.id] ?? ""}
                          disabled={busy}
                          onChange={(ev) =>
                            setPrices((prev) => ({ ...prev, [e.id]: ev.target.value }))
                          }
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter") handleSavePrice(e);
                          }}
                          onBlur={() => handleSavePrice(e)}
                          aria-label={`Precio de ${e.label}`}
                          aria-describedby={`ex-status-${e.id}`}
                        />
                      </label>
                      <span className="admin-extras__status" id={`ex-status-${e.id}`} aria-live="polite">
                        {busy ? "Guardando…" : status === "saved" ? "✓ Guardado" : status === "error" ? "No se pudo guardar" : ""}
                      </span>
                      {/* El switch SIEMPRE a opacidad completa: un oculto
                          tiene que verse reactivable. */}
                      <Switch
                        checked={e.available}
                        onChange={() => handleToggle(e)}
                        label={e.available ? "Visible" : "Oculto"}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
