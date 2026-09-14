import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getOrdersByPhone } from "../api.js";
import { BRANCHES } from "../data/branches.js";
import { statusEmoji, statusLabel } from "../constants.js";
import { formatPrice } from "../utils/format.js";
import TrackHeader from "./TrackHeader.jsx";

// ============================================================
// TrackHome — "Seguir mi pedido"
// 1) Ingresar el número de pedido (FW-XXXXX) para verlo
// 2) "Mis pedidos": recupera los pedidos por teléfono
//    (sin exponer pedidos de otras personas)
// ============================================================

export default function TrackHome() {
  const navigate = useNavigate();
  const [num, setNum] = useState("");
  const [phone, setPhone] = useState(() => {
    try {
      const c = JSON.parse(localStorage.getItem("fw.customer") || "null");
      return c?.phone || "";
    } catch {
      return "";
    }
  });
  const [myOrders, setMyOrders] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [searchedPhone, setSearchedPhone] = useState("");

  function handleTrack(e) {
    e.preventDefault();
    const clean = num.trim().toUpperCase();
    if (!clean) return;
    navigate(`/track/${clean}`);
  }

  async function handleMyOrders(e) {
    e.preventDefault();
    const cleanPhone = phone.trim();
    if (!cleanPhone) {
      setError("Ingresá tu teléfono para ver tus pedidos.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = await getOrdersByPhone(cleanPhone);
      setMyOrders(data.orders);
      setSearchedPhone(cleanPhone);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <TrackHeader />
      <div className="page">
      <div className="container">
        <div className="track-head">
          <h2 className="page__title">📍 Seguir mi pedido</h2>
          <p className="page__sub">Ingresá tu número de pedido o buscá por teléfono.</p>
        </div>

        <div className="track-card">
          <h3>Mis pedidos</h3>
          <p className="hint" style={{ textAlign: "left", margin: "0 0 10px" }}>
            Buscá todos tus pedidos anteriores por tu teléfono.
          </p>
          <form onSubmit={handleMyOrders} style={{ display: "grid", gap: 10 }}>
            <div className="field">
              <input
                type="tel"
                inputMode="tel"
                placeholder="Tu celular (ej: 2262 555555)"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            {error && <div className="form-error">{error}</div>}
            <button className="btn btn--dark btn--block" type="submit" disabled={busy}>
              {busy ? "Buscando…" : "Ver mis pedidos"}
            </button>
          </form>

          {myOrders && (
            <div className="my-orders" style={{ marginTop: 14 }}>
              {myOrders.length === 0 ? (
                <p className="hint">
                  No encontramos pedidos para el teléfono {searchedPhone}.
                </p>
              ) : (
                <>
                  <p className="hint">
                    {myOrders.length} pedido{myOrders.length > 1 ? "s" : ""} para {searchedPhone}
                  </p>
                  {myOrders.map((o) => {
                    const b = BRANCHES[o.branch];
                    return (
                      <Link key={o.id} className="my-order" to={`/track/${o.orderNumber}`}>
                        <div className="my-order__head">
                          <strong>{o.orderNumber}</strong>
                          <span className="badge">
                            {statusEmoji(o.status)} {statusLabel(o.status)}
                          </span>
                        </div>
                        <div className="my-order__meta">
                          <span>{b?.name}</span>
                          <span>{new Date(o.createdAt).toLocaleDateString("es-AR")}</span>
                          <strong>{formatPrice(o.total)}</strong>
                        </div>
                      </Link>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </div>

        <Link className="btn btn--ghost btn--block" to="/">
          Volver a la tienda
        </Link>
      </div>
    </div>
  </div>
  );
}