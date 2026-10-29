import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toPublicOrder } from "../server/public-order.js";
import {
  buildItemRows,
  hasDiscount,
  buildDiscountRow,
  buildShippingRow,
  computeItemsSubtotal,
  verifyOrderBreakdown,
  buildOrderSummaryRows,
} from "../src/utils/orderSummary.js";

// Fila cruda de la tabla `orders` (snake_case, JSON en items), tal como la
// guarda el server. El pedido público sale SOLO de toPublicOrder: es la forma
// REAL que consumen el panel y el ticket, no un objeto armado a mano.
function filaBase(overrides = {}) {
  return {
    id: 412,
    order_number: "A-412",
    branch: "necochea",
    created_at: "2026-10-02T16:40:00Z",
    updated_at: "2026-10-02T16:40:00Z",
    status: "preparing",
    payment_status: "approved",
    payment_method: "mercadopago",
    order_mode: "delivery",
    address: "Cuba 1173",
    total: 80900,
    discount: 0,
    coupon_code: "",
    notes: "Observación: llamar antes",
    scheduled_for: "",
    shipping: 0,
    shipping_km: 0,
    shipping_pending: 0,
    customer_name: "María Gómez",
    customer_phone: "2262480511",
    customer_email: "",
    customer_first_name: "",
    customer_last_name: "",
    source: "web",
    mp_order_id: "",
    mp_payment_id: null,
    refunded_amount: 0,
    refunds_json: "[]",
    items: JSON.stringify([
      { productId: "wok-mein", name: "Mein pollo", qty: 1, unitPrice: 18900, extras: [], notes: "" },
      { productId: "salsa", name: "Salsa picante", qty: 2, unitPrice: 1500, extras: [], notes: "sin cebolla" },
      {
        productId: "wok-mixto",
        name: "Mein mixto",
        qty: 1,
        unitPrice: 21000,
        extras: [{ id: "e1", label: "Extra queso", price: 2000 }],
        notes: "",
      },
      { productId: "gyoza", name: "Gyozas de cerdo", qty: 3, unitPrice: 12000, extras: [], notes: "" },
    ]),
    ...overrides,
  };
}

function pedido(overrides = {}) {
  return toPublicOrder(filaBase(overrides));
}

describe("orderSummary", () => {
  describe("buildItemRows", () => {
    it("devuelve items ordenados de mayor a menor cantidad", () => {
      const order = pedido();
      const rows = buildItemRows(order);
      assert.equal(rows[0].name, "Gyozas de cerdo");
      assert.equal(rows[0].qty, 3);
      assert.equal(rows[1].name, "Salsa picante");
      assert.equal(rows[1].qty, 2);
      assert.equal(rows[2].name, "Mein pollo");
      assert.equal(rows[2].qty, 1);
      assert.equal(rows[3].name, "Mein mixto");
      assert.equal(rows[3].qty, 1);
    });

    it("incluye extras con su precio por cantidad", () => {
      const order = pedido();
      const rows = buildItemRows(order);
      const mixto = rows.find((r) => r.name === "Mein mixto");
      assert.ok(mixto);
      assert.equal(mixto.extras.length, 1);
      assert.equal(mixto.extras[0].label, "Extra queso");
      assert.equal(mixto.extras[0].price, 2000);
      assert.equal(mixto.extras[0].lineTotal, 2000); // 2000 * 1
    });

    it("calcula lineTotal correctamente (unitPrice + extras) * qty", () => {
      const order = pedido();
      const rows = buildItemRows(order);
      const mixto = rows.find((r) => r.name === "Mein mixto");
      // (21000 + 2000) * 1 = 23000
      assert.equal(mixto.lineTotal, 23000);
      const gyozas = rows.find((r) => r.name === "Gyozas de cerdo");
      // 12000 * 3 = 36000
      assert.equal(gyozas.lineTotal, 36000);
    });
  });

  describe("hasDiscount", () => {
    it("devuelve false si no hay descuento", () => {
      const order = pedido();
      assert.equal(hasDiscount(order), false);
    });

    it("devuelve true si hay descuento > 0", () => {
      const order = pedido({ discount: 5000 });
      assert.equal(hasDiscount(order), true);
    });
  });

  describe("buildDiscountRow", () => {
    it("devuelve null si no hay descuento", () => {
      const order = pedido();
      assert.equal(buildDiscountRow(order), null);
    });

    it("devuelve fila con label y amount negativo", () => {
      const order = pedido({ discount: 5000, coupon_code: "WELCOME" });
      const row = buildDiscountRow(order);
      assert.equal(row.label, "Descuento (WELCOME)");
      assert.equal(row.amount, -5000);
    });

    it("usa 'Descuento' genérico sin couponCode", () => {
      const order = pedido({ discount: 3000, coupon_code: "" });
      const row = buildDiscountRow(order);
      assert.equal(row.label, "Descuento");
    });
  });

  describe("buildShippingRow", () => {
    it("devuelve null si no es delivery", () => {
      const order = pedido({ order_mode: "pickup" });
      assert.equal(buildShippingRow(order), null);
    });

    it("devuelve null si delivery sin costo ni pendiente", () => {
      const order = pedido({ order_mode: "delivery", shipping: 0, shipping_pending: 0 });
      assert.equal(buildShippingRow(order), null);
    });

    it("devuelve fila con monto si delivery con costo", () => {
      const order = pedido({ order_mode: "delivery", shipping: 4000, shipping_pending: 0 });
      const row = buildShippingRow(order);
      assert.equal(row.label, "Envío");
      assert.equal(row.amount, 4000);
      assert.equal(row.pending, false);
    });

    it("devuelve fila con pending=true si delivery con envío pendiente", () => {
      const order = pedido({ order_mode: "delivery", shipping: 0, shipping_pending: 1 });
      const row = buildShippingRow(order);
      assert.equal(row.label, "Envío");
      assert.equal(row.amount, null);
      assert.equal(row.pending, true);
    });
  });

  describe("computeItemsSubtotal", () => {
    it("suma lineTotal de todos los items (con extras)", () => {
      const order = pedido();
      // Gyozas: 12000*3=36000
      // Salsa: 1500*2=3000
      // Mein pollo: 18900*1=18900
      // Mein mixto: (21000+2000)*1=23000
      // Total = 80900
      assert.equal(computeItemsSubtotal(order), 80900);
    });
  });

  describe("verifyOrderBreakdown", () => {
    it("cierra exacto en pedido base (sin descuento, sin envío)", () => {
      const order = pedido();
      const v = verifyOrderBreakdown(order);
      assert.equal(v.ok, true);
      // diff/discount/shipping pueden ser 0 o -0 (ambos son "cero" numérico)
      assert.ok(Math.abs(v.diff) === 0);
      assert.equal(v.itemsSubtotal, 80900);
      assert.ok(Math.abs(v.discount) === 0);
      assert.ok(Math.abs(v.shipping) === 0);
      assert.equal(v.total, 80900);
    });

    it("cierra con descuento", () => {
      // total en BD ya incluye el descuento: itemsSubtotal - discount = total
      const order = pedido({ discount: 5000, total: 75900 });
      const v = verifyOrderBreakdown(order);
      assert.equal(v.ok, true);
      assert.ok(Math.abs(v.diff) === 0);
      assert.equal(v.itemsSubtotal, 80900);
      assert.equal(v.discount, -5000);
      assert.ok(Math.abs(v.shipping) === 0);
      assert.equal(v.total, 75900);
    });

    it("cierra con envío delivery", () => {
      const order = pedido({ shipping: 4000, total: 84900 });
      const v = verifyOrderBreakdown(order);
      assert.equal(v.ok, true);
      assert.ok(Math.abs(v.diff) === 0);
      assert.equal(v.itemsSubtotal, 80900);
      assert.ok(Math.abs(v.discount) === 0);
      assert.equal(v.shipping, 4000);
      assert.equal(v.total, 84900);
    });

    it("cierra con descuento + envío", () => {
      const order = pedido({ discount: 5000, shipping: 4000, total: 79900 });
      const v = verifyOrderBreakdown(order);
      assert.equal(v.ok, true);
      assert.ok(Math.abs(v.diff) === 0);
      assert.equal(v.itemsSubtotal, 80900);
      assert.equal(v.discount, -5000);
      assert.equal(v.shipping, 4000);
      assert.equal(v.total, 79900);
    });

    it("reporta diff si los números no cierran (p.ej. propina o redondeo)", () => {
      // total con 100 de más (simula propina no contabilizada)
      const order = pedido({ total: 81000 });
      const v = verifyOrderBreakdown(order);
      assert.equal(v.ok, false);
      // diff = calculated - total = 80900 - 81000 = -100
      assert.equal(v.diff, -100);
    });
  });

  describe("buildOrderSummaryRows", () => {
    it("incluye items, total, y no incluye descuento/envío si no corresponden", () => {
      const order = pedido({ order_mode: "pickup" });
      const { rows } = buildOrderSummaryRows(order);
      // 4 items + 1 total = 5 filas
      assert.equal(rows.length, 5);
      assert.equal(rows[4].type, "total");
      assert.ok(!rows.some((r) => r.type === "discount"));
      assert.ok(!rows.some((r) => r.type === "shipping"));
    });

    it("incluye fila de descuento si hay descuento", () => {
      const order = pedido({ discount: 5000, coupon_code: "WELCOME" });
      const { rows } = buildOrderSummaryRows(order);
      const discountRow = rows.find((r) => r.type === "discount");
      assert.ok(discountRow);
      assert.equal(discountRow.label, "Descuento (WELCOME)");
    });

    it("incluye fila de envío si delivery con costo", () => {
      const order = pedido({ shipping: 4000 });
      const { rows } = buildOrderSummaryRows(order);
      const shippingRow = rows.find((r) => r.type === "shipping");
      assert.ok(shippingRow);
      assert.equal(shippingRow.amount, 4000);
      assert.equal(shippingRow.pending, false);
    });

    it("incluye fila de envío pendiente si delivery con pending", () => {
      const order = pedido({ shipping: 0, shipping_pending: 1 });
      const { rows } = buildOrderSummaryRows(order);
      const shippingRow = rows.find((r) => r.type === "shipping");
      assert.ok(shippingRow);
      assert.equal(shippingRow.pending, true);
      assert.equal(shippingRow.amount, null);
    });

    it("no incluye fila de envío si mostrador", () => {
      const order = pedido({ order_mode: "pickup", shipping: 4000 });
      const { rows } = buildOrderSummaryRows(order);
      assert.ok(!rows.some((r) => r.type === "shipping"));
    });

    it("orden: items → descuento → envío → total", () => {
      const order = pedido({ discount: 5000, shipping: 4000 });
      const { rows } = buildOrderSummaryRows(order);
      const types = rows.map((r) => r.type).filter((t) => t);
      // items no tienen type, así que busco los índices
      const idxDiscount = rows.findIndex((r) => r.type === "discount");
      const idxShipping = rows.findIndex((r) => r.type === "shipping");
      const idxTotal = rows.findIndex((r) => r.type === "total");
      assert.ok(idxDiscount < idxShipping, "descuento antes que envío");
      assert.ok(idxShipping < idxTotal, "envío antes que total");
    });
  });
});