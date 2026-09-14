import { useState } from "react";
import { adminLogin } from "../api.js";

// ============================================================
// AdminLogin — acceso al panel (usuario/contraseña de .env)
// ============================================================

export default function AdminLogin({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await adminLogin(username.trim(), password);
      onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page admin-login">
      <div className="container admin-login__card">
        <img src="/assets/logo-wok.jpeg" alt="Fusión Wok" className="admin-login__logo" />
        <h2 className="page__title">Panel Fusión Wok</h2>
        <p className="page__sub">Ingresá para gestionar los pedidos.</p>
        <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12 }}>
          <div className="field">
            <label htmlFor="admin-user">Usuario</label>
            <input
              id="admin-user"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="admin-pass">Contraseña</label>
            <input
              id="admin-pass"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <div className="form-error">{error}</div>}
          <button className="btn btn--primary btn--block" disabled={busy}>
            {busy ? "Ingresando…" : "Ingresar"}
          </button>
        </form>
      </div>
    </div>
  );
}