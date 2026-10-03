import { lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { BRANCHES, BRAND } from "../data/branches.js";
import { getMenu as getStaticMenu } from "../data/menus.js";
import useCart from "../hooks/useCart.js";
import { buildWhatsAppOrderUrl } from "../utils/whatsapp.js";
import { createOrder, getMenu as fetchMenu, getOrderByNumber, retryPaymentLink } from "../api.js";
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
const MyOrders = lazy(() => import("./MyOrders.jsx"));
const PaymentModal = lazy(() => import("./PaymentModal.jsx"));
const PaymentResult = lazy(() => import("./PaymentResult.jsx"));

const VIEWS = {
  landing: "landing",
  menu: "menu",
  checkout: "checkout",
  myOrders: "myOrders",
  success: "success",
  payment: "payment",
  paymentResult: "paymentResult",
};

// Traduce el fallo de POST /api/orders a lo que ve el cliente.
//
// Antes se decidía con `err.contactWhatsApp ? "No pudimos calcular el envío…"`
// sobre un flag que el backend encendía para DOS fallos distintos: no se pudo
// cotizar el envío y no se pudo generar el link de pago. Con un token de
// Mercado Pago inválido, el cliente veía "No pudimos calcular el envío" ante un
// fallo de pago. Ahora cada `code` del servidor tiene su mensaje.
//
// `retryable` viene del server: con credenciales inválidas reintentar no sirve
// nunca (solo WhatsApp), con una caída de MP sí.
function describeOrderError(err) {
  switch (err.code) {
    case "shipping_unavailable":
      return {
        message: err.message,
        canRetry: true,
        note: "Para cobrar con Mercado Pago necesitamos saber el costo de envío.",
      };
    case "mp_unauthorized":
      return {
        message:
          "El pago con Mercado Pago no está disponible en este momento. Tu pedido quedó " +
          "registrado: escribinos por WhatsApp con el número y lo coordinamos.",
        canRetry: false,
        note: "No hace falta que reintentes: el problema es de nuestro lado, no tuyo.",
      };
    case "mp_unavailable":
    case "mp_link_missing":
      return {
        message:
          "No pudimos generar el link de pago de Mercado Pago. Podés reintentar en un " +
          "momento o escribirnos por WhatsApp con el número de tu pedido.",
        canRetry: true,
      };
    default:
      return { message: err.message || "No se pudo iniciar el pago.", canRetry: true };
  }
}

// ============================================================
// FUSIÓN WOK — Aplicación principal (tienda)
// - Estado global: sucursal, vista, cliente, modalidad
// - Carrito e historial por sucursal (useCart, localStorage)
// - Checkout: WhatsApp (efectivo/transferencia) o Mercado Pago
//   (crea el pedido en el backend y redirige al checkout de MP)
// ============================================================
export default function StoreApp() {
  const location = useLocation();
  const navigate = useNavigate();
  const [branchId, setBranchId] = useState(() => localStorage.getItem("fw.lastBranch") || "");
  const [view, setView] = useState(() => {
    // Si venimos de /track con state, abrir my-orders una sola vez
    if (location.state?.view === "my-orders") {
      // Limpiar el state para que una recarga no reabra Mis pedidos
      navigate(location.pathname, { replace: true, state: null });
      return VIEWS.myOrders;
    }
    return localStorage.getItem("fw.lastBranch") ? VIEWS.menu : VIEWS.landing;
  });
  const [customer, setCustomer] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("fw.customer") || "null");
    } catch {
      return null;
    }
  });
  const [orderMode, setOrderMode] = useState("delivery");
  const [cartOpen, setCartOpen] = useState(false); // carrito como bottom-sheet (drawer)
  const [paymentFlow, setPaymentFlow] = useState(null); // datos del pago MP
  const [lastOrder, setLastOrder] = useState(null); // pedido confirmado (para éxito/tracking)
  const [paymentMeta, setPaymentMeta] = useState(null); // datos locales del pedido MP (dirección, modalidad)
  // Error del último intento de pedido, mostrado EN el checkout y no en un
  // toast que se borra a los 3 s: el cliente tiene que poder leerlo, volver a
  ///leerlo y decidir si reintenta el pago o pasa por WhatsApp.
  const [checkoutError, setCheckoutError] = useState(null);
  const [retryingLink, setRetryingLink] = useState(false);
  // BUG-05: link de WhatsApp del último pedido efectivo/transferencia cuando
  // el navegador bloqueó la ventana que se abre en el click (window.open
  // devuelve null). La pantalla de éxito lo muestra como botón "Abrir
  // WhatsApp": un <a target=_blank> tocado por el usuario nunca se bloquea.
  const [whatsappFallbackUrl, setWhatsappFallbackUrl] = useState(null);
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

  // "Rehacer" desde el panel admin: bridge efímero por localStorage.
  // El carrito ya quedó escrito en fw.cart.<branch>; acá solo se aplica
  // el modo de entrega y se abre el drawer con lo cargado.
  useEffect(() => {
    let meta = null;
    try {
      meta = JSON.parse(localStorage.getItem("fw.afterRepeat") || "null");
    } catch {
      meta = null;
    }
    if (!meta) return;
    localStorage.removeItem("fw.afterRepeat");
    if (meta.orderMode === "pickup" || meta.orderMode === "delivery") setOrderMode(meta.orderMode);
    if (meta.openCart) setCartOpen(true);
  }, []);

  const goHome = useCallback(() => {
    setCartOpen(false);
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

  // Reintento del link de pago: el pedido ya existe (el server lo guardó antes
  // de llamar a MP), así que solo hay que volver a pedirle a MP el checkout.
  // Evita que el cliente reenvíe el formulario y se cree un pedido duplicado.
  const handleRetryPaymentLink = useCallback(async () => {
    const orderId = checkoutError?.orderId;
    if (!orderId || retryingLink) return;
    setRetryingLink(true);
    try {
      const res = await retryPaymentLink(orderId);
      setCheckoutError(null);
      setLastOrder(res);
      setPaymentFlow(res);
      setPaymentMeta({
        orderId: res.orderId,
        orderMode: checkoutError.orderMode,
        paymentMethod: "mercadopago",
        address: checkoutError.address || "",
      });
      setView(VIEWS.payment);
    } catch (err) {
      // El server responde con el mismo contrato de error: si el problema es
      // de credenciales, el reintento deja de ofrecerse.
      const described = describeOrderError(err);
      setCheckoutError({
        ...described,
        orderId: err.orderId ?? orderId,
        orderNumber: err.orderNumber || checkoutError.orderNumber,
        orderMode: checkoutError.orderMode,
        address: checkoutError.address,
      });
      showToast(described.message, "error");
    } finally {
      setRetryingLink(false);
    }
  }, [checkoutError, retryingLink, showToast]);

  // Confirmación del checkout
  // - Mercado Pago → se crea el pedido en el backend (pendiente de pago)
  //   y se abre el Wallet Brick para pagar sin salir del flujo.
  // - Efectivo/Transferencia → se crea el pedido (confirmado) y se abre
  //   WhatsApp con el detalle, como antes.
  const handleConfirmCheckout = useCallback(
    async ({ customer: cust, orderMode: mode, paymentMethod, address, deliveryNotes, scheduledFor, couponCode, couponDiscount, shipping }) => {
      // Guardamos los datos del cliente; si es delivery conservamos también
      // la dirección y las observaciones para autocompletar el próximo pedido.
      // El DOCUMENTO no se guarda: es dato sensible y solo viaja al pago de MP.
      const customerToSave = { ...cust };
      delete customerToSave.identification;
      setCustomer((prev) =>
        mode === "delivery" && address
          ? { ...prev, ...customerToSave, address, notes: deliveryNotes || "" }
          : { ...prev, ...customerToSave }
      );

      const payload = {
        branch: branch.id,
        // firstName/lastName van separados para el payer de MP; identification
        // es dato sensible que solo viaja a MP con el pago, nunca se guarda.
        customer: {
          name: cust.name,
          phone: cust.phone,
          email: cust.email,
          firstName: cust.firstName,
          lastName: cust.lastName,
          identification: cust.identification,
        },
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
        setCheckoutError(null);
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
          // El error se muestra EN el checkout (no en un toast que se borra):
          // si el pedido llegó a guardarse, se muestra también su número para
          // que el cliente pueda escribir por WhatsApp con el número correcto.
          // Se guarda la modalidad y la dirección para que el reintento del
          // link use los del pedido real y no adivine.
          const described = describeOrderError(err);
          setCheckoutError({
            ...described,
            orderId: err.orderId,
            orderNumber: err.orderNumber,
            orderMode: mode,
            address: mode === "delivery" ? address : "",
          });
          setView(VIEWS.checkout);
        }
        return;
      }

      // Efectivo / Transferencia → pedido confirmado + WhatsApp
      const record = cart.placeOrder({ orderMode: mode, paymentMethod, address });
      // BUG-05: Safari iOS (y otros navegadores) bloquean window.open() que
      // ocurre después de un await: al salir del click el gesto del usuario
      // ya expiró y wa.me cuenta como popup no solicitado. La ventana se
      // abre ACÁ, vacía, en el mismo click, y recién se le carga la URL de
      // WhatsApp cuando el pedido está listo. Si el navegador la bloquea
      // igual (open devuelve null), el link queda como botón "Abrir
      // WhatsApp" en la pantalla de éxito.
      const waWindow = window.open("", "_blank");
      setWhatsappFallbackUrl(null);
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
        // Completar el orderNumber en el historial local (attachOrderNumber)
        cart.attachOrderNumber(record.id, orderNumber);
      } catch {
        // El pedido igual se arma por WhatsApp. Si el server no validó el cupón,
        // se usa el descuento ya validado en el cliente para que el mensaje no
        // cobre de más al que el cliente confirmó en pantalla.
        serverDiscount = couponDiscount || 0;
        serverCoupon = couponCode || "";
      }
      let waUrl;
      try {
        waUrl = buildWhatsAppOrderUrl({
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
      } catch (err) {
        // Sin link no hay a dónde navegar: se cierra la ventana vacía y el
        // error lo muestra el checkout (igual que antes, vía el catch de
        // handleConfirm), sin dejar una pestaña en blanco colgando.
        try {
          waWindow?.close();
        } catch {
          /* el navegador ya la cerró */
        }
        throw err;
      }
      if (waWindow && !waWindow.closed) {
        try {
          // La ventana sigue en about:blank (mismo origen): se le carga el
          // link y wa.me/WhatsApp hace el resto.
          waWindow.location.href = waUrl;
        } catch {
          // No se pudo navegar (p. ej. el usuario ya la cerró): botón visible.
          setWhatsappFallbackUrl(waUrl);
        }
      } else {
        // El popup quedó bloqueado: el link se muestra como botón visible.
        setWhatsappFallbackUrl(waUrl);
      }
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
      // Solo se registra en el historial Y se vacía el carrito si el pago se
      // aprobó. Si quedó rechazado/pendiente el carrito se conserva para que
      // el cliente pueda reintentar sin perder su pedido.
      if (fullOrder?.paymentStatus === "approved") {
        cart.placeOrderWithNumber(
          { orderMode: fullOrder.orderMode, paymentMethod: fullOrder.paymentMethod, address: fullOrder.address },
          fullOrder.orderNumber
        );
        cart.clearCart();
      }
      setLastOrder(fullOrder);
      setView(VIEWS.paymentResult);
    },
    [cart, paymentMeta]
  );

  // handlePaymentResult cambia de identidad cuando cambia paymentMeta; para que
  // el efecto de retorno de MP no se re-dispare, se guarda en un ref.
  const paymentResultRef = useRef(handlePaymentResult);
  paymentResultRef.current = handlePaymentResult;

  // Retorno de Mercado Pago: con la Orders API el pago ocurre en el checkout
  // alojado por MP, así que el navegador se va y vuelve con
  // ?pago=<resultado>&pedido=<nro>. El estado real se pide al backend (el
  // webhook puede tardar) y, si sigue "pendiente", se reintenta un rato antes
  // de mostrar la pantalla.
  const mpReturnDone = useRef(false);
  useEffect(() => {
    if (mpReturnDone.current) return;
    const qs = new URLSearchParams(window.location.search);
    const orderNumber = qs.get("pedido");
    if (!qs.get("pago") || !orderNumber) return;
    mpReturnDone.current = true;
    // Saca los parámetros del histórico: si el cliente recarga, no vuelve a saltar.
    window.history.replaceState({}, "", window.location.pathname);

    let alive = true;
    let tries = 0;
    (async function poll() {
      try {
        const order = await getOrderByNumber(orderNumber);
        if (!alive) return;
        setBranchId(order.branch);
        if (order.paymentStatus === "pending" && tries < 8) {
          tries += 1;
          setTimeout(poll, 2500);
          return;
        }
        setPaymentMeta({
          orderId: order.id,
          orderMode: order.orderMode,
          paymentMethod: order.paymentMethod,
        });
        paymentResultRef.current(order);
      } catch {
        if (alive) showToast("No pudimos recuperar el resultado del pago.", "error");
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Repetir" desde Mis pedidos: carga el pedido en el carrito, abre el
  // drawer y avisa con un toast (antes MyOrders llamaba a un global
  // window.__storeApp_setCartOpen que nadie definía).
  const handleRepeat = useCallback(
    (order) => {
      cart.repeatOrder(order);
      setCartOpen(true);
      showToast("Tu pedido quedó cargado en el carrito");
    },
    [cart, showToast]
  );

  // my-orders puede abrirse SIN sucursal (solo búsquedas).
  // El resto de vistas requieren sucursal.
  const needsBranch = view !== VIEWS.myOrders;
  if (needsBranch && (!branch || view === VIEWS.landing)) {
    return (
      <Landing
        onStart={handleLandingStart}
        initialBranch={branch ? branchId : ""}
        customer={customer}
      />
    );
  }
  if (needsBranch && !menu) {
    return <MenuSkeleton />;
  }

  return (
    <div className="app">
      <Header
        branch={branch}
        cartCount={cart.count}
        onCart={() => setCartOpen(true)}
        onHistory={() => setView(VIEWS.myOrders)}
        onHome={goHome}
        onChangeBranch={handleChangeBranch}
      />

      {view === VIEWS.menu && (
        <>
          <Menu menu={menu} branch={branch} orderMode={orderMode} onAdd={handleAdd} />
          <CartBar count={cart.count} total={cart.total} onView={() => setCartOpen(true)} />
        </>
      )}

      {cartOpen && (
        <CartView
          cart={cart}
          branch={branch}
          onBack={() => setCartOpen(false)}
          onCheckout={() => {
            setCartOpen(false);
            setView(VIEWS.checkout);
          }}
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
          serverError={checkoutError}
          onClearServerError={() => setCheckoutError(null)}
          onRetryPaymentLink={handleRetryPaymentLink}
          retryingLink={retryingLink}
        />
      )}

      {view === VIEWS.myOrders && (
        <MyOrders
          cart={cart}
          branch={branch}
          onBack={() => setView(branch ? VIEWS.menu : VIEWS.landing)}
          onRepeat={handleRepeat}
        />
      )}

      {view === VIEWS.success && (
        <div className="page">
          <div className="container">
            <div className="success">
              <div className="success__icon">✓</div>
              <h1>Pedido enviado</h1>
              <p>
                {whatsappFallbackUrl ? (
                  <>
                    Tu pedido quedó registrado, pero tu navegador bloqueó la ventana de WhatsApp.
                    Tocá el botón para enviarlo a <strong>{branch.name}</strong>.
                  </>
                ) : (
                  <>
                    Abrimos WhatsApp con tu pedido para <strong>{branch.name}</strong>. Solo tenés que
                    presionar enviar para confirmarlo.
                  </>
                )}
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
                {whatsappFallbackUrl && (
                  // BUG-05: la ventana abierta en el click fue bloqueada. Un
                  // <a target="_blank"> activado con un tap del usuario no
                  // pasa por el bloqueador de popups, así que es la salida
                  // garantizada al WhatsApp del local.
                  <a
                    className="btn btn--primary btn--block"
                    href={whatsappFallbackUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    💬 Abrir WhatsApp
                  </a>
                )}
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
          checkoutUrl={paymentFlow.checkoutUrl}
          total={paymentFlow.total}
          demoToken={paymentFlow.demoToken}
          branch={branch}
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