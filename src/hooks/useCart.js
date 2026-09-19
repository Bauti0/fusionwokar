import { useCallback, useEffect, useState } from "react";

// ============================================================
// useCart — carrito + historial de pedidos en localStorage
// El carrito se guarda por sucursal (clave fw.cart.<branchId>)
// ============================================================

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage lleno o no disponible */
  }
}

export default function useCart(branchId) {
  const cartKey = `fw.cart.${branchId}`;
  const historyKey = `fw.history.${branchId}`;

  const [items, setItems] = useState(() => load(cartKey, []));
  const [history, setHistory] = useState(() => load(historyKey, []));

  // Al cambiar de sucursal se vuelve a leer el carrito/historial de ESA
  // sucursal desde localStorage (el estado solo se inicializa en el mount).
  // Va ANTES de los efectos de guardado: si fuera al revés, el save de la
  // sucursal anterior pisaría la clave nueva con items ajenos.
  useEffect(() => {
    setItems(load(cartKey, []));
    setHistory(load(historyKey, []));
  }, [cartKey, historyKey]);

  useEffect(() => {
    save(cartKey, items);
  }, [cartKey, items]);

  useEffect(() => {
    save(historyKey, history);
  }, [historyKey, history]);

  // Agrega un producto (con extras ya resueltos) al carrito.
  // Si ya existe una línea idéntica, suma cantidad.
  const addItem = useCallback(
    (product, { extras = [], notes = "", qty = 1 } = {}) => {
      setItems((prev) => {
        const key = `${product.id}|${extras
          .map((e) => e.id)
          .sort()
          .join(",")}`;
        const existing = prev.find((it) => it.key === key);
        if (existing) {
          return prev.map((it) =>
            it.key === key ? { ...it, qty: it.qty + qty, notes: notes || it.notes } : it
          );
        }
        return [
          ...prev,
          {
            key,
            productId: product.id,
            name: product.name,
            unitPrice: product.price,
            extras,
            notes,
            qty,
          },
        ];
      });
    },
    []
  );

  const updateQty = useCallback((key, qty) => {
    setItems((prev) =>
      qty <= 0
        ? prev.filter((it) => it.key !== key)
        : prev.map((it) => (it.key === key ? { ...it, qty } : it))
    );
  }, []);

  const removeItem = useCallback((key) => {
    setItems((prev) => prev.filter((it) => it.key !== key));
  }, []);

  const clearCart = useCallback(() => {
    setItems([]);
  }, []);

  // Totales
  const subtotal = items.reduce((acc, it) => acc + it.unitPrice * it.qty, 0);
  const extrasTotal = items.reduce(
    (acc, it) => acc + (it.extras || []).reduce((a, e) => a + e.price, 0) * it.qty,
    0
  );
  const total = subtotal + extrasTotal;
  const count = items.reduce((acc, it) => acc + it.qty, 0);

  // Registra un pedido en el historial (al confirmar)
  const placeOrder = useCallback(
    (orderMeta) => {
      const record = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        date: new Date().toISOString(),
        items: items.map(({ key, ...rest }) => rest),
        total,
        ...orderMeta,
      };
      setHistory((prev) => [record, ...prev].slice(0, 30));
      return record;
    },
    [items, total]
  );

  // Repite un pedido anterior (vuelve a cargar sus items al carrito).
  // Suma sobre lo que ya haya en el carrito en vez de reemplazarlo:
  // las líneas idénticas se fusionan (misma key) y el resto se agrega.
  const repeatOrder = useCallback((order) => {
    setItems((prev) => {
      const byKey = new Map(prev.map((it) => [it.key, it]));
      for (const it of order.items || []) {
        const key = `${it.productId}|${(it.extras || [])
          .map((e) => e.id)
          .sort()
          .join(",")}`;
        const line = {
          key,
          productId: it.productId,
          name: it.name,
          unitPrice: it.unitPrice,
          extras: it.extras || [],
          notes: it.notes || "",
          qty: it.qty,
        };
        const existing = byKey.get(key);
        if (existing) byKey.set(key, { ...existing, qty: existing.qty + line.qty });
        else byKey.set(key, line);
      }
      return Array.from(byKey.values());
    });
  }, []);

  return {
    items,
    addItem,
    updateQty,
    removeItem,
    clearCart,
    subtotal,
    extrasTotal,
    total,
    count,
    history,
    placeOrder,
    repeatOrder,
  };
}