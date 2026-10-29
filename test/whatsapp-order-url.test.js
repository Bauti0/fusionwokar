import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWhatsAppOrderUrl, buildOrderMessage } from "../src/utils/whatsapp.js";

// ============================================================
// BUG-05: Safari iOS (y otros navegadores) bloquean window.open()
// cuando ocurre despues de un await: al salir del click, el gesto del
// usuario ya expiro y wa.me cuenta como popup no solicitado. El flujo
// efectivo/transferencia necesita construir el link de WhatsApp SIN
// abrir la ventana: la ventana se abre vacia en el mismo click y el
// link se le carga cuando el pedido ya existe. buildWhatsAppOrderUrl
// es esa parte pura (sendOrderByWhatsApp la reutiliza).
// ============================================================

const data = () => ({
  branch: { name: "Necochea", whatsapp: "542262480511" },
  order: {
    items: [
      {
        name: "Wok Clasico",
        unitPrice: 18900,
        qty: 2,
        extras: [{ label: "Extra salsa", price: 900 }],
      },
    ],
  },
  customer: { name: "Juan Perez", phone: "2262555555" },
  orderMode: "delivery",
  paymentMethod: "efectivo",
  address: "Diagonal San Martin 1258",
  deliveryNotes: "",
  coupon: "",
  discount: 0,
  scheduledFor: "",
  shipping: { cost: 4000, blocks: 8 },
});

describe("buildWhatsAppOrderUrl", () => {
  it("apunta al numero de WhatsApp de la sucursal", () => {
    const url = buildWhatsAppOrderUrl(data());
    assert.ok(url.startsWith("https://wa.me/542262480511?text="), `url inesperada: ${url}`);
  });

  it("el texto encodeado es exactamente el mensaje que arma buildOrderMessage", () => {
    // Fija que construir el link no transforme ni pierda nada del mensaje.
    const d = data();
    const url = buildWhatsAppOrderUrl(d);
    const text = decodeURIComponent(url.slice(url.indexOf("?text=") + "?text=".length));
    assert.equal(text, buildOrderMessage(d));
  });

  it("el mensaje lleva la sucursal, el item y el envio", () => {
    const url = buildWhatsAppOrderUrl(data());
    const text = decodeURIComponent(url.slice(url.indexOf("?text=") + "?text=".length));
    assert.ok(text.includes("Necochea"));
    assert.ok(text.includes("Wok Clasico"));
    assert.ok(text.includes("Envío"));
  });

  it("no deja saltos de linea ni espacios sin encodear", () => {
    // El mensaje tiene \n y espacios: el link tiene que viajar todo
    // encodeado para que cualquier navegador lo pueda navegar.
    const url = buildWhatsAppOrderUrl(data());
    assert.ok(!/[\n\r ]/.test(url), `el link tiene caracteres sin encodear: ${JSON.stringify(url)}`);
  });
});
