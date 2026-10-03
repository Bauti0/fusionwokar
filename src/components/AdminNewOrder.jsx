import { useEffect, useMemo, useRef, useState } from "react";
import { getMenu, adminCreateManualOrder } from "../api.js";
import { BRANCH_LIST, phonePlaceholderFor } from "../data/branches.js";
import { formatPrice } from "../utils/format.js";
import Dropdown from "./ui/Dropdown.jsx";
import CustomizeModal from "./CustomizeModal.jsx";

const PAYMENT_OPTIONS = [
  { value: "efectivo", label: "💰 Efectivo" },
  { value: "mercadopago", label: "💳 Mercado Pago" },
  { value: "transferencia", label: "🏦 Transferencia" },
];

// ============================================================
// AdminNewOrder — carga manual de un pedido de mostrador o de un
// delivery (telefónico): Mostrador = retiro en el local, Delivery = envío.
// Reusa el mismo menú/precios/validación que el checkout online,
// así los pedidos cargados acá también entran en las estadísticas.
// ============================================================
export default function AdminNewOrder({ onBack, onCreated, initialBranch = "", fixedBranch = "", repeatOrder = null }) {
  const BRANCH_KEY = "fw.admin.lastNewOrderBranch";

  function rememberedBranch() {
    try {
      const v = localStorage.getItem(BRANCH_KEY) || "";
      return BRANCH_LIST.some((b) => b.id === v) ? v : "";
    } catch {
      return "";
    }
  }

  // fixedBranch: el admin de sucursal carga pedidos SIEMPRE en la
  // suya (el server lo fuerza igual); no hay selector.
  // Con "Rehacer", el superadmin arranca en la sucursal del pedido
  // original para que la precarga se arme contra el menú correcto;
  // después puede cambiarla desde el dropdown.
  const [branchId, setBranchId] = useState(() => {
    if (fixedBranch && BRANCH_LIST.some((b) => b.id === fixedBranch)) return fixedBranch;
    if (repeatOrder?.branch && BRANCH_LIST.some((b) => b.id === repeatOrder.branch)) return repeatOrder.branch;
    if (BRANCH_LIST.some((b) => b.id === initialBranch)) return initialBranch;
    return rememberedBranch() || BRANCH_LIST[0]?.id || "";
  });

  function changeBranch(v) {
    if (v === branchId) return;
    setBranchId(v);
    // El carrito se armó contra el menú de la sucursal anterior: al cambiar,
    // se vacía para no mezclar productos/precios de otra carta.
    if (cart.length > 0) {
      setCart([]);
      setCartCleared("Se vació el carrito porque cambiaste de sucursal.");
    }
    try {
      localStorage.setItem(BRANCH_KEY, v);
    } catch {}
  }
  const [menu, setMenu] = useState(null);
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState([]);
  const [customizing, setCustomizing] = useState(null);

  const [orderMode, setOrderMode] = useState("pickup"); // "pickup" (mostrador) | "delivery"
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("efectivo");
  const [notes, setNotes] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(null);
  // Avisos del "Rehacer" del panel: items del pedido original que ya no
  // están en el menú actual, y el vaciado del carrito al cambiar sucursal.
  const [prefillSkipped, setPrefillSkipped] = useState([]);
  const [cartCleared, setCartCleared] = useState("");
  const prefillDoneRef = useRef(false);

  useEffect(() => {
    getMenu(branchId).then(setMenu).catch(() => setMenu(null));
  }, [branchId]);

  // El menú viene por categorías > grupos > productos; lo aplanamos
  // para poder buscarlo como una sola lista.
  const flatProducts = useMemo(() => {
    if (!menu) return [];
    const list = [];
    for (const cat of menu.categories) {
      for (const group of cat.groups) {
        for (const p of group.products) {
          if (p.available === false) continue;
          list.push({ ...p, categoryName: cat.name });
        }
      }
    }
    return list;
  }, [menu]);

  const results = useMemo(() => {
    if (!search.trim()) return flatProducts.slice(0, 30);
    const q = search.trim().toLowerCase();
    return flatProducts.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 30);
  }, [flatProducts, search]);

  // "Rehacer" del panel: cuando el menú de la sucursal terminó de cargar,
  // vuelca los items del pedido original al carrito. Corre UNA sola vez
  // (guard por ref) y nunca pisa lo que el admin ya editó. Se matchea por
  // productId contra el menú ACTUAL: si un producto (o extra) ya no existe
  // o está deshabilitado, se omite y se avisa en pantalla. Los precios son
  // los vigentes del menú, no los del pedido original.
  useEffect(() => {
    if (!menu || !repeatOrder || prefillDoneRef.current) return;
    prefillDoneRef.current = true;
    const skipped = [];
    const byKey = new Map();
    for (const it of repeatOrder.items || []) {
      const prod = it?.productId ? flatProducts.find((p) => p.id === it.productId) : null;
      if (!prod) {
        skipped.push(it?.name || "un producto");
        continue;
      }
      const extras = [];
      for (const ex of it.extras || []) {
        const current = (prod.extras || []).find((e) => e.id === ex.id);
        if (current) extras.push(current);
        else skipped.push(`${ex.label || "un extra"} (${prod.name})`);
      }
      const key = `${prod.id}|${extras.map((e) => e.id).sort().join(",")}|${it.notes || ""}`;
      const qty = it.qty || 1;
      const existing = byKey.get(key);
      if (existing) existing.qty += qty;
      else
        byKey.set(key, {
          key,
          productId: prod.id,
          name: prod.name,
          unitPrice: prod.price,
          extras,
          notes: it.notes || "",
          qty,
        });
    }
    setCart(Array.from(byKey.values()));
    setOrderMode(repeatOrder.orderMode === "delivery" ? "delivery" : "pickup");
    setName(repeatOrder.customer?.name || "");
    setPhone(repeatOrder.customer?.phone || "");
    // El costo de envío NO se copia: el server lo recalcula con el flujo
    // existente a partir de esta dirección.
    setAddress(repeatOrder.orderMode === "delivery" ? repeatOrder.address || "" : "");
    setNotes(repeatOrder.notes || "");
    setPrefillSkipped(skipped);
  }, [menu, repeatOrder, flatProducts]);

  function addToCart(product, opts = { extras: [], notes: "", qty: 1 }) {
    setCartCleared("");
    setCart((prev) => {
      const qty = opts.qty || 1;
      // La nota forma parte de la clave para no fusionar líneas idénticas
      // con notas distintas (ni perder la cantidad elegida en el modal).
      const key = `${product.id}|${opts.extras.map((e) => e.id).sort().join(",")}|${opts.notes || ""}`;
      const existing = prev.find((it) => it.key === key);
      if (existing) {
        return prev.map((it) => (it.key === key ? { ...it, qty: it.qty + qty } : it));
      }
      return [
        ...prev,
        { key, productId: product.id, name: product.name, unitPrice: product.price, extras: opts.extras, notes: opts.notes || "", qty },
      ];
    });
  }

  function handleProductClick(product) {
    if (product.extras?.length) setCustomizing(product);
    else addToCart(product);
  }

  function updateQty(key, qty) {
    setCart((prev) => (qty <= 0 ? prev.filter((it) => it.key !== key) : prev.map((it) => (it.key === key ? { ...it, qty } : it))));
  }

  const total = cart.reduce((sum, it) => sum + (it.unitPrice + it.extras.reduce((a, e) => a + e.price, 0)) * it.qty, 0);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (cart.length === 0) return setError("Agregá al menos un producto.");
    if (!name.trim() || !phone.trim()) return setError("Completá nombre y teléfono del cliente.");
    if (orderMode === "delivery" && !address.trim()) return setError("Falta la dirección de entrega.");

    setBusy(true);
    try {
      const res = await adminCreateManualOrder({
        source: "counter",
        branch: branchId,
        customer: { name: name.trim(), phone: phone.trim() },
        orderMode,
        paymentMethod,
        address: orderMode === "delivery" ? address.trim() : "",
        items: cart.map((it) => ({ productId: it.productId, name: it.name, unitPrice: it.unitPrice, extras: it.extras, notes: it.notes, qty: it.qty })),
        notes: notes.trim(),
        couponCode: "",
        scheduledFor: "",
      });
      setSuccess(res.orderNumber);
      onCreated?.();
      setCart([]);
      setName("");
      setPhone("");
      setAddress("");
      setNotes("");
      setPrefillSkipped([]);
      setCartCleared("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-new-order">
      {onBack && (
        <button type="button" className="btn btn--ghost btn--sm" style={{ marginBottom: 14 }} onClick={onBack}>
          ← Volver a pedidos
        </button>
      )}
      {success && (
        <div className="admin-new-order__success">
          ✅ Pedido <strong>{success}</strong> cargado correctamente.
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSuccess(null)}>
            Cargar otro
          </button>
        </div>
      )}
      {prefillSkipped.length > 0 && (
        <div className="form-error">
          ⚠️ No se pudieron cargar del pedido original: {prefillSkipped.join(", ")}. Ya no
          están en el menú de esta sucursal.
        </div>
      )}
      {cartCleared && <div className="form-error">🧹 {cartCleared}</div>}

      <div className="admin-products__controls" style={{ marginBottom: 14 }}>
        {fixedBranch ? (
          <span className="badge badge--branch">{BRANCH_LIST.find((b) => b.id === branchId)?.name}</span>
        ) : (
          <Dropdown value={branchId} onChange={changeBranch} options={BRANCH_LIST.map((b) => ({ value: b.id, label: b.name }))} />
        )}
      </div>

      <div className="new-order__grid">
        <div className="new-order__picker">
          <h4>Productos</h4>
          <input
            type="search"
            className="admin-search"
            placeholder="Buscar producto…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="new-order__product-list">
            {results.map((p) => (
              <button type="button" key={p.id} className="new-order__product" onClick={() => handleProductClick(p)}>
                <span className="new-order__product-name">{p.name}</span>
                <span className="new-order__product-price">{formatPrice(p.price)}</span>
              </button>
            ))}
            {menu && results.length === 0 && <p className="hint">Sin resultados.</p>}
          </div>
        </div>

        <form className="new-order__form" onSubmit={handleSubmit}>
          <h4>Carrito ({cart.length})</h4>
          {cart.length === 0 ? (
            <p className="hint">Todavía no agregaste productos.</p>
          ) : (
            <div className="new-order__cart">
              {cart.map((it) => (
                <div className="new-order__cart-item" key={it.key}>
                  <div className="new-order__cart-info">
                    <span>{it.name}</span>
                    {it.extras.length > 0 && (
                      <span className="new-order__cart-extras">{it.extras.map((e) => e.label).join(", ")}</span>
                    )}
                  </div>
                  <div className="qty-stepper qty-stepper--sm">
                    <button type="button" onClick={() => updateQty(it.key, it.qty - 1)}>−</button>
                    <span>{it.qty}</span>
                    <button type="button" onClick={() => updateQty(it.key, it.qty + 1)}>+</button>
                  </div>
                </div>
              ))}
              <div className="new-order__total">
                <span>Total</span>
                <strong>{formatPrice(total)}</strong>
              </div>
            </div>
          )}

          <div className="segment">
            <button type="button" className={orderMode === "pickup" ? "is-active" : ""} onClick={() => setOrderMode("pickup")}>
              🧍 Mostrador
            </button>
            <button type="button" className={orderMode === "delivery" ? "is-active" : ""} onClick={() => setOrderMode("delivery")}>
              🛵 Delivery
            </button>
          </div>

          <div className="field">
            <label htmlFor="new-order-name">Nombre del cliente</label>
            <input id="new-order-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="new-order-phone">Celular</label>
            <input id="new-order-phone" type="tel" placeholder={phonePlaceholderFor(branchId)} value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          {orderMode === "delivery" && (
            <div className="field">
              <label htmlFor="new-order-address">Dirección</label>
              <input id="new-order-address" type="text" value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>Método de pago</label>
            <Dropdown value={paymentMethod} onChange={setPaymentMethod} options={PAYMENT_OPTIONS} />
          </div>
          <div className="field">
            <label htmlFor="new-order-notes">Notas (opcional)</label>
            <textarea id="new-order-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          {error && <div className="form-error">{error}</div>}

          <button className="btn btn--primary btn--block" disabled={busy}>
            {busy ? "Cargando…" : `Cargar pedido${cart.length ? ` · ${formatPrice(total)}` : ""}`}
          </button>
        </form>
      </div>

      {customizing && (
        <CustomizeModal
          product={customizing}
          onConfirm={(product, opts) => addToCart(product, opts)}
          onClose={() => setCustomizing(null)}
        />
      )}
    </section>
  );
}
