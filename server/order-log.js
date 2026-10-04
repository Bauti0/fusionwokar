// ============================================================
// FUSIÓN WOK — Una línea de log por rechazo/error del checkout
//
// Por qué existe: un 400 de validateOrderBody y un 429 del rate limit
// contestaban sin dejar NADA en los logs de Render. Cuando el local
// reportaba "un cliente vio Producto no disponible" no había forma de
// saber si el pedido se frenó por disponibilidad, por precio, por zona
// de envío o por rate limit: solo el mensaje que recibió el cliente.
//
// REGLA DE PRIVACIDAD (no negociable): a los logs van SOLO datos de
// contexto operativo —código HTTP, sucursal, modalidad, método de pago,
// número de pedido, código de falla de envío y el mensaje de error que ya
// se le mandó al cliente—. NUNCA nombre, teléfono, email, dirección, DNI
// ni notas del cliente. Por eso esta función es una WHITELIST: lee
// únicamente las claves de la lista ORDER_LOG_FIELDS y arma la línea con un
// array explícito, así que cualquier otra cosa que le pasen (el body entero
// del pedido, la fila de orders, un `customer`) se ignora en silencio.
// Además sanea los valores: una branch mandada por el cliente o un nombre
// de producto con salto de línea no pueden romper la línea ni inyectar un
// log falso (log injection).
//
// El `msg` que se loguea es siempre el MISMO texto que se respondió al
// cliente, que en validateOrderBody / shipping.js / coupons.js son
// literales estáticos (el único interpolado es el nombre del producto en el
// error de precio). Ese contrato lo fija test/order-log.test.js.
//
// Puro y testeable con el patrón de coupons.js/reconcile.js: sin imports,
// sin consola, sin reloj. `orderLogLine` devuelve el string y el caller
// hace el console.warn.
// ============================================================

// Tope del mensaje: los errores de validación son cortos ("Producto no
// disponible") salvo el de precio, que trae el nombre del producto. El
// corte evita que un texto largo (o manipulado) infle los logs.
const MAX_MESSAGE = 160;
const MAX_ROUTE = 60;

// Valores cortos y cerrados (branch, modalidad, método de pago, códigos,
// número de pedido). Cualquier cosa fuera del patrón se loguea como "-":
// no vale la pena filtrar la causa raíz y el dato tampoco identifica a
// nadie (a diferencia de un teléfono o una dirección).
const TOKEN_RE = /^[a-z0-9._:-]{1,40}$/i;

// Caracteres de control: se cambian por espacio para que un salto de línea
// que venga del body no parta el log en dos ni permita log injection.
function flatten(value) {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out;
}

function token(value) {
  let s = "";
  if (typeof value === "number" && Number.isFinite(value)) s = String(value);
  else if (typeof value === "string") s = value.trim();
  return TOKEN_RE.test(s) ? s : "-";
}

// El status tiene que ser un código HTTP de tres dígitos: si el caller se
// pasa y pasa otra cosa, sale "-" en vez de un campo de texto libre.
function statusToken(value) {
  let s = "";
  if (typeof value === "number" && Number.isFinite(value)) s = String(value);
  else if (typeof value === "string") s = value.trim();
  return /^[1-5]\d{2}$/.test(s) ? s : "-";
}

// Texto libre (route, mensaje): una sola línea, sin caracteres de control,
// sin comillas que rompan el formato y recortado al tope.
function oneLine(value, max) {
  let s = "";
  if (typeof value === "string") s = value;
  else if (typeof value === "number" && Number.isFinite(value)) s = String(value);
  const flat = flatten(s).replace(/\s+/g, " ").replace(/["\\]/g, "'").trim();
  if (!flat) return "";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Whitelist de contexto: SOLO se leen estas claves del ctx.
export const ORDER_LOG_FIELDS = [
  "branch",
  "orderMode",
  "paymentMethod",
  "shippingCode",
  "code",
  "orderNumber",
  "message",
];

// Arma la línea de log. `route` es un literal del código
// ("POST /api/orders"), nunca dato del cliente. `status` es el HTTP que se
// respondió (200 en el caso de éxito). Devuelve siempre una única línea.
export function orderLogLine(route, status, ctx = {}) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  // `key in c` y no `c[key]`: si alguien le pasa un objeto con getters en el
  // prototipo (un `req` de Express, por ejemplo), leerlos dispararía código
  // que no está en la whitelist.
  const get = (key) => (key in c ? c[key] : undefined);
  const parts = [
    "[orders]",
    oneLine(route, MAX_ROUTE),
    `status=${statusToken(status)}`,
    `branch=${token(get("branch"))}`,
    `mode=${token(get("orderMode"))}`,
    `payment=${token(get("paymentMethod"))}`,
  ];
  // Campos opcionales: solo si el caller los conoce. Si no, se omiten en
  // lugar de llenarlos de "-", así la línea dice la verdad sobre lo que se
  // sabía en el momento del rechazo.
  const shippingCode = token(get("shippingCode"));
  if (shippingCode !== "-") parts.push(`shippingCode=${shippingCode}`);
  const code = token(get("code"));
  if (code !== "-") parts.push(`code=${code}`);
  const orderNumber = token(get("orderNumber"));
  if (orderNumber !== "-") parts.push(`order=${orderNumber}`);
  const message = oneLine(get("message"), MAX_MESSAGE);
  if (message) parts.push(`msg="${message}"`);
  return parts.filter(Boolean).join(" ");
}
