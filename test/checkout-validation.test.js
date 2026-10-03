import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateCheckoutForm } from "../src/utils/checkoutValidation.js";

// ============================================================
// UX-01: validateCheckoutForm es la validacion del checkout que antes
// vivia inline en Checkout.jsx (handleConfirm). Se extrajo a una
// funcion pura por dos motivos:
// 1) El componente necesita saber cual es el PRIMER campo invalido
//    para hacer scroll suave hasta el y darle foco: el mensaje de
//    error (form-error) se renderiza al final de la pagina y en mobile
//    quedaba lejos de donde el usuario toco.
// 2) Fija en test el ORDEN de la validacion y los mensajes exactos,
//    que antes solo se probaban a mano.
// Los mensajes son los mismos que siempre vio el cliente: la unica
// mejora es el scroll + foco, no cambia ningun texto.
// ============================================================

// Formulario valido de base: pickup + efectivo (la forma mas simple).
// Cada test pisa solo lo que quiere romper.
const FORM_OK = {
  firstName: "Juan",
  lastName: "Perez",
  phone: "2262555555",
  email: "",
  address: "",
  paymentMethod: "efectivo",
  orderMode: "pickup",
  branchId: "tandil",
  shipping: null,
  shippingError: "",
  scheduleMode: "asap",
  scheduledAt: "",
};

// Fechas deterministas para los casos de programacion. Las ventanas de
// Tandil abren 11:30-15:30 TODOS los dias, asi que las 12:30 en hora local
// del runtime caen dentro de la ventana siempre (isOpenAtTime evalua en la
// zona del runtime, igual que el parseo del string), y las 16:30 quedan en
// el hueco de la tarde. No depende del timezone de la maquina que corre.
const MIDDAY = "2030-06-04T12:30";
const NOON = new Date(2030, 5, 4, 12, 0, 0, 0).getTime();
const PAST_1225 = new Date(2030, 5, 4, 12, 25, 0, 0).getTime();

describe("validateCheckoutForm — formulario completo", () => {
  it("devuelve null cuando todo esta OK (pickup + efectivo)", () => {
    assert.equal(validateCheckoutForm(FORM_OK), null);
  });

  it("devuelve null con Mercado Pago y email valido", () => {
    assert.equal(validateCheckoutForm({ ...FORM_OK, paymentMethod: "mercadopago", email: "juan@gmail.com" }), null);
  });

  it("con efectivo no exige email aunque este vacio", () => {
    // El email solo lo pide Mercado Pago (payer.email): con efectivo el
    // campo ni se muestra. Este era el comportamiento del componente.
    assert.equal(validateCheckoutForm({ ...FORM_OK, email: "" }), null);
  });
});

describe("validateCheckoutForm — primer campo invalido", () => {
  // El corazon de UX-01: con varios problemas a la vez, se reporta el
  // PRIMERO en el orden del formulario para scrollear/focus ahi.
  it("si faltan nombre y celular, devuelve el nombre primero", () => {
    const res = validateCheckoutForm({ ...FORM_OK, firstName: "", phone: "" });
    assert.deepEqual(res, { field: "firstName", message: "Completá tu nombre y apellido para confirmar." });
  });

  it("si falta solo el apellido, el campo es lastName", () => {
    const res = validateCheckoutForm({ ...FORM_OK, lastName: " " });
    assert.deepEqual(res, { field: "lastName", message: "Completá tu nombre y apellido para confirmar." });
  });

  it("celular vacio", () => {
    const res = validateCheckoutForm({ ...FORM_OK, phone: " " });
    assert.deepEqual(res, { field: "phone", message: "Completá tu celular para confirmar." });
  });

  it("celular invalido", () => {
    const res = validateCheckoutForm({ ...FORM_OK, phone: "123" });
    assert.deepEqual(res, { field: "phone", message: "El celular no parece válido. Ej: 2262 555555." });
  });

  it("email vacio solo falla con Mercado Pago", () => {
    const res = validateCheckoutForm({ ...FORM_OK, paymentMethod: "mercadopago", email: " " });
    assert.deepEqual(res, { field: "email", message: "Ingresá tu email para confirmar el pedido." });
  });

  it("email invalido con Mercado Pago", () => {
    const res = validateCheckoutForm({ ...FORM_OK, paymentMethod: "mercadopago", email: "juan@gmail" });
    assert.deepEqual(res, { field: "email", message: "El email no parece válido. Ej: nombre@correo.com." });
  });

  it("delivery sin direccion", () => {
    const res = validateCheckoutForm({ ...FORM_OK, orderMode: "delivery" });
    assert.deepEqual(res, { field: "address", message: "Ingresá tu dirección de entrega." });
  });

  it("pickup no exige direccion", () => {
    // La direccion solo se valida en delivery: en pickup el campo no existe.
    assert.equal(validateCheckoutForm({ ...FORM_OK, orderMode: "pickup", address: "" }), null);
  });

  it("delivery en Tandil con direccion muy corta", () => {
    const res = validateCheckoutForm({ ...FORM_OK, orderMode: "delivery", address: "Calle 1" });
    assert.deepEqual(res, { field: "address", message: "La dirección es muy corta. Ingresá la calle y el número." });
  });

  it("el minimo de 8 caracteres de direccion aplica solo a Tandil", () => {
    // Necochea no cotiza el envio automaticamente ni exige direccion larga.
    assert.equal(
      validateCheckoutForm({ ...FORM_OK, orderMode: "delivery", branchId: "necochea", address: "Calle 1" }),
      null
    );
  });
});

describe("validateCheckoutForm — cotizacion de envio (solo Tandil)", () => {
  const TANDIL_DELIVERY = {
    ...FORM_OK,
    orderMode: "delivery",
    branchId: "tandil",
    address: "Chacabuco 660",
  };

  it("sin cotizacion todavia: pide esperar a que termine el calculo", () => {
    const res = validateCheckoutForm({ ...TANDIL_DELIVERY, shipping: null, shippingError: "" });
    assert.deepEqual(res, { field: "address", message: "Estamos calculando el costo de envío…" });
  });

  it("cotizacion OK: pasa", () => {
    assert.equal(validateCheckoutForm({ ...TANDIL_DELIVERY, shipping: { cost: 4000, blocks: 8 } }), null);
  });

  it("fallo la cotizacion y es Mercado Pago: se bloquea con el error del servicio", () => {
    const res = validateCheckoutForm({
      ...TANDIL_DELIVERY,
      paymentMethod: "mercadopago",
      email: "juan@gmail.com",
      shippingError: "El servicio de mapas no responde",
    });
    assert.deepEqual(res, { field: "address", message: "El servicio de mapas no responde" });
  });

  it("fallo la cotizacion con efectivo/transferencia: pasa con envio a confirmar", () => {
    // Regresion clave: sin costo final MP no puede cobrar, pero efectivo
    // sigue pasando con el envio a confirmar por WhatsApp (igual que el
    // componente original, que solo bloqueaba con isMp).
    assert.equal(validateCheckoutForm({ ...TANDIL_DELIVERY, shippingError: "El servicio de mapas no responde" }), null);
  });
});

describe("validateCheckoutForm — pedido programado", () => {
  const SCHEDULED = { ...FORM_OK, scheduleMode: "scheduled" };

  it("programado sin fecha elegida", () => {
    const res = validateCheckoutForm({ ...SCHEDULED, scheduledAt: "" });
    assert.deepEqual(res, { field: "schedule", message: "Elegí la fecha y hora para tu pedido." });
  });

  it("fecha que no parsea", () => {
    const res = validateCheckoutForm({ ...SCHEDULED, scheduledAt: "no-es-una-fecha" }, NOON);
    assert.deepEqual(res, { field: "schedule", message: "Elegí una fecha y hora válidas." });
  });

  it("menos de 10 minutos de anticipacion", () => {
    const res = validateCheckoutForm({ ...SCHEDULED, scheduledAt: MIDDAY }, PAST_1225);
    assert.deepEqual(res, { field: "schedule", message: "Elegí una hora con al menos 10 minutos de anticipación." });
  });

  it("fuera del horario de apertura", () => {
    // 16:30 cae en el hueco de la tarde (15:30-19:00) de Tandil.
    const res = validateCheckoutForm({ ...SCHEDULED, scheduledAt: "2030-06-04T16:30" }, NOON);
    assert.deepEqual(res, { field: "schedule", message: "Elegí una hora dentro de nuestra apertura para programar el pedido." });
  });

  it("dentro del horario y con anticipacion: pasa", () => {
    assert.equal(validateCheckoutForm({ ...SCHEDULED, scheduledAt: MIDDAY }, NOON), null);
  });

  it("con 'lo antes posible' la fecha basura no se valida", () => {
    // scheduleMode asap ignora scheduledAt por completo.
    assert.equal(validateCheckoutForm({ ...FORM_OK, scheduleMode: "asap", scheduledAt: "basura" }), null);
  });
});
