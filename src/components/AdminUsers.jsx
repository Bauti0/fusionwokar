import { useCallback, useEffect, useState } from "react";
import {
  adminUsers,
  adminCreateUser,
  adminSetUserPassword,
  adminSetUserActive,
  adminDeleteUser,
  adminLogoutAll,
} from "../api.js";
import { BRANCHES } from "../data/branches.js";
import useDialogA11y from "../hooks/useDialogA11y.js";
import Dropdown from "./ui/Dropdown.jsx";
import ConfirmModal from "./ui/ConfirmModal.jsx";
import { IconPlus } from "./ui/icons.jsx";

// ============================================================
// AdminUsers — cuentas de admin por sucursal (solo superadmin)
// - Crear cuentas por sucursal (la contraseña se hashea en el server)
// - Cambiar contraseña (cierra las sesiones abiertas de la cuenta)
// - Activar/desactivar (desactivar corta el acceso al instante)
// - Borrar (definitivo: cierra sus sesiones y deja el username libre)
// - Cerrar todas las sesiones del panel (el botón 🔒 vive acá)
//
// Reutiliza las clases de las listas de clientes y de los modales
// existentes: no hay CSS nuevo que mantener.
// ============================================================

const EMPTY = { username: "", password: "", branch: "" };
const MIN_PASSWORD_LENGTH = 8; // mismo mínimo que valida el server

export default function AdminUsers({ onLogout }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [passModal, setPassModal] = useState(null); // cuenta cuyo password se cambia
  const [passValue, setPassValue] = useState("");
  const [passError, setPassError] = useState("");
  const [confirmState, setConfirmState] = useState(null);
  const createDialogRef = useDialogA11y({ onClose: () => setCreating(false), isActive: creating });
  const passDialogRef = useDialogA11y({
    onClose: () => setPassModal(null),
    isActive: !!passModal,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminUsers();
      setUsers(data.users);
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
    setBusy(true);
    try {
      await adminCreateUser({ ...form, username: form.username.trim() });
      setForm(EMPTY);
      setCreating(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    if (passValue.length < MIN_PASSWORD_LENGTH) {
      setPassError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
      return;
    }
    setBusy(true);
    setPassError("");
    try {
      await adminSetUserPassword(passModal.id, passValue);
      setPassModal(null);
      setPassValue("");
    } catch (err) {
      setPassError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function handleToggle(user) {
    if (!user.active) {
      // Reactivar es inofensivo: va directo.
      adminSetUserActive(user.id, true)
        .then(load)
        .catch((err) => setError(err.message));
      return;
    }
    setConfirmState({
      title: "Desactivar cuenta",
      message: `¿Desactivar "${user.username}"? Sus sesiones abiertas se cierran al instante y no va a poder iniciar sesión hasta reactivarla.`,
      confirmText: "Desactivar",
      onConfirm: async () => {
        await adminSetUserActive(user.id, false);
        await load();
      },
    });
  }

  // Borrar es definitivo (a diferencia de desactivar): se pide
  // confirmación explícita antes de ejecutarlo.
  function handleDelete(user) {
    setConfirmState({
      title: "Borrar cuenta",
      message: `¿Borrar la cuenta "${user.username}"? No se puede deshacer.`,
      confirmText: "Borrar",
      onConfirm: async () => {
        await adminDeleteUser(user.id);
        await load();
      },
    });
  }

  // El botón 🔒 se movió del header a esta sección: solo el superadmin
  // ve la sección, y un admin de sucursal no puede tirar las sesiones
  // del dueño ni de la otra sucursal.
  async function handleLogoutAll() {
    if (!window.confirm("¿Cerrar TODAS las sesiones del panel (incluida esta)?")) return;
    try {
      await adminLogoutAll();
    } catch {
      /* aunque falle, se cierra la sesión local */
    }
    onLogout();
  }

  return (
    <section className="admin-users">
      <div className="admin-products__toolbar">
        <h3>🔐 Cuentas</h3>
        <button
          className="btn btn--primary btn--sm"
          onClick={() => {
            setCreating(true);
            setError("");
          }}
        >
          <IconPlus style={{ width: 13, height: 13 }} /> Crear cuenta
        </button>
      </div>
      <p className="hint">
        Las cuentas de admin por sucursal solo ven y editan SU sucursal. Desactivar una
        cuenta le cierra las sesiones abiertas al instante.
      </p>

      {error && <div className="form-error">{error}</div>}

      {loading && users.length === 0 ? (
        <p className="hint">Cargando cuentas…</p>
      ) : users.length === 0 ? (
        <div className="admin-empty">
          Todavía no hay cuentas de sucursal. Creá una para delegar la gestión de un local.
        </div>
      ) : (
        <div className="customer-list">
          {users.map((u) => (
            <div className={`customer-card ${u.active ? "" : "is-hidden"}`} key={u.id}>
              <div className="customer-card__info">
                <strong className="customer-card__name">{u.username}</strong>
                <span className="customer-card__phone">{BRANCHES[u.branch]?.name || u.branch}</span>
                <div className="customer-card__meta">
                  <span className="badge">{u.active ? "✅ Activa" : "⛔ Desactivada"}</span>
                </div>
                <div className="customer-card__submeta">
                  <span>Creada: {new Date(u.createdAt).toLocaleDateString("es-AR")}</span>
                </div>
              </div>
              <div
                className="customer-card__actions"
                style={{ display: "grid", gap: 8, minWidth: 150 }}
              >
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    setPassModal(u);
                    setPassValue("");
                    setPassError("");
                  }}
                >
                  🔑 Cambiar contraseña
                </button>
                {u.active ? (
                  <button className="btn btn--danger-outline btn--sm" onClick={() => handleToggle(u)}>
                    ⛔ Desactivar
                  </button>
                ) : (
                  <button className="btn btn--primary btn--sm" onClick={() => handleToggle(u)}>
                    ✅ Reactivar
                  </button>
                )}
                {/* Acción destructiva y definitiva: separada del resto
                    (gap extra) y con el estilo outline rojo. */}
                <button
                  className="btn btn--danger-outline btn--sm"
                  style={{ marginTop: 10 }}
                  onClick={() => handleDelete(u)}
                >
                  🗑️ Borrar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <button className="btn btn--ghost btn--block" onClick={handleLogoutAll}>
          🔒 Cerrar todas las sesiones
        </button>
        <p className="hint">
          Cierra TODAS las sesiones del panel (máquinas, pestañas y tokens robados),
          incluida esta. Útil si compartiste tu contraseña y la cambiaste.
        </p>
      </div>

      {creating && (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="user-modal-title"
            ref={createDialogRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal__head">
              <h3 id="user-modal-title">Nueva cuenta de sucursal</h3>
              <button className="modal__close" onClick={() => setCreating(false)} aria-label="Cerrar">
                ✕
              </button>
            </div>
            <form className="modal__body" onSubmit={handleCreate}>
              <div className="field">
                <label htmlFor="user-username">Usuario</label>
                <input
                  id="user-username"
                  type="text"
                  required
                  maxLength={60}
                  autoComplete="off"
                  placeholder="Ej: tandil1"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="user-password">Contraseña</label>
                <input
                  id="user-password"
                  type="password"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  placeholder={`Mínimo ${MIN_PASSWORD_LENGTH} caracteres`}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Sucursal</label>
                <Dropdown
                  value={form.branch}
                  onChange={(v) => setForm({ ...form, branch: v })}
                  options={Object.values(BRANCHES).map((b) => ({ value: b.id, label: b.name }))}
                  placeholder="Elegí la sucursal"
                />
              </div>

              {error && <div className="form-error">{error}</div>}

              {/* Gap vertical en el contenedor para separar los botones
                  apilados (mobile primero), sin márgenes sueltos. */}
              <div className="modal__footer" style={{ display: "grid", gap: 10 }}>
                <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
                  {busy ? "Creando…" : "Crear cuenta"}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--block"
                  onClick={() => setCreating(false)}
                  disabled={busy}
                >
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {passModal && (
        <div className="modal-backdrop" onClick={() => setPassModal(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pass-modal-title"
            ref={passDialogRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal__head">
              <h3 id="pass-modal-title">Cambiar contraseña de {passModal.username}</h3>
              <button
                type="button"
                className="modal__close"
                onClick={() => setPassModal(null)}
                aria-label="Cerrar"
              >
                ✕
              </button>
            </div>
            <form className="modal__body" onSubmit={handleChangePassword}>
              <div className="field">
                <label htmlFor="user-new-password">Nueva contraseña</label>
                <input
                  id="user-new-password"
                  type="password"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  placeholder={`Mínimo ${MIN_PASSWORD_LENGTH} caracteres`}
                  value={passValue}
                  onChange={(e) => {
                    setPassValue(e.target.value);
                    if (passError) setPassError("");
                  }}
                  autoFocus
                />
                <span className="hint">Sus sesiones abiertas se cierran al cambiarla.</span>
              </div>

              {passError && <div className="form-error">{passError}</div>}

              <div className="modal__footer">
                <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
                  {busy ? "Guardando…" : "Guardar contraseña"}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--block"
                  onClick={() => setPassModal(null)}
                  disabled={busy}
                >
                  Cancelar
                </button>
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
