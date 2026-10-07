import { useCallback, useEffect, useState } from "react";
// Alias obligatorio: adentro del hook, `cartKey` es la clave de localStorage
// del carrito y taparía a esta función si se importara con el mismo nombre.
import { cartKey as makeCartKey } from "../utils/format.js";

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
  // Si ya existe una línea idéntica, suma cantidad. La clave incluye la nota
  // (normalizada con trim): dos líneas iguales con notas distintas quedan
  // separadas y ninguna pisa la nota de la otra.
  const addItem = useCallback(
    (product, { extras = [], notes = "", qty = 1 } = {}) => {
      setItems((prev) => {
        const key = makeCartKey({ productId: product.id, extras, notes });
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
            // La foto viaja en la línea para poder mostrar miniatura en el
            // carrito y en el resumen del checkout (antes no se guardaba).
            image: product.image || "",
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

  // Snapshot del pedido (items + total + meta) SIN tocar el historial. El flujo
  // efectivo/transferencia lo arma ANTES de llamar al server y recién lo
  // registra con registerOrder cuando el server confirmó el pedido: si el
  // server lo rechaza (400 "Producto no disponible") o no responde, el
  // historial del cliente no queda con un pedido que el local nunca recibió.
  const buildOrderRecord = useCallback(
    (orderMeta) => ({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: new Date().toISOString(),
      items: items.map(({ key, ...rest }) => rest),
      total,
      ...orderMeta,
    }),
    [items, total]
  );

  // Registra en el historial un snapshot ya armado (buildOrderRecord).
  const registerOrder = useCallback((record) => {
    setHistory((prev) => [record, ...prev].slice(0, 30));
  }, []);

  // Guarda un pedido del flujo Mercado Pago (ya tiene orderNumber del servidor)
  const placeOrderWithNumber = useCallback(
    (orderMeta, orderNumber) => {
      const record = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        date: new Date().toISOString(),
        items: items.map(({ key, ...rest }) => rest),
        total,
        orderNumber,
        ...orderMeta,
      };
      setHistory((prev) => [record, ...prev].slice(0, 30));
      return record;
    },
    [items, total]
  );

  // Repite un pedido anterior (vuelve a cargar sus items al carrito).
  // Suma sobre lo que ya haya en el carrito en vez de reemplazarlo:
  // las líneas idénticas se fusionan (misma key, que incluye la nota) y el
  // resto se agrega. La key se recalcula con cartKey porque la del carrito
  // viejo no viaja en el historial ni en los pedidos del server.
  const repeatOrder = useCallback((order) => {
    setItems((prev) => {
      const byKey = new Map(prev.map((it) => [it.key, it]));
      for (const it of order.items || []) {
        const key = makeCartKey(it);
        const line = {
          key,
          productId: it.productId,
          name: it.name,
          image: it.image || "",
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
    buildOrderRecord,
    registerOrder,
    placeOrderWithNumber,
    repeatOrder,
  };
}