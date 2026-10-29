// ============================================================
// Tests para checkoutHelpers.js — funciones puras del checkout
// Runner: node:test nativo (sin Jest/Vitest)
// Cada test lleva comentario en español explicando la regresión que cubre.
// ============================================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getTotalLabel,
  isSubmitDisabled,
  decideSubmitAction,
} from "../src/utils/checkoutHelpers.js";

describe("getTotalLabel", () => {
  it("devuelve 'Total estimado' + 'envío a confirmar' cuando shippingUnavailable y !isMp (Tandil, efectivo/transferencia, cotización falló)", () => {
    // Regresión: antes mostraba "Total (N items)" aunque el envío no se sabía.
    const { main, sub } = getTotalLabel({ count: 3, shippingUnavailable: true, isMp: false });
    assert.equal(main, "Total estimado (3 items)");
    assert.equal(sub, "envío a confirmar");
  });

  it("devuelve 'Total (N items)' sin sub-label cuando shippingUnavailable pero isMp (Mercado Pago bloquea sin costo)", () => {
    // Regresión: MP no puede cobrar sin monto final → no mostramos "estimado".
    const { main, sub } = getTotalLabel({ count: 2, shippingUnavailable: true, isMp: true });
    assert.equal(main, "Total (2 items)");
    assert.equal(sub, null);
  });

  it("devuelve 'Total (N items)' cuando el envío SÍ está disponible (shippingUnavailable=false)", () => {
    // Caso normal: envío calculado → total exacto.
    const { main, sub } = getTotalLabel({ count: 1, shippingUnavailable: false, isMp: false });
    assert.equal(main, "Total (1 items)");
    assert.equal(sub, null);
  });

  it("devuelve 'Total (N items)' para retiro en local (shippingUnavailable=false implícito)", () => {
    // Retiro no tiene envío → total exacto siempre.
    const { main, sub } = getTotalLabel({ count: 4, shippingUnavailable: false, isMp: true });
    assert.equal(main, "Total (4 items)");
    assert.equal(sub, null);
  });
});

describe("isSubmitDisabled", () => {
  it("deshabilita cuando busy=true (enviando pedido)", () => {
    // Regresión: botón no debe permitir doble submit mientras busy.
    assert.equal(isSubmitDisabled({ busy: true, retryingLink: false, paused: false, serverError: null }), true);
  });

  it("deshabilita cuando retryingLink=true (reintentando link de pago)", () => {
    // Regresión: botón no debe permitir acción mientras se regenera link MP.
    assert.equal(isSubmitDisabled({ busy: false, retryingLink: true, paused: false, serverError: null }), true);
  });

  it("deshabilita cuando paused=true (sucursal pausada)", () => {
    // Regresión: botón no debe permitir pedidos mientras el local está pausado.
    assert.equal(isSubmitDisabled({ busy: false, retryingLink: false, paused: true, serverError: null }), true);
  });

  it("deshabilita cuando serverError.orderId existe y canRetry=false (credenciales MP inválidas)", () => {
    // Regresión: pedido guardado sin pago no reintentable → botón deshabilitado, salida por WhatsApp.
    const serverError = { orderId: "123", canRetry: false };
    assert.equal(isSubmitDisabled({ busy: false, retryingLink: false, paused: false, serverError }), true);
  });

  it("habilita cuando serverError.orderId existe y canRetry=true (reintento de link disponible)", () => {
    // Regresión: botón DEBE estar habilitado para "Reintentar el pago" (llama onRetryPaymentLink, no onConfirm).
    const serverError = { orderId: "123", canRetry: true };
    assert.equal(isSubmitDisabled({ busy: false, retryingLink: false, paused: false, serverError }), false);
  });

  it("habilita cuando no hay ningún bloqueo (caso normal)", () => {
    assert.equal(isSubmitDisabled({ busy: false, retryingLink: false, paused: false, serverError: null }), false);
  });
});

describe("decideSubmitAction", () => {
  it("retorna 'retry' cuando hay serverError con orderId, canRetry=true y onRetryPaymentLink existe", () => {
    // Regresión crítica: antes el botón principal bifurcaba en onClick:
    //   serverError?.orderId && serverError.canRetry && onRetryPaymentLink ? onRetryPaymentLink : handleConfirm
    // Al pasar a type="submit" con onSubmit único, esa bifurcación se perdió y "Reintentar el pago"
    // creaba un pedido DUPLICADO en lugar de reintentar el link del pedido ya guardado.
    const serverError = { orderId: "123", canRetry: true };
    assert.equal(decideSubmitAction({ serverError, hasRetryHandler: true }), "retry");
  });

  it("retorna 'create' cuando serverError tiene orderId pero canRetry=false", () => {
    // Sin reintento posible → flujo normal de creación (el botón está deshabilitado por isSubmitDisabled,
    // pero si se forzara, crearía uno nuevo; la UI muestra "Mercado Pago no disponible" y botón WhatsApp).
    const serverError = { orderId: "123", canRetry: false };
    assert.equal(decideSubmitAction({ serverError, hasRetryHandler: true }), "create");
  });

  it("retorna 'create' cuando no hay serverError (pedido nuevo normal)", () => {
    // Flujo estándar: primer pedido del cliente.
    assert.equal(decideSubmitAction({ serverError: null, hasRetryHandler: true }), "create");
  });

  it("retorna 'create' cuando hay serverError con orderId y canRetry=true pero FALTA onRetryPaymentLink", () => {
    // Defensa: si el handler no está disponible (edge case), mejor crear que quedarse sin acción.
    const serverError = { orderId: "123", canRetry: true };
    assert.equal(decideSubmitAction({ serverError, hasRetryHandler: false }), "create");
  });
});