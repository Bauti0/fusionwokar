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
  adminShippingOriginLocate,
} from "../api.js";
import { BRANCHES, BRANCH_LIST } from "../data/branches.js";
import { formatPriceCompact } from "../utils/format.js";
import { buildShippingText } from "../utils/shippingText.js";
import Dropdown from "./ui/Dropdown.jsx";
import ConfirmModal from "./ui/ConfirmModal.jsx";
import Switch from "./ui/Switch.jsx";
import { IconLocation } from "./ui/icons.jsx";

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
  const [locateBusy, setLocateBusy] = useState(false);
  const [locateResult, setLocateResult] = useState(null);
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
        origin_lat: form.origin_lat ? Number(form.origin_lat) : null,
        origin_lng: form.origin_lng ? Number(form.origin_lng) : null,
        base_cost: Number(form.base_cost || 0),
        flat_blocks: Number(form.flat_blocks || 0),
        per_block: Number(form.per_block || 0),
        max_blocks: Number(form.max_blocks || 0),
        auto_enabled: Number(form.auto_enabled || 1),
      };
      const res = await adminUpdateShippingSettings(payload);
      setSettings((prev) => ({ ...prev, ...payload, updated_at: new Date().toISOString(), updated_by: (me?.username || "superadmin") }));
      setForm(settingsToForm(res));
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
        origin_lat: form.origin_lat ? Number(form.origin_lat) : null,
        origin_lng: form.origin_lng ? Number(form.origin_lng) : null,
        base_cost: Number(form.base_cost || 0),
        flat_blocks: Number(form.flat_blocks || 0),
        per_block: Number(form.per_block || 0),
        max_blocks: Number(form.max_blocks || 0),
        auto_enabled: Number(form.auto_enabled || 1),
      };
      const res = await adminShippingSettingsTest(payload);
      setQuoteResult(res);
    } catch (err) {
      setQuoteResult({ status: "error", message: err.message || "No se pudo cotizar" });
    } finally {
      setQuoteBusy(false);
    }
  }

  async function handleLocate() {
    const addr = form.origin_address.trim();
    if (!addr) return;
    setLocateBusy(true);
    setLocateResult(null);
    try {
      const res = await adminShippingOriginLocate({ origin_address: addr, branch: branchId });
      setLocateResult(res);
      setField("origin_lat", String(res.lat));
      setField("origin_lng", String(res.lng));
    } catch (err) {
      setFieldErrors((prev) => ({ ...prev, origin_address: err.message || "No se pudo geocodificar" }));
    } finally {
      setLocateBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="admin-panel-card__body">
        <div className="form-error">{loadError}</div>
        <button
          className="btn btn--primary"
          onClick={load}
          disabled={saving || loading}
        >
          Reintentar
        </button>
      </div>
    );
  }

  if (!settings || !form) {
    return (
      <div className="admin-panel-card__body">
        <p className="hint">Cargando configuración de envío…</p>
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
    <div className="admin-panel-card__body">
      <div className="admin-products__controls" style={{ marginBottom: 14, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        {isBranchAdmin ? (
          <span className="badge badge--branch">{branchLabel}</span>
        ) : (
          <Dropdown
            value={branchId}
            onChange={handleBranchChange}
            options={BRANCH_LIST.map((b) => ({ value: b.id, label: b.name }))}
            placeholder="Sucursal"
          />
        )}
        <span style={{ fontSize: 12, color: "var(--color-text-soft)" }}>
          {branchId === "necochea" ? "Necochea" : "Tandil"}
        </span>
      </div>

      {loadError && <div className="form-error">{loadError}</div>}

      <section style={{ marginBottom: 16 }}>
        <Switch
          checked={form.auto_enabled === "1"}
          onChange={handleAutoChange}
          label="Cálculo automático de envío"
        />
        <p className="hint" style={{ marginTop: 6 }}>
          Al apagarlo, los pedidos a domicilio entran con el envío "a confirmar" y el local
          fija el costo por WhatsApp.
        </p>
      </section>

      <section style={{ marginBottom: 16 }}>
        <h4 style={{ margin: "0 0 8px 0", fontSize: 14 }}>Origen del local</h4>
        <div className="field" style={{ marginBottom: 10 }}>
          <label>Dirección</label>
          <input
            value={form.origin_address}
            onChange={(e) => setField("origin_address", e.target.value)}
            placeholder="Dirección del local"
          />
          {fieldErrors.origin_address && <div className="form-error">{fieldErrors.origin_address}</div>}
        </div>

        <details className="coord-toggle" style={{ marginBottom: 8 }}>
          <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--color-text-soft)" }}>
            Mostrar coordenadas y geocodificación
          </summary>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginTop: 8 }}>
            <div className="field" style={{ minWidth: 150, marginBottom: 0 }}>
              <label>Latitud</label>
              <input
                inputMode="numeric"
                value={form.origin_lat}
                onChange={(e) => setField("origin_lat", e.target.value)}
                placeholder="-38.5670"
              />
              {fieldErrors.origin_lat && <div className="form-error">{fieldErrors.origin_lat}</div>}
            </div>
            <div className="field" style={{ minWidth: 150, marginBottom: 0 }}>
              <label>Longitud</label>
              <input
                inputMode="numeric"
                value={form.origin_lng}
                onChange={(e) => setField("origin_lng", e.target.value)}
                placeholder="-58.7293"
              />
              {fieldErrors.origin_lng && <div className="form-error">{fieldErrors.origin_lng}</div>}
            </div>
            <button
              className="btn btn--primary"
              onClick={handleLocate}
              disabled={locateBusy || !form.origin_address.trim()}
              style={{ height: 44 }}
            >
              {locateBusy ? "Ubicando…" : <><IconLocation width="16" height="16" style={{ marginRight: 6 }} /> Ubicar</>}
            </button>
            {locateResult && (
              <a
                href={locateResult.mapsUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn--ghost btn--sm"
                style={{ marginLeft: 8, height: 44 }}
              >
                Ver en Google Maps
              </a>
            )}
          </div>
        </details>
      </section>

      <section style={{ marginBottom: 16 }}>
        <h4 style={{ margin: "0 0 8px 0", fontSize: 14 }}>Tarifa de envío</h4>
        <div className="field" style={{ marginBottom: 10, minWidth: 170 }}>
          <label>Precio base ($)</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>$</span>
            <input
              inputMode="numeric"
              value={formatMiles(form.base_cost)}
              onChange={(e) => setField("base_cost", parseMiles(e.target.value))}
              onBlur={(e) => setField("base_cost", parseMiles(e.target.value))}
              style={{ flex: 1 }}
            />
          </div>
          {fieldErrors.base_cost && <div className="form-error">{fieldErrors.base_cost}</div>}
        </div>
        <div className="field" style={{ marginBottom: 10, minWidth: 170 }}>
          <label>Cuadras incluidas</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              inputMode="numeric"
              value={formatMiles(form.flat_blocks)}
              onChange={(e) => setField("flat_blocks", parseMiles(e.target.value))}
              onBlur={(e) => setField("flat_blocks", parseMiles(e.target.value))}
              style={{ flex: 1 }}
            />
            <span>cuadras</span>
          </div>
          {fieldErrors.flat_blocks && <div className="form-error">{fieldErrors.flat_blocks}</div>}
        </div>
        <div className="field" style={{ marginBottom: 10, minWidth: 170 }}>
          <label>Precio por cuadra extra ($)</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>$</span>
            <input
              inputMode="numeric"
              value={formatMiles(form.per_block)}
              onChange={(e) => setField("per_block", parseMiles(e.target.value))}
              onBlur={(e) => setField("per_block", parseMiles(e.target.value))}
              style={{ flex: 1 }}
            />
          </div>
          {fieldErrors.per_block && <div className="form-error">{fieldErrors.per_block}</div>}
        </div>
        <div className="field" style={{ minWidth: 170 }}>
          <label>Máximo de cuadras de reparto</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              inputMode="numeric"
              value={formatMiles(form.max_blocks)}
              onChange={(e) => setField("max_blocks", parseMiles(e.target.value))}
              onBlur={(e) => setField("max_blocks", parseMiles(e.target.value))}
              style={{ flex: 1 }}
            />
            <span>cuadras (0 = sin tope)</span>
          </div>
          {fieldErrors.max_blocks && <div className="form-error">{fieldErrors.max_blocks}</div>}
        </div>
      </section>

      <section style={{ marginBottom: 16, border: "1px dashed var(--color-border)", borderRadius: "var(--radius-sm)", padding: 12, background: "var(--color-surface)" }}>
        <h4 style={{ margin: "0 0 8px 0", fontSize: 14 }}>Vista previa para la clienta</h4>
        <p className="hint" style={{ margin: 0 }}>{previewText}</p>
      </section>

      <section style={{ marginBottom: 16 }}>
        <h4 style={{ margin: "0 0 8px 0", fontSize: 14 }}>Probar cotización</h4>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 200, marginBottom: 0 }}>
            <label>Dirección a cotizar</label>
            <input
              value={quoteAddress}
              onChange={(e) => setQuoteAddress(e.target.value)}
              placeholder="Calle y número"
            />
          </div>
          <button
            className="btn btn--primary"
            onClick={handleQuote}
            disabled={quoteBusy || !quoteAddress.trim()}
            style={{ height: 44 }}
          >
            {quoteBusy ? "Cotizando…" : "Cotizar"}
          </button>
        </div>
        {quoteResult && (
          <div className="field" style={{ marginTop: 8 }}>
            <span>Estado: <strong>{quoteResult.status}</strong></span>
            {quoteResult.blocks != null && <span> · Cuadras: {quoteResult.blocks}</span>}
            {quoteResult.cost != null && <span> · Costo: {formatPriceCompact(quoteResult.cost)}</span>}
            {quoteResult.message && <p className="hint" style={{ marginTop: 4 }}>{quoteResult.message}</p>}
          </div>
        )}
      </section>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginTop: 8 }}>
        <p className="hint" style={{ margin: 0 }}>
          {dirty ? "Hay cambios sin guardar" : "Sin cambios sin guardar"}
        </p>
        <button
          className="btn btn--primary"
          onClick={handleSave}
          disabled={saving || loading || !dirty}
        >
          {saving ? "Guardando…" : saveMsg ? "Guardado" : dirty ? "Guardar cambios" : "Sin cambios"}
        </button>
        {saveErr && <span className="form-error" style={{ marginLeft: 10 }}>{saveErr}</span>}
      </div>

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
