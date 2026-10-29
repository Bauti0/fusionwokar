import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { previewOrderEdit } from "../src/utils/orderEdit.js";

// Vista previa de la edición de un pedido desde el panel admin.
// Espejo de server/order-edit.js: si acá dice "Total: $X → $Y" y el
// servidor guarda otra cosa, el resumen de confirmación miente.

function pedido(extra = {}) {
  return {
    id: 1,
    orderNumber: "A-1",
    branch: "tandil",
    status: "preparing",
    orderMode: "delivery",
    paymentMethod: "efectivo",
    paymentStatus: "approved",
    address: "Chacabuco 660",
    total: 18900,
    shipping: { cost: 4000, blocks: 20, pending: false },
    ...extra,
  };
}

function borrador(extra = {}) {
  return {
    orderMode: "delivery",
    paymentMethod: "efectivo",
    address: "",
    shippingCost: "",
    shippingTouched: false,
    ...extra,
  };
}

describe("previewOrderEdit", () => {
  it("delivery → mostrador descuenta el envío guardado del total", () => {
    // El total del pedido YA incluye el envío: pasarlo a mostrador tiene
    // que restarlo, igual que hace el backend.
    const r = previewOrderEdit(pedido(), borrador({ orderMode: "pickup" }));
    assert.equal(r.error, "");
    assert.equal(r.totalNuevo, 14900);
    assert.deepEqual(r.cambios, { orderMode: "pickup" });
    assert.ok(r.lineas.some((l) => l.includes("Delivery → Mostrador")));
    assert.ok(r.lineas.some((l) => l.includes("14.900")));
  });

  it("sin cambios no arma ningún payload", () => {
    const r = previewOrderEdit(pedido(), borrador());
    assert.equal(r.hayCambios, false);
    assert.deepEqual(r.cambios, {});
  });

  it("mostrador → delivery en Necochea exige el costo de envío manual", () => {
    // Necochea no tiene cálculo automático: sin costo, el backend contesta
    // 400. La vista previa tiene que frenar antes de mandar.
    const order = pedido({ branch: "necochea", orderMode: "pickup", address: "", shipping: { cost: 0, blocks: 0, pending: false } });
    const sinCosto = previewOrderEdit(order, borrador({ orderMode: "delivery", address: "San Martín 100" }));
    assert.match(sinCosto.error, /costo de envío/);

    const conCosto = previewOrderEdit(
      order,
      borrador({ orderMode: "delivery", address: "San Martín 100", shippingCost: "3500", shippingTouched: true })
    );
    assert.equal(conCosto.error, "");
    assert.equal(conCosto.cambios.shippingCost, 3500);
    assert.equal(conCosto.totalNuevo, 18900 + 3500);
  });

  it("mostrador → delivery sin dirección no se puede confirmar", () => {
    const order = pedido({ orderMode: "pickup", address: "" });
    const r = previewOrderEdit(order, borrador({ orderMode: "delivery" }));
    assert.match(r.error, /dirección/i);
    assert.deepEqual(r.cambios, {});
  });

  it("en Tandil sin tocar el envío NO lo manda: lo calcula el servidor", () => {
    // Regla del panel: shippingCost solo viaja si el admin lo editó a mano.
    // Si viajara vacío el backend lo rechazaría (no es número).
    const order = pedido({ orderMode: "pickup", address: "" });
    const r = previewOrderEdit(order, borrador({ orderMode: "delivery", address: "Sarmiento 50" }));
    assert.equal(r.error, "");
    assert.equal("shippingCost" in r.cambios, false);
    assert.equal(r.totalNuevo, null); // total a confirmar, lo da el servidor
    assert.ok(r.lineas.some((l) => l.includes("lo calcula el servidor")));
  });

  it("en Tandil con el envío editado a mano sí lo manda", () => {
    const order = pedido({ orderMode: "pickup", address: "" });
    const r = previewOrderEdit(
      order,
      borrador({ orderMode: "delivery", address: "Sarmiento 50", shippingCost: "4500", shippingTouched: true })
    );
    assert.equal(r.cambios.shippingCost, 4500);
    assert.equal(r.totalNuevo, 18900 + 4500);
  });

  it("cambio de pago desde MercadoPago pendiente deja el aviso de devolución", () => {
    const order = pedido({ paymentMethod: "mercadopago", paymentStatus: "pending" });
    const r = previewOrderEdit(order, borrador({ paymentMethod: "efectivo" }));
    assert.equal(r.cambios.paymentMethod, "efectivo");
    assert.equal(r.mpPendienteAviso, true);
    assert.ok(r.lineas.some((l) => l.includes("MercadoPago → Efectivo")));
  });

  it("cambio de pago aprobado en efectivo no avisa nada", () => {
    const r = previewOrderEdit(pedido(), borrador({ paymentMethod: "transferencia" }));
    assert.equal(r.mpPendienteAviso, false);
    assert.equal(r.totalNuevo, null); // el pago no mueve el total
  });

  it("no deja elegir MercadoPago como destino", () => {
    const order = pedido({ paymentMethod: "efectivo" });
    const r = previewOrderEdit(order, borrador({ paymentMethod: "mercadopago" }));
    assert.equal(r.hayCambios, false);
  });

  it("un pedido cancelado o pagado con MercadoPago aprobado no se edita", () => {
    const cancelado = previewOrderEdit(pedido({ status: "cancelled" }), borrador({ orderMode: "pickup" }));
    assert.match(cancelado.error, /cancelado/);

    const mp = previewOrderEdit(
      pedido({ paymentMethod: "mercadopago", paymentStatus: "approved" }),
      borrador({ orderMode: "pickup" })
    );
    assert.match(mp.error, /MercadoPago/);
  });
});
