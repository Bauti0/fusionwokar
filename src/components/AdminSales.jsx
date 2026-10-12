import { Fragment, useCallback, useEffect, useState } from "react";
import { adminSales, adminCashRegister, adminOpenCashRegister, adminCloseCashRegister, adminCorrectCashRegister, adminCashCorrections, adminDeleteCashRegister, adminDeletedCashRegisters } from "../api.js";
import { BRANCH_LIST, BRANCHES } from "../data/branches.js";
import { formatPrice } from "../utils/format.js";
import { periodRange, dayShort, dayLabel, dateShort, dateTimeShort, isToday } from "../utils/dates.js";
import Dropdown from "./ui/Dropdown.jsx";
import DateRangePicker from "./ui/DateRangePicker.jsx";
import ConfirmModal from "./ui/ConfirmModal.jsx";
import TicketPrint from "./TicketPrint.jsx";
import useDialogA11y from "../hooks/useDialogA11y.js";

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

      <CashRegister branch={branch} me={me} />
    </section>
  );
}

// ============================================================
// Arqueo de caja (por sucursal)
// ============================================================
function CashRegister({ branch, me }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [openingAmount, setOpeningAmount] = useState("");
  const [closingCounted, setClosingCounted] = useState("");
  const [closingNotes, setClosingNotes] = useState("");
  const [closing, setClosing] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  // Impresión del ticket de cierre: `print` guarda SOLO el id del arqueo; el
  // cierre se resuelve siempre desde data.history (estado fresco, se refresca
  // cada 20s), nunca de una copia guardada.
  const [print, setPrint] = useState(null);
  // Id del arqueo que acabamos de cerrar, para el botón de imprimir del
  // resultado. El endpoint de cierre NO devuelve el id: es el id de la caja
  // que se captura antes de cerrar.
  const [closedId, setClosedId] = useState(null);
  // Cierre que se está corrigiendo (fila del historial) y correcciones
  // ya cargadas por arqueo (SOLO las pide el superadmin: el branch_admin
  // ni siquiera ve el disparador). {loading?, error?, groups?}
  const [corrigiendo, setCorrigiendo] = useState(null);
  const [correcciones, setCorrecciones] = useState({});
  const [corrOpen, setCorrOpen] = useState(null); // arqueo con historial desplegado
  // Anulación (soft delete): la caja que se está anulando (abierta o cierre
  // del historial) + motivo. El ConfirmModal (variant="danger") maneja busy
  // interno: el botón queda deshabilitado mientras guarda y los errores del
  // backend se muestran adentro sin cerrar.
  const [anulando, setAnulando] = useState(null);
  const [motivoAnular, setMotivoAnular] = useState("");
  // Cajas anuladas: SOLO las pide el superadmin (el branch_admin ni hace la
  // llamada, el server le daría 403).
  const [anuladas, setAnuladas] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await adminCashRegister(branch);
      setData(d);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, [branch]);

  // Historial de anulaciones (global, no por sucursal de la vista).
  const loadAnuladas = useCallback(async () => {
    if (me?.role !== "superadmin") return;
    try {
      const d = await adminDeletedCashRegisters();
      setAnuladas(d.deleted);
    } catch {
      // Sin romper la pantalla: la sección muestra vacío.
      setAnuladas([]);
    }
  }, [me?.role]);

  useEffect(() => {
    setResult(null);
    setClosedId(null);
    setPrint(null);
    setClosing(false);
    setCorrigiendo(null);
    setCorrecciones({});
    setCorrOpen(null);
    setAnulando(null);
    setMotivoAnular("");
    load();
    loadAnuladas();
    const t = setInterval(() => {
      load();
      loadAnuladas();
    }, 20000);
    return () => clearInterval(t);
  }, [load, loadAnuladas]);

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
      // El id del arqueo se captura ANTES de cerrar: la respuesta del endpoint
      // no lo trae y después del close la caja ya no está en data.open.
      const arqueoId = data.open.id;
      const res = await adminCloseCashRegister(arqueoId, counted, closingNotes);
      setResult(res);
      setClosedId(arqueoId);
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

  // Historial de correcciones de UN cierre: solo el superadmin tiene el
  // disparador, así que el branch_admin nunca hace esta llamada (403).
  async function toggleCorrecciones(id) {
    if (corrOpen === id) { setCorrOpen(null); return; }
    setCorrOpen(id);
    if (correcciones[id]) return;
    setCorrecciones((m) => ({ ...m, [id]: { loading: true } }));
    try {
      const d = await adminCashCorrections(id);
      setCorrecciones((m) => ({ ...m, [id]: { groups: groupCorrections(d.corrections) } }));
    } catch (err) {
      setCorrecciones((m) => ({ ...m, [id]: { error: err.message } }));
    }
  }

  if (!data) return null;

  // Confirma la anulación: valida el motivo y llama al DELETE. Se tira con
  // Error para que el ConfirmModal muestre el mensaje adentro sin cerrarse.
  async function confirmarAnulacion() {
    const reason = motivoAnular.trim();
    if (reason.length < 5) {
      throw new Error("Ingresá el motivo de la anulación (mínimo 5 caracteres)");
    }
    await adminDeleteCashRegister(anulando.id, reason);
    setAnulando(null);
    setMotivoAnular("");
    // Refresco con los datos del servidor: la anulada desaparece de la
    // caja abierta/historial y aparece en "Cajas anuladas" (superadmin).
    await load();
    await loadAnuladas();
  }

  // El server NO manda el efectivo cobrado como campo: manda `expectedNow`,
  // que ya es apertura + cobrado (server/admin-queries.js). La diferencia es
  // exactamente ese monto, sin recalcular nada. Si no hay caja abierta el
  // cálculo no se hace.
  const cobrado = Number.isFinite(data.open?.expectedNow)
    ? data.open.expectedNow - data.open.openingAmount
    : 0;
  // Cierre elegido para imprimir: SIEMPRE desde data.history (los datos que
  // están en pantalla ahora), nunca una copia guardada al hacer click.
  const cierreAImprimir = print ? data.history.find((h) => h.id === print.cashId) : null;

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
            <>
              <button className="btn btn--ghost btn--block" onClick={() => setClosing(true)}>
                Cerrar caja
              </button>
              <button
                className="btn btn--ghost btn--block"
                onClick={() => {
                  setAnulando(data.open);
                  setMotivoAnular("");
                }}
              >
                Anular caja
              </button>
            </>
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
          {closedId && (
            <button className="btn btn--ghost btn--block" onClick={() => setPrint({ cashId: closedId })}>
              🖨️ Imprimir cierre
            </button>
          )}
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
              <Fragment key={h.id}>
                <div className="cash-register__hrow">
                  <span className="cash-register__hdate">{dateShort(h.closedAt)}</span>
                  <span className="cash-register__hmoney">
                    <span>Apertura <b>{formatPrice(h.openingAmount)}</b></span>
                    <span>Contado <b>{formatPrice(h.closingCounted)}</b></span>
                  </span>
                  <span className={`badge ${badge}`}>
                    {dif === 0 ? "Exacta" : `${dif > 0 ? "+" : "−"}${formatPrice(Math.abs(dif))}`}
                  </span>
                  {h.correctedAt && (
                    <span className="badge badge--pay-pending" title={`Última corrección: ${dateTimeShort(h.correctedAt)}`}>Corregido</span>
                  )}
                  <div className="cash-register__hactions">
                    <button
                      className="btn btn--ghost btn--sm cash-register__hprint"
                      aria-label={`Imprimir cierre del ${dateShort(h.closedAt)}`}
                      onClick={() => setPrint({ cashId: h.id })}
                    >
                      🖨️
                    </button>
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => setCorrigiendo(h)}
                    >
                      Corregir montos
                    </button>
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => {
                        setAnulando(h);
                        setMotivoAnular("");
                      }}
                    >
                      Anular
                    </button>
                  </div>
                </div>
                {/* Historial de correcciones: SOLO superadmin (el branch_admin
                    no ve el botón y el server le daría 403 de todos modos). */}
                {h.correctedAt && me?.role === "superadmin" && (
                  <div className="cash-register__corr">
                    <button className="btn btn--ghost btn--sm" onClick={() => toggleCorrecciones(h.id)}>
                      {corrOpen === h.id ? "Ocultar correcciones" : "Ver correcciones"}
                    </button>
                    {corrOpen === h.id && (
                      <div className="cash-register__corr-list">
                        {(() => {
                          const c = correcciones[h.id];
                          if (!c || c.loading) return <p className="hint">Cargando…</p>;
                          if (c.error) return <p className="form-error">{c.error}</p>;
                          if (!c.groups.length) return <p className="hint">Sin correcciones registradas.</p>;
                          return c.groups.map((g) => (
                            <div className="cash-register__corr-item" key={g.key}>
                              <p className="cash-register__corr-meta">
                                {dateTimeShort(g.fecha)} · {g.autor} · Motivo: {g.motivo}
                              </p>
                              {g.lineas.map((l) => (
                                <p className="cash-register__corr-line" key={l.id}>
                                  {cashCorrLine(l)}
                                </p>
                              ))}
                            </div>
                          ));
                        })()}
                      </div>
                    )}
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      )}

      {/* Ticket del cierre: la ventana se abre adentro del click (sin await
          de por medio) y el desglose llega después, dentro de TicketPrint. */}
      {cierreAImprimir && (
        <TicketPrint
          variant="cierre"
          cash={cierreAImprimir}
          onClose={() => setPrint(null)}
        />
      )}

      {corrigiendo && (
        <CashCorrectionModal
          cierre={corrigiendo}
          onClose={() => setCorrigiendo(null)}
          onSaved={async () => {
            setCorrigiendo(null);
            // La vista previa del modal era solo eso: acá manda el servidor.
            // load() refresca el historial con los valores que quedaron.
            await load();
          }}
        />
      )}

      {/* Anulación (soft delete): tipo peligro, resumen de la caja + motivo
          obligatorio. El botón queda deshabilitado mientras guarda (anti
          doble toque) y los errores del backend no cierran el modal. */}
      {anulando && (
        <ConfirmModal
          variant="danger"
          title="Anular caja"
          message={
            <>
              Vas a anular la caja de <b>{BRANCHES[anulando.branch]?.name || anulando.branch}</b>{" "}
              {anulando.closedAt
                ? `cerrada el ${dateTimeShort(anulando.closedAt)}`
                : `abierta desde ${dateTimeShort(anulando.openedAt)}`}
              : fondo {formatPrice(anulando.openingAmount)}
              {anulando.closedAt && `, contado ${formatPrice(anulando.closingCounted)}`}. La caja no se
              borra: queda registrada como anulada.
            </>
          }
          confirmText="Anular caja"
          onConfirm={confirmarAnulacion}
          onClose={() => setAnulando(null)}
        >
          <div className="field">
            <label htmlFor="anular-motivo">Motivo (obligatorio)</label>
            <textarea
              id="anular-motivo"
              rows={2}
              value={motivoAnular}
              onChange={(e) => setMotivoAnular(e.target.value)}
              placeholder="Ej: caja abierta en la sucursal equivocada"
            />
          </div>
        </ConfirmModal>
      )}

      {/* Cajas anuladas: SOLO superadmin (el branch_admin ni pide la lista). */}
      {me?.role === "superadmin" && anuladas && anuladas.length > 0 && (
        <div className="cash-register__history">
          <h5>Cajas anuladas</h5>
          {anuladas.map((a) => {
            // La foto de la caja al anularla viaja en new_value (JSON).
            let foto = null;
            try {
              foto = JSON.parse(a.new_value);
            } catch {
              foto = null;
            }
            return (
              <div className="cash-register__corr" key={a.id}>
                <div className="cash-register__hrow">
                  <span className="cash-register__hdate">
                    {dateTimeShort(a.created_at)}
                  </span>
                  <span className="cash-register__hmoney">
                    <span>{BRANCHES[foto?.branch]?.name || foto?.branch || ""}</span>
                  </span>
                </div>
                <p className="cash-register__corr-meta">
                  {a.admin_username || "superadmin"}
                  {foto && (
                    <>
                      {" · "}
                      {foto.estado === "cerrada" ? "Cerrada" : "Abierta"}
                      {" · Fondo "}
                      <b>{formatPrice(foto.openingAmount)}</b>
                      {foto.estado === "cerrada" && (
                        <>
                          {" · Contado "}
                          <b>{formatPrice(foto.closingCounted)}</b>
                          {" · Esperado "}
                          <b>{formatPrice(foto.expectedAmount)}</b>
                        </>
                      )}
                    </>
                  )}
                </p>
                <p className="cash-register__corr-line">Motivo: {a.reason}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Corrección de un cierre (modal). Los 4 campos editables son los inputs
// humanos de la caja; expectedAmount y difference los recalcula siempre
// el servidor (acá solo se previsualizan con la misma fórmula). El
// efectivo cobrado NO se deriva de los pedidos: lo carga el admin a mano
// (un pedido pudo cambiar de medio de pago DESPUÉS del cierre). Como
// referencia de solo lectura se muestra el efectivo que hoy da el
// reporte de ventas del turno (si la llamada falla, no se muestra).
// ============================================================
const MONTO_MAX = 100000000;

function parseMontoModal(v) {
  const t = String(v).trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0 || n > MONTO_MAX) return null;
  return n;
}

function CashCorrectionModal({ cierre, onClose, onSaved }) {
  const [apertura, setApertura] = useState(String(cierre.openingAmount));
  const [cobrado, setCobrado] = useState(String(cierre.expectedAmount - cierre.openingAmount));
  const [contado, setContado] = useState(String(cierre.closingCounted));
  const [notas, setNotas] = useState(cierre.notes || "");
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Efectivo del reporte actual del turno (referencia read-only).
  const [efectivoReporte, setEfectivoReporte] = useState(null);
  const dialogRef = useDialogA11y({ onClose, isActive: true });

  useEffect(() => {
    let alive = true;
    adminSales({ branch: cierre.branch, from: cierre.openedAt, to: cierre.closedAt })
      .then((s) => {
        if (!alive) return;
        const m = s.byMethod?.find((x) => x.method === "efectivo");
        setEfectivoReporte(m ? m.total : 0);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [cierre]);

  // Vista previa: solo si los 3 montos son válidos. La diferencia nueva
  // definitiva es la que devuelve el servidor al guardar.
  const nApertura = parseMontoModal(apertura);
  const nCobrado = parseMontoModal(cobrado);
  const nContado = parseMontoModal(contado);
  const montosOk = nApertura !== null && nCobrado !== null && nContado !== null;
  const nuevoEsperado = montosOk ? nApertura + nCobrado : null;
  const nuevaDiferencia = montosOk ? nContado - nuevoEsperado : null;

  async function handleSave(e) {
    e.preventDefault();
    if (busy) return; // anti doble toque
    if (!montosOk) {
      setError("Los montos deben ser enteros entre 0 y 100.000.000");
      return;
    }
    if (motivo.trim().length < 5) {
      setError("Ingresá el motivo de la corrección (mínimo 5 caracteres)");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await adminCorrectCashRegister(cierre.id, {
        openingAmount: nApertura,
        efectivoCobrado: nCobrado,
        closingCounted: nContado,
        notes: notas,
        reason: motivo.trim(),
      });
      await onSaved();
    } catch (err) {
      // El modal NO se cierra: el error del server (409 incluido) se muestra
      // arriba y los datos del formulario quedan intactos.
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cash-corr-title"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h3 id="cash-corr-title">Corregir cierre del {dateShort(cierre.closedAt)}</h3>
          <button className="modal__close" onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        <form className="modal__body" onSubmit={handleSave}>
          {error && <div className="form-error">{error}</div>}
          <div className="field">
            <label htmlFor="corr-apertura">Fondo inicial</label>
            <input
              id="corr-apertura"
              type="number"
              min="0"
              max={MONTO_MAX}
              step="1"
              value={apertura}
              onChange={(e) => setApertura(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="corr-cobrado">Efectivo cobrado</label>
            <input
              id="corr-cobrado"
              type="number"
              min="0"
              max={MONTO_MAX}
              step="1"
              value={cobrado}
              onChange={(e) => setCobrado(e.target.value)}
            />
            {efectivoReporte !== null && (
              <p className="hint">Efectivo según el reporte de ventas actual: {formatPrice(efectivoReporte)}</p>
            )}
          </div>
          <div className="field">
            <label htmlFor="corr-contado">Monto contado en caja</label>
            <input
              id="corr-contado"
              type="number"
              min="0"
              max={MONTO_MAX}
              step="1"
              value={contado}
              onChange={(e) => setContado(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="corr-notas">Notas</label>
            <textarea id="corr-notas" rows={2} value={notas} onChange={(e) => setNotas(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="corr-motivo">Motivo de la corrección</label>
            <input
              id="corr-motivo"
              type="text"
              placeholder="Ej: el fondo real era otro"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            />
          </div>
          {montosOk && (
            <p className="hint">
              Esperado: {formatPrice(nuevoEsperado)} · Nueva diferencia:{" "}
              {nuevaDiferencia === 0 ? "caja exacta" : `${nuevaDiferencia > 0 ? "+" : "−"}${formatPrice(Math.abs(nuevaDiferencia))}`}
            </p>
          )}
          <div className="modal__footer">
            <button type="button" className="btn btn--ghost btn--block" onClick={onClose} disabled={busy}>
              Cancelar
            </button>
            <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
              {busy ? "Guardando…" : "Guardar corrección"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// Historial de correcciones — vista del panel, SOLO superadmin.
// El server devuelve UNA fila por campo (una corrección que toca fondo +
// contado son 4 filas: los 2 campos + los 2 derivados, que van rotulados
// "recalculado"). Se agrupan por (admin, fecha, motivo), igual que el
// historial de pedidos (formatAuditEdits).
// ============================================================
const CASH_FIELD_LABEL = {
  openingAmount: "Fondo inicial",
  efectivoCobrado: "Efectivo cobrado",
  closingCounted: "Efectivo contado",
  notes: "Notas",
  expectedAmount: "Esperado (recalculado)",
  difference: "Diferencia (recalculada)",
};

function cashCorrValue(field, value) {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "notes") return String(value);
  return formatPrice(Number(value));
}

function cashCorrLine(r) {
  return `${CASH_FIELD_LABEL[r.field] || r.field}: ${cashCorrValue(r.field, r.old_value)} → ${cashCorrValue(r.field, r.new_value)}`;
}

function groupCorrections(rows) {
  const groups = [];
  for (const r of rows || []) {
    const key = `${r.admin_username}|${r.created_at}|${r.reason}`;
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, autor: r.admin_username || "superadmin", fecha: r.created_at, motivo: r.reason, lineas: [] };
      groups.push(g);
    }
    g.lineas.push(r);
  }
  return groups;
}
