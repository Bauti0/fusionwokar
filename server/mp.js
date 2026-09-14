// ============================================================
// FUSIÓN WOK — Cliente de la API de Mercado Pago (Argentina)
// Todas las llamadas se hacen desde el servidor con el Access
// Token privado. El frontend solo recibe el ID de preferencia
// y la public key (que es pública).
//
// Modo demo: si no hay MP_ACCESS_TOKEN o DEMO_MODE=true, no se
// llama a la API real y se simulan las respuestas para poder
// probar el flujo completo sin credenciales.
// ============================================================

import { createHmac } from "node:crypto";

const MP_API = "https://api.mercadopago.com";

export function getMpToken() {
  return process.env.MP_ACCESS_TOKEN || "";
}

export function getMpPublicKey() {
  return process.env.MP_PUBLIC_KEY || "";
}

export function isDemoMode() {
  return process.env.DEMO_MODE === "true" || !process.env.MP_ACCESS_TOKEN;
}

// Crea la preferencia de pago (Checkout Pro) para un pedido
export async function createPreference({ orderNumber, total, title, description, backUrls, notificationUrl }) {
  const body = {
    items: [
      {
        id: orderNumber,
        title: title || `Pedido Fusión Wok ${orderNumber}`,
        description: description || "Pedido online",
        quantity: 1,
        unit_price: total,
        currency_id: "ARS",
        category_id: "food",
      },
    ],
    external_reference: orderNumber,
    statement_descriptor: "FUSION WOK",
    payment_methods: {
      excluded_payment_types: [{ id: "ticket" }],
      installments: 1,
    },
    auto_return: "approved",
    back_urls: backUrls,
    notification_url: notificationUrl,
  };

  const res = await fetch(`${MP_API}/checkout/preferences`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getMpToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Error de Mercado Pago (${res.status})`);
  }
  return { id: data.id, init_point: data.init_point, sandbox_init_point: data.sandbox_init_point };
}

// Consulta el estado real de un pago (se usa en el webhook para verificar)
export async function getPayment(paymentId) {
  const res = await fetch(`${MP_API}/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${getMpToken()}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Error al consultar pago (${res.status})`);
  }
  return {
    id: data.id,
    status: data.status, // approved | pending | rejected | in_process | cancelled
    status_detail: data.status_detail,
    external_reference: data.external_reference,
  };
}

// Verifica la firma del webhook (opcional, si se define MP_WEBHOOK_SECRET)
export function verifyWebhookSignature(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true; // sin secret configurado → confiamos (útil en demo)
  const signature = req.headers["x-signature"] || "";
  const requestId = req.headers["x-request-id"] || "";
  const body = req.body || {};
  const dataId = body.data?.id;
  const tsMatch = signature.match(/ts=(\d+)/);
  const v1Match = signature.match(/v1=([a-f0-9]+)/i);
  if (!tsMatch || !v1Match || !dataId) return false;
  const manifest = `id:${dataId};request-id:${requestId};ts:${tsMatch[1]};`;
  const hmac = createHmac("sha256", secret).update(manifest).digest("hex");
  return hmac === v1Match[1].toLowerCase();
}