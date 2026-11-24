// ============================================================
// FUSIÓN WOK — AdminShippingSettings
// Configuración de envío por sucursal: interruptor de cálculo automático,
// origen del local, tarifa (precio base, cuadras incluidas, precio por
// cuadra extra, máximo de cuadras), prueba de cotización y historial de
// cambios. Una fila por sucursal; el branch_admin solo ve/edita la suya.
// ============================================================
import { useCallback, useEffect, useRef, useState } from "react";
import {
  adminShippingSettings,
  adminUpdateShippingSettings,
  adminShippingSettingsTest,
} from "../api.js";
import { BRANCHES, BRANCH_LIST } from "../data/branches.js";
import { formatPriceCompact } from "../utils/format.js";
import { buildShippingText } from "../utils/shippingText.js";
import Dropdown from "./ui/Dropdown.jsx";
import ConfirmModal from "./ui/ConfirmModal.jsx";
import Switch from "./ui/Switch.jsx";
import { IconLocation, IconMapPin, IconCalculator, IconSave, IconAlertCircle } from "./ui/icons.jsx";
// IconLocation used for origin address field icon

function formatMiles(v) {
  const n = Math.max(0, Math.round(Number(v || 0)));
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
function parseMiles(s) {
  return String(s == null ? "" : s).replace(/\./g, "").replace(/[^0-9-]/g, "");
}

const NUMERIC_FIELDS = ["base_cost", "flat_blocks", "per_block", "max_blocks"];

function formIsDirty(form, settings) {
  if (!settings || !form) return false;
  const f = settingsToForm(settings);
  return (
    NUMERIC_FIELDS.some((k) => form[k] !== f[k]) ||
    form.origin_address !== f.origin_address ||
    form.auto_enabled !== f.auto_enabled
  );
}

function settingsToForm(s) {
  return {
    origin_address: s.origin_address || "",
    origin_lat: s.origin_lat == null ? "" : String(s.origin_lat),
    origin_lng: s.origin_lng == null ? "" : String(s.origin_lng),
    base_cost: s.base_cost == null ? "" : String(s.base_cost),
    flat_blocks: s.flat_blocks == null ? "" : String(s.flat_blocks),
    per_block: s.per_block == null ? "" : String(s.per_block),
    max_blocks: s.max_blocks == null ? "" : String(s.max_blocks),
    auto_enabled: s.auto_enabled == null ? "1" : String(s.auto_enabled),
  };
}

export default function AdminShippingSettings({ me }) {
  const isBranchAdmin = me?.role === "branch_admin";
  const [branchId, setBranchId] = useState(isBranchAdmin ? me.branch : BRANCH_LIST[0]?.id || "");
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [saveErr, setSaveErr] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [confirmAutoOff, setConfirmAutoOff] = useState(null); // { onConfirm }
  const [confirmBranchSwitch, setConfirmBranchSwitch] = useState(null);
  const [quoteAddress, setQuoteAddress] = useState("");
  const [quoteResult, setQuoteResult] = useState(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const lastLoadedBranch = useRef(branchId);

  const branch = BRANCHES[branchId];

  const setField = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await adminShippingSettings(branchId);
      setSettings(data);
      setForm(settingsToForm(data));
      setFieldErrors({});
      setSaveErr(null);
      setSaveMsg(null);
    } catch (err) {
      setLoadError(err.message || "No se pudo cargar la configuración");
      setSettings(null);
      setForm(null);
    } finally {
      setLoading(false);
      lastLoadedBranch.current = branchId;
    }
  }, [branchId]);

  useEffect(() => {
    load();
  }, [load]);

  function handleBranchChange(nextBranchId) {
    if (dirty && nextBranchId !== branchId) {
      setConfirmBranchSwitch({
        target: nextBranchId,
        onConfirm: () => {
          setConfirmBranchSwitch(null);
          setBranchId(nextBranchId);
        },
      });
    } else {
      setBranchId(nextBranchId);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveErr(null);
    setSaveMsg(null);
    setFieldErrors({});
    try {
      const payload = {
        branch: branchId,
        origin_address: form.origin_address.trim(),
        base_cost: Number(form.base_cost || 0),
        flat_blocks: Number(form.flat_blocks || 0),
        per_block: Number(form.per_block || 0),
        max_blocks: Number(form.max_blocks || 0),
        auto_enabled: Number(form.auto_enabled || 1),
      };
      // Solo enviar lat/lng si el usuario los editó (no están vacíos)
      // Campos ocultos: no se envían para que el servidor use los valores guardados
      // o geocodifique desde la dirección (cuando son NULL en BD)
      if (form.origin_lat !== "" && form.origin_lat !== null && form.origin_lat !== undefined) {
        payload.origin_lat = Number(form.origin_lat);
      }
      if (form.origin_lng !== "" && form.origin_lng !== null && form.origin_lng !== undefined) {
        payload.origin_lng = Number(form.origin_lng);
      }
      await adminUpdateShippingSettings(payload);
      // Usar el payload que enviamos (sabemos qué guardamos) en vez de la respuesta del server
      // que solo devuelve { ok: true, branch, changed }
      setSettings((prev) => ({ ...prev, ...payload, updated_at: new Date().toISOString(), updated_by: (me?.username || "superadmin") }));
      setForm(settingsToForm(payload));
      setSaveMsg("Guardado");
      setTimeout(() => setSaveMsg(null), 2500);
    } catch (err) {
      const field = err.field;
      setFieldErrors((prev) => ({ ...prev, [field]: err.message || "Error del servidor" }));
      setSaveErr(err.message || "No se pudo guardar");
    } finally {
      setSaving(false);
    }
  }

  // Interruptor automático: al apagarlo se pide confirmación.
  function handleAutoChange(checked) {
    const next = checked ? "1" : "0";
    if (form.auto_enabled === next) return;
    if (next === "0") {
      setConfirmAutoOff({
        title: "¿Apagar el cálculo automático de envío?",
        message:
          "Al apagarlo, el servidor no geocodifica ni consulta el mapa para esta sucursal. " +
          "Los pedidos a domicilio entran con el envío 'a confirmar' y el local fija el costo " +
          "por WhatsApp desde el panel. El retiro en el local no cambia.",
        confirmText: "Apagar cálculo automático",
        onConfirm: () => {
          setConfirmAutoOff(null);
          setField("auto_enabled", "0");
        },
      });
    } else {
      setField("auto_enabled", "1");
    }
  }

  async function handleQuote() {
    if (!quoteAddress.trim()) return;
    setQuoteBusy(true);
    setQuoteResult(null);
    try {
      const payload = {
        branch: branchId,
        address: quoteAddress.trim(),
        origin_address: form.origin_address.trim(),
        base_cost: Number(form.base_cost || 0),
        flat_blocks: Number(form.flat_blocks || 0),
        per_block: Number(form.per_block || 0),
        max_blocks: Number(form.max_blocks || 0),
        auto_enabled: Number(form.auto_enabled || 1),
      };
      // Solo enviar lat/lng si el usuario los editó (no están vacíos)
      if (form.origin_lat !== "" && form.origin_lat !== null && form.origin_lat !== undefined) {
        payload.origin_lat = Number(form.origin_lat);
      }
      if (form.origin_lng !== "" && form.origin_lng !== null && form.origin_lng !== undefined) {
        payload.origin_lng = Number(form.origin_lng);
      }
      const res = await adminShippingSettingsTest(payload);
      setQuoteResult(res);
    } catch (err) {
      setQuoteResult({ status: "error", message: err.message || "No se pudo cotizar" });
    } finally {
      setQuoteBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="admin-shipping__error">
        <IconAlertCircle className="admin-shipping__error-icon" />
        <p>{loadError}</p>
        <button className="btn btn--primary" onClick={load} disabled={saving || loading}>
          Reintentar
        </button>
      </div>
    );
  }

  if (!settings || !form) {
    return (
      <div className="admin-shipping__loading">
        <span className="admin-shipping__spinner" />
        <p>Cargando configuración de envío…</p>
      </div>
    );
  }

  const branchLabel = isBranchAdmin
    ? (branch && branch.name) || branchId
    : branchId;
  const dirty = settings ? formIsDirty(form, settings) : false;
  const previewText = buildShippingText({
    auto_enabled: Number(form.auto_enabled),
    base_cost: Number(form.base_cost || 0),
    flat_blocks: Number(form.flat_blocks || 0),
    per_block: Number(form.per_block || 0),
  });

  return (
    <div className="admin-shipping">
      {/* Branch Selector / Header */}
      <header className="admin-shipping__header">
        {isBranchAdmin ? (
          <div className="admin-shipping__branch-badge">
            <IconMapPin className="admin-shipping__branch-icon" />
            <span>{branchLabel}</span>
          </div>
        ) : (
          <Dropdown
            value={branchId}
            onChange={handleBranchChange}
            options={BRANCH_LIST.map((b) => ({ value: b.id, label: b.name }))}
            placeholder="Seleccionar sucursal"
            ariaLabel="Sucursal"
          />
        )}
        {!isBranchAdmin && (
          <span className="admin-shipping__branch-hint">
            {branchId === "necochea" ? "Necochea" : "Tandil"}
          </span>
        )}
      </header>

      {/* Auto Calculation Toggle */}
      <section className="admin-shipping__section">
        <div className="admin-shipping__section-header">
          <div className="admin-shipping__section-title-group">
            <IconCalculator className="admin-shipping__section-icon" />
            <h3>Cálculo automático de envío</h3>
          </div>
        </div>
        <div className="admin-shipping__toggle-row">
          <Switch
            checked={form.auto_enabled === "1"}
            onChange={handleAutoChange}
            label="Activar cálculo automático"
            id="auto-shipping-toggle"
          />
        </div>
        <p className="admin-shipping__hint">
          Al apagarlo, los pedidos a domicilio entran con el envío "a confirmar" y el local
          fija el costo por WhatsApp.
        </p>
      </section>

      {/* Origin Address */}
      <section className="admin-shipping__section">
        <div className="admin-shipping__section-header">
          <div className="admin-shipping__section-title-group">
            <IconLocation className="admin-shipping__section-icon" />
            <h3>Origen del local</h3>
          </div>
        </div>
        <div className="admin-shipping__field">
          <label htmlFor="origin-address">Dirección del local</label>
          <div className="admin-shipping__input-wrapper">
            <IconLocation className="admin-shipping__input-icon" />
            <input
              id="origin-address"
              type="text"
              value={form.origin_address}
              onChange={(e) => setField("origin_address", e.target.value)}
              placeholder="Calle, número, ciudad"
              autoComplete="street-address"
            />
          </div>
          {fieldErrors.origin_address && (
            <div className="admin-shipping__field-error">{fieldErrors.origin_address}</div>
          )}
        </div>
      </section>

      {/* Shipping Rates */}
      <section className="admin-shipping__section">
        <div className="admin-shipping__section-header">
          <div className="admin-shipping__section-title-group">
            <IconCalculator className="admin-shipping__section-icon" />
            <h3>Tarifa de envío</h3>
          </div>
        </div>

        <div className="admin-shipping__rates-grid">
          <div className="admin-shipping__field">
            <label htmlFor="base-cost">Precio base</label>
            <div className="admin-shipping__input-wrapper admin-shipping__input-wrapper--currency">
              <span className="admin-shipping__currency-symbol">$</span>
              <input
                id="base-cost"
                inputMode="numeric"
                value={formatMiles(form.base_cost)}
                onChange={(e) => setField("base_cost", parseMiles(e.target.value))}
                onBlur={(e) => setField("base_cost", parseMiles(e.target.value))}
                placeholder="0"
                autoComplete="off"
              />
            </div>
            {fieldErrors.base_cost && <div className="admin-shipping__field-error">{fieldErrors.base_cost}</div>}
          </div>

          <div className="admin-shipping__field">
            <label htmlFor="flat-blocks">Cuadras incluidas</label>
            <div className="admin-shipping__input-wrapper admin-shipping__input-wrapper--suffix">
              <input
                id="flat-blocks"
                inputMode="numeric"
                value={formatMiles(form.flat_blocks)}
                onChange={(e) => setField("flat_blocks", parseMiles(e.target.value))}
                onBlur={(e) => setField("flat_blocks", parseMiles(e.target.value))}
                placeholder="0"
                autoComplete="off"
              />
              <span className="admin-shipping__input-suffix">cuadras</span>
            </div>
            {fieldErrors.flat_blocks && <div className="admin-shipping__field-error">{fieldErrors.flat_blocks}</div>}
          </div>

          <div className="admin-shipping__field">
            <label htmlFor="per-block">Precio por cuadra extra</label>
            <div className="admin-shipping__input-wrapper admin-shipping__input-wrapper--currency">
              <span className="admin-shipping__currency-symbol">$</span>
              <input
                id="per-block"
                inputMode="numeric"
                value={formatMiles(form.per_block)}
                onChange={(e) => setField("per_block", parseMiles(e.target.value))}
                onBlur={(e) => setField("per_block", parseMiles(e.target.value))}
                placeholder="0"
                autoComplete="off"
              />
            </div>
            {fieldErrors.per_block && <div className="admin-shipping__field-error">{fieldErrors.per_block}</div>}
          </div>

          <div className="admin-shipping__field">
            <label htmlFor="max-blocks">Máximo de cuadras de reparto</label>
            <div className="admin-shipping__input-wrapper admin-shipping__input-wrapper--suffix">
              <input
                id="max-blocks"
                inputMode="numeric"
                value={formatMiles(form.max_blocks)}
                onChange={(e) => setField("max_blocks", parseMiles(e.target.value))}
                onBlur={(e) => setField("max_blocks", parseMiles(e.target.value))}
                placeholder="0"
                autoComplete="off"
              />
              <span className="admin-shipping__input-suffix">cuadras (0 = sin tope)</span>
            </div>
            {fieldErrors.max_blocks && <div className="admin-shipping__field-error">{fieldErrors.max_blocks}</div>}
          </div>
        </div>
      </section>

      {/* Customer Preview */}
      <section className="admin-shipping__section admin-shipping__section--preview">
        <div className="admin-shipping__section-header">
          <div className="admin-shipping__section-title-group">
            <IconMapPin className="admin-shipping__section-icon" />
            <h3>Vista previa para el cliente</h3>
          </div>
        </div>
        <div className="admin-shipping__preview">
          <p className="admin-shipping__preview-text">{previewText}</p>
        </div>
      </section>

      {/* Quote Test */}
      <section className="admin-shipping__section">
        <div className="admin-shipping__section-header">
          <div className="admin-shipping__section-title-group">
            <IconCalculator className="admin-shipping__section-icon" />
            <h3>Probar cotización</h3>
          </div>
        </div>
        <div className="admin-shipping__quote-form">
          <div className="admin-shipping__field admin-shipping__field--inline">
            <label htmlFor="quote-address">Dirección a cotizar</label>
            <div className="admin-shipping__input-wrapper">
              <IconLocation className="admin-shipping__input-icon" />
              <input
                id="quote-address"
                type="text"
                value={quoteAddress}
                onChange={(e) => setQuoteAddress(e.target.value)}
                placeholder="Calle y número"
                autoComplete="street-address"
                onKeyDown={(e) => e.key === "Enter" && !quoteBusy && handleQuote()}
              />
            </div>
          </div>
          <button
            className="btn btn--primary"
            onClick={handleQuote}
            disabled={quoteBusy || !quoteAddress.trim()}
            style={{ height: 44, minWidth: 140 }}
          >
            {quoteBusy ? (
              <>
                <span className="admin-shipping__spinner-sm" /> Cotizando…
              </>
            ) : (
              "Cotizar"
            )}
          </button>
        </div>

        {quoteResult && (
          <div className={`admin-shipping__quote-result admin-shipping__quote-result--${quoteResult.status}`}>
            <div className="admin-shipping__quote-status">
              <span className="admin-shipping__quote-label">Estado:</span>
              <strong className={`admin-shipping__quote-value admin-shipping__quote-value--${quoteResult.status}`}>
                {quoteResult.status === "ubicada" ? "✓ Disponible" :
                 quoteResult.status === "fuera_de_zona" ? "✗ Fuera de zona" :
                 "⚠ No ubicada"}
              </strong>
            </div>
            {quoteResult.blocks != null && (
              <div className="admin-shipping__quote-detail">
                <IconMapPin className="admin-shipping__quote-detail-icon" />
                <span>Cuadras: <strong>{quoteResult.blocks}</strong></span>
              </div>
            )}
            {quoteResult.cost != null && (
              <div className="admin-shipping__quote-detail">
                <IconCalculator className="admin-shipping__quote-detail-icon" />
                <span>Costo: <strong>{formatPriceCompact(quoteResult.cost)}</strong></span>
              </div>
            )}
            {quoteResult.message && (
              <p className="admin-shipping__quote-message">{quoteResult.message}</p>
            )}
          </div>
        )}
      </section>

      {/* Save Actions */}
      <footer className="admin-shipping__footer">
        <div className="admin-shipping__dirty-indicator">
          {dirty ? (
            <>
              <IconAlertCircle className="admin-shipping__dirty-icon" />
              <span>Hay cambios sin guardar</span>
            </>
          ) : (
            <span>Sin cambios pendientes</span>
          )}
        </div>
        <button
          className="btn btn--primary btn--block"
          onClick={handleSave}
          disabled={saving || loading || !dirty}
        >
          {saving ? (
            <>
              <span className="admin-shipping__spinner-sm" /> Guardando…
            </>
          ) : saveMsg ? (
            <>
              <IconSave className="admin-shipping__save-icon" /> Guardado
            </>
          ) : dirty ? (
            <>
              <IconSave className="admin-shipping__save-icon" /> Guardar cambios
            </>
          ) : (
            "Sin cambios"
          )}
        </button>
        {saveErr && <div className="admin-shipping__save-error">{saveErr}</div>}
      </footer>

      {confirmAutoOff && (
        <ConfirmModal
          title={confirmAutoOff.title}
          message={confirmAutoOff.message}
          confirmText={confirmAutoOff.confirmText}
          onConfirm={confirmAutoOff.onConfirm}
          onClose={() => setConfirmAutoOff(null)}
        />
      )}
      {confirmBranchSwitch && (
        <ConfirmModal
          title="Cambios sin guardar"
          message="Hay cambios sin guardar. ¿Cambiar de sucursal y descartarlos?"
          confirmText="Descartar y cambiar"
          onConfirm={() => {
            setBranchId(confirmBranchSwitch.target);
          }}
          onClose={() => setConfirmBranchSwitch(null)}
        />
      )}
    </div>
  );
}