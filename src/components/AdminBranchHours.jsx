import { useCallback, useEffect, useRef, useState } from "react";
import { adminGetBranchHours, adminReplaceBranchHours } from "../api.js";
import { BRANCHES, BRANCH_LIST } from "../data/branches.js";
import Dropdown from "./ui/Dropdown.jsx";
import ConfirmModal from "./ui/ConfirmModal.jsx";
import Switch from "./ui/Switch.jsx";
import { IconPlus, IconTrash, IconClock, IconAlertCircle } from "./ui/icons.jsx";

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

const EMPTY_SLOT = { open: "", close: "", closed: false };

// Normaliza respuesta del servidor ({ closed, slots: [{open, close}] })
// a formato del formulario: { [day]: [{ open, close, closed }] }
function normalizeServerHours(serverHours) {
  if (!serverHours || typeof serverHours !== "object" || Object.keys(serverHours).length === 0) return {};
  const normalized = {};
  for (let day = 0; day < 7; day++) {
    const d = serverHours[String(day)] || serverHours[day];
    if (!d) {
      normalized[String(day)] = [{ ...EMPTY_SLOT }];
      continue;
    }
    if (d.closed) {
      normalized[String(day)] = [{ ...EMPTY_SLOT, closed: true }];
      continue;
    }
    const slots = (d.slots || []).map((s, i) => ({
      open: s.open || "",
      close: s.close || "",
      closed: false,
    }));
    normalized[String(day)] = slots.length ? slots : [{ ...EMPTY_SLOT }];
  }
  return normalized;
}

// Convierte formato del formulario a payload del servidor
// { [day]: [{ open, close, closed }] } -> { [day]: { closed, slots: [{open, close}] } }
function denormalizeForServer(formHours) {
  if (!formHours || typeof formHours !== "object" || Object.keys(formHours).length === 0) return {};
  const payload = {};
  for (let day = 0; day < 7; day++) {
    const key = String(day);
    const slots = formHours[key] || [];
    const validSlots = slots.filter((s) => s.open && s.close);
    if (validSlots.length === 0) {
      payload[key] = { closed: true, slots: [] };
    } else {
      payload[key] = {
        closed: false,
        slots: validSlots.map((s, i) => ({ open: s.open, close: s.close })),
      };
    }
  }
  return payload;
}

// Verifica si la sucursal queda cerrada todos los días
function isFullyClosed(formHours) {
  if (!formHours) return true;
  for (let day = 0; day < 7; day++) {
    const slots = formHours[String(day)] || [];
    const hasOpen = slots.some((s) => s.open && s.close && !s.closed);
    if (hasOpen) return false;
  }
  return true;
}

function slotKey(day, slot) {
  return `${day}-${slot}`;
}

export default function AdminBranchHours({ me }) {
  const isBranchAdmin = me?.role === "branch_admin";
  const [branchId, setBranchId] = useState(isBranchAdmin ? me.branch : BRANCH_LIST[0]?.id || "");
  const [hours, setHours] = useState({}); // day -> [{ open, close, closed }]
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmState, setConfirmState] = useState(null);
  const [dirty, setDirty] = useState(false);
  const lastLoadedBranch = useRef(branchId);

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    setError("");
    try {
      const data = await adminGetBranchHours(branchId);
      // Server returns: { hours: { [branchId]: { [day]: { closed, slots: [{open, close}] } } } }
      const serverHours = data.hours?.[branchId] || {};
      const normalized = normalizeServerHours(serverHours);
      setHours(normalized);
      setDirty(false);
      lastLoadedBranch.current = branchId;
    } catch (err) {
      setError(err.message);
      setHours({});
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  function getSlots(day) {
    return hours[String(day)] || [{ ...EMPTY_SLOT }];
  }

  function addSlot(day) {
    const slots = getSlots(day);
    if (slots.length >= 3) return;
    setHours({ ...hours, [day]: [...slots, { ...EMPTY_SLOT }] });
    setDirty(true);
  }

  function removeSlot(day, slotIdx) {
    const slots = getSlots(day);
    if (slots.length <= 1) return;
    const next = slots.filter((_, i) => i !== slotIdx);
    setHours({ ...hours, [day]: next });
    setDirty(true);
  }

  function updateSlot(day, slotIdx, field, value) {
    const slots = getSlots(day).map((s, i) => i === slotIdx ? { ...s, [field]: value } : s);
    setHours({ ...hours, [day]: slots });
    setDirty(true);
  }

  function handleDayToggle(day, isOpen) {
    const slots = getSlots(day);
    if (isOpen) {
      // Abrir: si estaba cerrado todo el día, poner una franja vacía
      const hasAny = slots.some((s) => s.open && s.close);
      if (!hasAny) {
        setHours({ ...hours, [day]: [{ ...EMPTY_SLOT }] });
      } else {
        // Asegurar que no queden con closed=true
        setHours({ ...hours, [day]: slots.map((s) => ({ ...s, closed: false })) });
      }
    } else {
      // Cerrar: marcar todo como cerrado
      setHours({ ...hours, [day]: slots.map((s) => ({ ...s, closed: true })) });
    }
    setDirty(true);
  }

  async function handleSave() {
    if (isFullyClosed(hours)) {
      setConfirmState({
        title: "¿Confirmar cierre total?",
        message: "Esta sucursal quedará cerrada todos los días. ¿Estás seguro?",
        confirmText: "Sí, cerrar todo",
        onConfirm: doSave,
        variant: "danger",
      });
      return;
    }
    await doSave();
  }

  async function doSave() {
    setSaving(true);
    setError("");
    try {
      const payload = denormalizeForServer(hours);
      await adminReplaceBranchHours(branchId, payload);
      await load();
      setDirty(false);
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
        await load();
      },
    });
  }

  async function handleBranchChange(newBranchId) {
    if (dirty && newBranchId !== branchId) {
      setConfirmState({
        title: "Cambios sin guardar",
        message: "Hay cambios sin guardar. ¿Cambiar de sucursal y descartarlos?",
        confirmText: "Descartar y cambiar",
        onConfirm: () => {
          setBranchId(newBranchId);
        },
      });
    } else {
      setBranchId(newBranchId);
    }
  }

  const hasData = Object.keys(hours).some((d) =>
    (hours[d] || []).some((s) => s.open && s.close)
  );

  return (
    <>
      <div className="admin-products__controls" style={{ marginBottom: 14 }}>
        {isBranchAdmin ? (
          <span className="badge badge--branch">{BRANCH_LIST.find((b) => b.id === branchId)?.name}</span>
        ) : (
          <Dropdown
            value={branchId}
            onChange={handleBranchChange}
            options={BRANCH_LIST.map((b) => ({ value: b.id, label: b.name }))}
          />
        )}
        <button
          className="btn btn--ghost btn--sm"
          onClick={openConfirmReset}
          disabled={loading || saving}
        >
          <IconClock style={{ width: 13, height: 13 }} /> Restablecer a por defecto
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}

      {loading ? (
        <p className="hint">Cargando horarios…</p>
      ) : !hasData && !error ? (
        <div className="admin-empty">
          <IconAlertCircle className="empty-state__icon" style={{ width: 48, height: 48 }} />
          <strong>No hay horarios configurados</strong>
          <span>Esta sucursal no tiene horarios en la base de datos.</span>
        </div>
      ) : (
        <>
          {DAYS.map((day) => {
            const dayKey = String(day.id);
            const slots = getSlots(dayKey);
            const isDayClosed = slots.every((s) => s.closed || !s.open || !s.close);
            return (
              <section className="admin-bh-day" key={day.id}>
                <div className="admin-bh-day__head">
                  <h4 className="admin-bh-day__name">{day.label}</h4>
                  <Switch
                    checked={!isDayClosed}
                    onChange={(v) => handleDayToggle(dayKey, v)}
                    disabled={loading || saving}
                    size="sm"
                  />
                </div>
                <div className="admin-bh-day__slots">
                  {slots.map((slot, idx) => (
                    <div className="admin-bh-slot" key={slotKey(day.id, idx)}>
                      <div className="admin-bh-slot__inputs">
                        <div className="admin-bh-slot__input">
                          <span className="admin-bh-slot__input-label">Apertura</span>
                          <input
                            type="time"
                            value={slot.open}
                            onChange={(e) => updateSlot(dayKey, idx, "open", e.target.value)}
                            disabled={slot.closed || loading || saving}
                          />
                        </div>
                        <div className="admin-bh-slot__input">
                          <span className="admin-bh-slot__input-label">Cierre</span>
                          <input
                            type="time"
                            value={slot.close}
                            onChange={(e) => updateSlot(dayKey, idx, "close", e.target.value)}
                            disabled={slot.closed || loading || saving}
                          />
                        </div>
                        {slot.close && slot.open && slot.close < slot.open && (
                          <span className="admin-bh-slot__midnight-note">
                            <IconAlertCircle style={{ width: 12, height: 12 }} /> Cierra al día siguiente
                          </span>
                        )}
                      </div>
                      {slots.length > 1 && (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm admin-bh-slot__remove"
                          onClick={() => removeSlot(dayKey, idx)}
                          aria-label={`Eliminar franja ${idx + 1}`}
                          disabled={loading || saving}
                        >
                          <IconTrash style={{ width: 14, height: 14 }} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {slots.length < 3 && !isDayClosed && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm admin-bh-day__add"
                    onClick={() => addSlot(dayKey)}
                    disabled={loading || saving}
                  >
                    <IconPlus style={{ width: 13, height: 13 }} /> Agregar franja
                  </button>
                )}
              </section>
            );
          })}

          <div style={{ marginTop: 24 }}>
            <button
              className="btn btn--primary btn--block"
              onClick={handleSave}
              disabled={saving || loading || !dirty}
            >
              {saving ? "Guardando…" : dirty ? "Guardar cambios" : "Sin cambios"}
            </button>
            {dirty && <p className="hint" style={{ marginTop: 8, textAlign: "center" }}>Hay cambios sin guardar</p>}
          </div>
        </>
      )}

      {confirmState && (
        <ConfirmModal
          variant={confirmState.variant || "default"}
          title={confirmState.title}
          message={confirmState.message}
          confirmText={confirmState.confirmText}
          onConfirm={confirmState.onConfirm}
          onClose={() => setConfirmState(null)}
        />
      )}
    </>
  );
}