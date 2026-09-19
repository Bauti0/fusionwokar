import { useCallback, useEffect, useState } from "react";
import { adminCustomers } from "../api.js";
import { BRANCH_LIST } from "../data/branches.js";
import { formatPrice } from "../utils/format.js";
import Dropdown from "./ui/Dropdown.jsx";

// ============================================================
// AdminCustomers — clientes agrupados por teléfono
// Nombre, dirección más reciente, cantidad de pedidos, gasto
// total, y botón directo para escribirles por WhatsApp.
// ============================================================
export default function AdminCustomers() {
  const [branch, setBranch] = useState("");
  const [search, setSearch] = useState("");
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminCustomers({ branch, search });
      setCustomers(data.customers);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [branch, search]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  function waLink(phone) {
    const clean = String(phone || "").replace(/^0+/, "").replace(/[^\d+]/g, "");
    return `https://wa.me/${clean}`;
  }

  return (
    <section className="admin-customers">
      <div className="admin-products__toolbar">
        <div className="admin-products__controls">
          <Dropdown
            value={branch}
            onChange={setBranch}
            options={[{ value: "", label: "Todas las sucursales" }, ...BRANCH_LIST.map((b) => ({ value: b.id, label: b.name }))]}
          />
          <input
            type="search"
            className="admin-search"
            placeholder="🔎 Buscar por nombre o teléfono…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}

      {loading ? (
        <p className="hint">Cargando clientes…</p>
      ) : customers.length === 0 ? (
        <div className="admin-empty">No encontramos clientes con esos filtros.</div>
      ) : (
        <div className="customer-list">
          {customers.map((c) => (
            <div className="customer-card" key={c.phone}>
                <div className="customer-card__info">
                  <strong className="customer-card__name">{c.name}</strong>
                  <span className="customer-card__phone">{c.phone}</span>
                  {c.address && <span className="customer-card__address">📍 {c.address}</span>}
                  <div className="customer-card__meta">
                    <span className="badge">{c.ordersCount} {c.ordersCount === 1 ? "pedido" : "pedidos"}</span>
                    <span className="badge">{formatPrice(c.totalSpent)} gastado</span>
                    {c.ordersCount >= 3 && <span className="badge badge--vip">⭐ Recurrente</span>}
                  </div>
                  <div className="customer-card__submeta">
                    <span>🛍️ Última compra: {c.lastOrderAt ? new Date(c.lastOrderAt).toLocaleDateString("es-AR") : "—"}</span>
                    <span>🎟️ Ticket promedio: {c.ordersCount > 0 ? formatPrice(Math.round(c.totalSpent / c.ordersCount)) : "—"}</span>
                  </div>
                </div>
              <a className="btn btn--primary btn--sm" href={waLink(c.phone)} target="_blank" rel="noreferrer">
                💬 WhatsApp
              </a>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
