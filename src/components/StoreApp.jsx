import { lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BRANCHES, BRAND } from "../data/branches.js";
import { getMenu as getStaticMenu } from "../data/menus.js";
import useCart from "../hooks/useCart.js";
import { sendOrderByWhatsApp } from "../utils/whatsapp.js";
import { createOrder, getMenu as fetchMenu } from "../api.js";
import { track } from "../utils/tracking.js";
import Landing from "./Landing.jsx";
import Header from "./Header.jsx";
import Menu from "./Menu.jsx";
import MenuSkeleton from "./MenuSkeleton.jsx";
import CartBar from "./CartBar.jsx";
import Toast from "./Toast.jsx";
import { Link } from "react-router-dom";

// Vistas que solo se necesitan en ciertos pasos del flujo (carrito, pago…):
// se cargan bajo demanda para no inflar el bundle inicial de la tienda.
const CartView = lazy(() => import("./CartView.jsx"));
const Checkout = lazy(() => import("./Checkout.jsx"));
const OrderHistory = lazy(() => import("./OrderHistory.jsx"));
const PaymentModal = lazy(() => import("./PaymentModal.jsx"));
const PaymentResult = lazy(() => import("./PaymentResult.jsx"));

const VIEWS = {
  landing: "landing",
  menu: "menu",
  cart: "cart",
  checkout: "checkout",
  history: "history",
  success: "success",
  payment: "payment",
  paymentResult: "paymentResult",
};

// ============================================================
// FUSIÓN WOK — Aplicación principal (tienda)
// - Estado global: sucursal, vista, cliente, modalidad
// - Carrito e historial por sucursal (useCart, localStorage)
// - Checkout: WhatsApp (efectivo/transferencia) o Mercado Pago
//   (crea el pedido en el backend y paga con Wallet Brick)
// ============================================================
export default function StoreApp() {
  const [branchId, setBranchId] = useState(() => localStorage.getItem("fw.lastBranch") || "");
  const [view, setView] = useState(() =>
    localStorage.getItem("fw.lastBranch") ? VIEWS.menu : VIEWS.landing
  );
  const [customer, setCustomer] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("fw.customer") || "null");
    } catch {
      return null;
    }
  });
  const [orderMode, setOrderMode] = useState("delivery");
  const [paymentFlow, setPaymentFlow] = useState(null); // datos del pago MP
  const [lastOrder, setLastOrder] = useState(null); // pedido confirmado (para éxito/tracking)
  const [paymentMeta, setPaymentMeta] = useState(null); // datos locales del pedido MP (dirección, modalidad)
  const [toast, setToast] = useState(null); // feedback al agregar al carrito
  const toastTimer = useRef(null);

  const branch = BRANCHES[branchId];
  // El menú viene de la API (BD, editable desde el panel). Si falla, se usa
  // el estático como respaldo para que la tienda nunca quede vacía.
  const [menu, setMenu] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!branchId) {
      setMenu(null);
      return;
    }
    setMenu(null);
    fetchMenu(branchId)
      .then((m) => alive && setMenu(m))
      .catch(() => alive && setMenu(getStaticMenu(branchId)));
    return () => {
      alive = false;
    };
  }, [branchId]);

  const cart = useCart(branchId || "none");

  useEffect(() => {
    if (branchId) localStorage.setItem("fw.lastBranch", branchId);
  }, [branchId]);

  useEffect(() => {
    if (customer) localStorage.setItem("fw.customer", JSON.stringify(customer));
  }, [customer]);

  const goHome = useCallback(() => {
    if (branchId) setView(VIEWS.menu);
    else setView(VIEWS.landing);
  }, [branchId]);

  const handleLandingStart = useCallback(({ branchId: bid, customer: cust }) => {
    setBranchId(bid);
    // Mergea en vez de reemplazar: si ya había dirección/observaciones
    // guardadas de un pedido anterior, no se pierden al re-loguearse.
    if (cust) setCustomer((prev) => ({ ...prev, ...cust }));
    setOrderMode("delivery");
    setView(VIEWS.menu);
  }, []);

  const handleChangeBranch = useCallback(() => {
    setView(VIEWS.landing);
  }, []);

  const showToast = useCallback((message, type = "success") => {
    clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), message, type });
    toastTimer.current = setTimeout(() => setToast(null), type === "error" ? 3200 : 1900);
  }, []);

  const handleAdd = useCallback(
    (product, opts) => {
      cart.addItem(product, opts);
      showToast(`${product.name} agregado al carrito`);
    },
    // addItem es estable (useCallback en useCart): así onAdd no cambia de
    // referencia en cada render y el memo de <Menu> no re-renderiza el
    // catálogo completo al tocar el carrito.
    [cart.addItem, showToast]
  );

  // Confirmación del checkout
  // - Mercado Pago → se crea el pedido en el backend (pendiente de pago)
  //   y se abre el Wallet Brick para pagar sin salir del flujo.
  // - Efectivo/Transferencia → se crea el pedido (confirmado) y se abre
  //   WhatsApp con el detalle, como antes.
  const handleConfirmCheckout = useCallback(
    async ({ customer: cust, orderMode: mode, paymentMethod, address, deliveryNotes, scheduledFor, couponCode, shipping }) => {
      // Guardamos los datos del cliente; si es delivery conservamos también
      // la dirección y las observaciones para autocompletar el próximo pedido
      setCustomer((prev) =>
        mode === "delivery" && address
          ? { ...prev, ...cust, address, notes: deliveryNotes || "" }
          : { ...prev, ...cust }
      );

      const payload = {
        branch: branch.id,
        customer: { name: cust.name, phone: cust.phone },
        orderMode: mode,
        paymentMethod,
        address: mode === "delivery" ? address : "",
        items: cart.items.map((it) => ({
          key: it.key,
          productId: it.productId,
          name: it.name,
          unitPrice: it.unitPrice,
          extras: it.extras,
          notes: it.notes,
          qty: it.qty,
        })),
        total: cart.total,
        notes: mode === "delivery" ? deliveryNotes || "" : "",
        scheduledFor: scheduledFor || "",
        couponCode: couponCode || "",
        shipping: {
          cost: Math.round(Number(shipping?.cost) || 0),
          blocks: Math.round(Number(shipping?.blocks) || 0),
        },
      };

      if (paymentMethod === "mercadopago") {
        try {
          const res = await createOrder(payload);
          setLastOrder(res);
          setPaymentFlow(res);
          setPaymentMeta({
            orderId: res.orderId,
            orderMode: mode,
            paymentMethod,
            address: mode === "delivery" ? address : "",
          });
          setView(VIEWS.payment);
        } catch (err) {
          showToast("No se pudo iniciar el pago. Volvé a intentarlo.", "error");
          setView(VIEWS.checkout);
        }
        return;
      }

      // Efectivo / Transferencia → pedido confirmado + WhatsApp
      const record = cart.placeOrder({ orderMode: mode, paymentMethod, address });
      let orderNumber = null;
      let serverDiscount = 0;
      let serverCoupon = "";
      let serverScheduled = scheduledFor || "";
      try {
        const res = await createOrder(payload);
        orderNumber = res.orderNumber;
        serverDiscount = res.discount || 0;
        serverCoupon = res.couponCode || "";
        serverScheduled = res.scheduledFor || serverScheduled;
      } catch {
        /* el pedido igual se arma por WhatsApp */
      }
      sendOrderByWhatsApp({
        branch,
        order: record,
        customer: cust,
        orderMode: mode,
        paymentMethod,
        address,
        deliveryNotes,
        coupon: serverCoupon,
        discount: serverDiscount,
        scheduledFor: serverScheduled,
        shipping,
      });
      cart.clearCart();
      setLastOrder({ orderNumber, paymentStatus: "approved", status: "received" });
      setView(VIEWS.success);
    },
    [branch, cart, showToast]
  );

  // Resultado del pago MP
  const handlePaymentResult = useCallback(
    (order) => {
      const meta = paymentMeta || {};
      const fullOrder = { ...order, orderMode: order.orderMode || meta.orderMode, paymentMethod: order.paymentMethod || meta.paymentMethod, address: order.address || meta.address };
      // Solo se registra en el historial si el pago se aprobó
      if (fullOrder?.paymentStatus === "approved") {
        cart.placeOrder({
          orderMode: fullOrder.orderMode,
          paymentMethod: fullOrder.paymentMethod,
          address: fullOrder.address,
        });
      }
      cart.clearCart();
      setLastOrder(fullOrder);
      setView(VIEWS.paymentResult);
    },
    [cart, paymentMeta]
  );

  const handleRepeat = useCallback(
    (order) => {
      cart.repeatOrder(order);
      setView(VIEWS.cart);
    },
    [cart]
  );

  // Sin sucursal elegida → portada. Si se pidió cambiar de sucursal
  // (chip del header) → portada conservando la sucursal preseleccionada.
  // Con sucursal pero menú cargando → skeleton.
  if (!branch || view === VIEWS.landing) {
    return (
      <Landing
        onStart={handleLandingStart}
        initialBranch={branch ? branchId : ""}
        customer={customer}
      />
    );
  }
  if (!menu) {
    return <MenuSkeleton />;
  }

  return (
    <div className="app">
      <Header
        branch={branch}
        cartCount={cart.count}
        onCart={() => setView(VIEWS.cart)}
        onHistory={() => setView(VIEWS.history)}
        onHome={goHome}
        onChangeBranch={handleChangeBranch}
      />

      {view === VIEWS.menu && (
        <>
          <Menu menu={menu} branch={branch} orderMode={orderMode} onAdd={handleAdd} />
          <CartBar count={cart.count} total={cart.total} onView={() => setView(VIEWS.cart)} />
        </>
      )}

      {view === VIEWS.cart && (
        <CartView
          cart={cart}
          branch={branch}
          onBack={() => setView(VIEWS.menu)}
          onCheckout={() => setView(VIEWS.checkout)}
        />
      )}

      {view === VIEWS.checkout && (
        <Checkout
          branch={branch}
          cart={cart}
          customer={customer}
          orderMode={orderMode}
          setOrderMode={setOrderMode}
          onConfirm={handleConfirmCheckout}
        />
      )}

      {view === VIEWS.history && (
        <OrderHistory
          history={cart.history}
          branch={branch}
          onRepeat={handleRepeat}
          onBack={() => setView(VIEWS.menu)}
          onMenu={() => setView(VIEWS.menu)}
        />
      )}

      {view === VIEWS.success && (
        <div className="page">
          <div className="container">
            <div className="success">
              <div className="success__icon">✓</div>
              <h1>Pedido enviado</h1>
              <p>
                Abrimos WhatsApp con tu pedido para <strong>{branch.name}</strong>. Solo tenés que
                presionar enviar para confirmarlo.
              </p>
              {lastOrder?.orderNumber && (
                <div className="payment-result__meta">
                  <div>
                    <span>Pedido</span>
                    <strong>{lastOrder.orderNumber}</strong>
                  </div>
                  <div>
                    <span>Estado</span>
                    <strong>Recibido</strong>
                  </div>
                </div>
              )}
              <div style={{ display: "grid", gap: 10 }}>
                {lastOrder?.orderNumber && (
                  <Link className="btn btn--primary btn--block" to={`/track/${lastOrder.orderNumber}`}>
                    📍 Seguir mi pedido
                  </Link>
                )}
                <button className="btn btn--primary btn--block" onClick={() => setView(VIEWS.menu)}>
                  Volver al menú
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {view === VIEWS.payment && paymentFlow && (
        <PaymentModal
          orderId={paymentFlow.orderId}
          orderNumber={paymentFlow.orderNumber}
          demo={paymentFlow.demo}
          publicKey={paymentFlow.publicKey}
          preferenceId={paymentFlow.preferenceId}
          onResult={handlePaymentResult}
          onCancel={() => setView(VIEWS.checkout)}
        />
      )}

      {view === VIEWS.paymentResult && lastOrder && (
        <PaymentResult
          order={lastOrder}
          branch={branch}
          onHome={goHome}
        />
      )}

      <Toast toast={toast} />
    </div>
  );
}