import { useCallback, useEffect, useState } from "react";
import { adminGetBranchHours, adminReplaceBranchHours } from "../api.js";
import { BRANCHES, BRANCH_LIST } from "../data/branches.js";
import Dropdown from "./ui/Dropdown.jsx";
import ConfirmModal from "./ui/ConfirmModal.jsx";
import { IconPlus, IconEdit, IconTrash, IconClock } from "./ui/icons.jsx";

// ============================================================
// AdminBranchHours — edición de horarios por sucursal
// Permite ver y editar los horarios de apertura (franjas) por día de la semana.
// ============================================================

const DAYS = [
  { id: 0, label: "Domingo", short: "Dom" },
  { id: 1, label: "Lunes", short: "Lun" },
  { id: 2, label: "Martes", short: "Mar" },
  { id: 3, label: "Miércoles", short: "Mié" },
  { id: 4, label: "Jueves", short: "Jue" },
  { id: 5, label: "Viernes", short: "Vie" },
  { id: 6, label: "Sábado", short: "Sáb" },
];

const EMPTY_SLOT = { open_time: "", close_time: "", closed: false };

function slotKey(day, slot) {
  return `${day}-${slot}`;
}

export default function AdminBranchHours({ me }) {
  const isBranchAdmin = me?.role === "branch_admin";
  const [branchId, setBranchId] = useState(isBranchAdmin ? me.branch : BRANCH_LIST[0]?.id || "");
  const [hours, setHours] = useState({}); // day -> [slots]
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmState, setConfirmState] = useState(null);

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const data = await adminGetBranchHours(branchId);
      // data: { hours: { [day]: [{ open_time, close_time, closed, slot }] } }
      const parsed = {};
      for (const [day, slots] of Object.entries(data.hours || {})) {
        parsed[day] = slots.map((s) => ({
          open_time: s.open_time || "",
          close_time: s.close_time || "",
          closed: s.closed === 1 || s.closed === true,
          slot: s.slot,
        }));
      }
      setHours(parsed);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  function getSlots(day) {
    return hours[day] || [EMPTY_SLOT];
  }

  function addSlot(day) {
    const slots = getSlots(day);
    setHours({ ...hours, [day]: [...slots, { ...EMPTY_SLOT, slot: slots.length }] });
  }

  function removeSlot(day, slotIdx) {
    const slots = getSlots(day);
    if (slots.length <= 1) return;
    const next = slots.filter((_, i) => i !== slotIdx).map((s, i) => ({ ...s, slot: i }));
    setHours({ ...hours, [day]: next });
  }

  function updateSlot(day, slotIdx, field, value) {
    const slots = getSlots(day).map((s, i) => i === slotIdx ? { ...s, [field]: value } : s);
    setHours({ ...hours, [day]: slots });
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const payload = {};
      for (const [day, slots] of Object.entries(hours)) {
        payload[day] = slots.filter((s) => s.open_time && s.close_time).map((s) => ({
          open_time: s.open_time,
          close_time: s.close_time,
          closed: s.closed ? 1 : 0,
        }));
      }
      await adminReplaceBranchHours(branchId, payload);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function openConfirmReset() {
    setConfirmState({
      title: "Restablecer horarios",
      message: `¿Restablecer los horarios de ${BRANCHES[branchId]?.name || branchId} a los valores por defecto? Se perderán los cambios no guardados.`,
      confirmText: "Restablecer",
      onConfirm: async () => {
        // Recargar desde el servidor (que tiene los valores por defecto si no hay datos)
        await load();
      },
    });
  }

  return (
    <div className="admin-branch-hours">
      <div className="admin-products__controls" style={{ marginBottom: 14 }}>
        {isBranchAdmin ? (
          <span className="badge badge--branch">{BRANCH_LIST.find((b) => b.id === branchId)?.name}</span>
        ) : (
          <Dropdown
            value={branchId}
            onChange={setBranchId}
            options={BRANCH_LIST.map((b) => ({ value: b.id, label: b.name }))}
          />
        )}
        <button className="btn btn--ghost btn--sm" onClick={openConfirmReset}>
          <IconClock style={{ width: 13, height: 13 }} /> Restablecer a por defecto
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}

      {loading ? (
        <p className="hint">Cargando horarios…</p>
      ) : (
        <>
          {DAYS.map((day) => {
            const slots = getSlots(day.id);
            return (
              <section className="admin-bh-day" key={day.id}>
                <h4 className="admin-bh-day__name">{day.label}</h4>
                <div className="admin-bh-day__slots">
                  {slots.map((slot, idx) => (
                    <div className="admin-bh-slot" key={slotKey(day.id, idx)}>
                      <label className="admin-bh-slot__label">
                        <span>Franja {idx + 1}</span>
                        {slots.length > 1 && (
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm admin-bh-slot__remove"
                            onClick={() => removeSlot(day.id, idx)}
                            aria-label={`Eliminar franja ${idx + 1}`}
                          >
                            <IconTrash style={{ width: 14, height: 14 }} />
                          </button>
                        )}
                      </label>
                      <div className="admin-bh-slot__inputs">
                        <div className="admin-bh-slot__input">
                          <span className="admin-bh-slot__input-label">Apertura</span>
                          <input
                            type="time"
                            value={slot.open_time}
                            onChange={(e) => updateSlot(day.id, idx, "open_time", e.target.value)}
                            disabled={slot.closed}
                          />
                        </div>
                        <div className="admin-bh-slot__input">
                          <span className="admin-bh-slot__input-label">Cierre</span>
                          <input
                            type="time"
                            value={slot.close_time}
                            onChange={(e) => updateSlot(day.id, idx, "close_time", e.target.value)}
                            disabled={slot.closed}
                          />
                        </div>
                        <label className="admin-bh-slot__closed">
                          <input
                            type="checkbox"
                            checked={slot.closed}
                            onChange={(e) => updateSlot(day.id, idx, "closed", e.target.checked)}
                          />
                          <span>Cerrado todo el día</span>
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
                {slots.length < 4 && (
                  <button type="button" className="btn btn--ghost btn--sm admin-bh-day__add" onClick={() => addSlot(day.id)}>
                    <IconPlus style={{ width: 13, height: 13 }} /> Agregar franja
                  </button>
                )}
              </section>
            );
          })}

          <div style={{ marginTop: 24 }}>
            <button className="btn btn--primary btn--block" onClick={handleSave} disabled={saving}>
              {saving ? "Guardando…" : "Guardar horarios"}
            </button>
          </div>
        </>
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
    </div>
  );
}