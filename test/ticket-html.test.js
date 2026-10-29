import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildComandaHtml, buildTicketHtml } from "../src/utils/ticketHtml.js";
import { toPublicOrder } from "../server/public-order.js";

// Los dos documentos que salen por la impresora térmica: la COMANDA (cocina) y
// el TICKET (bolsa del pedido). Se arman como HTML y los imprime el driver, así
// que el texto que llega al papel es exactamente el que está acá adentro.

// Fila cruda de la tabla `orders` (snake_case, JSON en items), tal como la
// guarda el server. El pedido público sale SOLO de toPublicOrder: es la forma
// REAL que consumen el panel y el ticket, no un objeto armado a mano con los
// nombres de campo supuestos (ese error dejó pasar el envío fantasma).
function filaPedido() {
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
  };
}

function pedido() {
  return toPublicOrder(filaPedido());
}

// El mismo pedido sin ninguna nota: la comanda tiene que salir tal cual,
// sin filas ni títulos de más.
function pedidoSinNotas() {
  const order = pedido();
  order.notes = "";
  return { ...order, items: order.items.map((it) => ({ ...it, notes: "" })) };
}

// El texto del documento sin el HTML: lo que se lee en el papel. El <style>
// no se imprime, así que se saca antes (tiene un "*" que no es un asterisco
// de nota).
function texto(html) {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Cada fila <tr> por separado, para comprobar que un precio o una variante no
// se separan de su producto.
function filas(html) {
  return html.match(/<tr[\s\S]*?<\/tr>/g) || [];
}

function filaDe(html, nombre) {
  const fila = filas(html).find((f) => f.includes(nombre));
  assert.ok(fila, `no se encontró la fila de "${nombre}"`);
  return fila;
}

// El documento tal como lo ve el driver cuando convierte el HTML a texto: cada
// <br> es un salto de línea y las etiquetas desaparecen. Sirve para contar las
// líneas en blanco del pie, que es lo que separa un trabajo del siguiente.
function lineasDeRelleno(html) {
  const lineas = html
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .split("\n")
    .map((l) => l.trim());
  let n = 0;
  for (let i = lineas.length - 1; i >= 0 && lineas[i] === ""; i--) n++;
  return n;
}

// Resuelve las entidades HTML: es recién ahí que el navegador entrega el texto
// al driver. "&nbsp;" es ASCII puro en la fuente, así que validar el HTML a
// secas tapa el bug en vez de encontrarlo: el navegador lo imprime como U+00A0
// y ese es justo el byte que la térmica china convierte en ideograma.
const ENTIDADES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00A0" };

function decodificar(html) {
  return html.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (todo, nombre) => {
    if (nombre[0] === "#") {
      const n = nombre[1] === "x" || nombre[1] === "X" ? parseInt(nombre.slice(2), 16) : parseInt(nombre.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : todo;
    }
    return ENTIDADES[nombre.toLowerCase()] ?? todo;
  });
}

// La causa raíz de los ideogramas: NINGÚN byte fuera del ASCII imprimible puede
// llegar a la impresora. Con un solo carácter no ASCII el driver chino lo
// combina con el siguiente y el papel muestra basura.
function assertSoloAscii(html) {
  const fuera = [...decodificar(html)].filter((ch) => {
    const c = ch.charCodeAt(0);
    return !(c === 0x0a || c === 0x09 || (c >= 0x20 && c <= 0x7e));
  });
  assert.deepEqual(fuera, [], `caracteres no ASCII en el documento: ${JSON.stringify(fuera.join(""))}`);
}

describe("buildComandaHtml", () => {
  it("no imprime el mensaje de gracias (es para cocina)", () => {
    // La comanda no es para el cliente: si aparece un texto de cortesía, el
    // papel lo lee el cocinero y no el que recoge el pedido.
    const html = buildComandaHtml(pedido());
    assert.doesNotMatch(html, /Gracias/);
    assert.doesNotMatch(html, /gracias/);
  });

  it("no imprime datos del cliente ni importes", () => {
    const html = buildComandaHtml(pedido());
    assert.doesNotMatch(html, /Maria Gomez/);
    assert.doesNotMatch(html, /2262480511/);
    assert.doesNotMatch(html, /Cuba 1173/);
    assert.doesNotMatch(html, /TOTAL/);
  });

  it("no deja ningún carácter fuera del ASCII imprimible", () => {
    assertSoloAscii(buildComandaHtml(pedido()));
  });

  it("la cantidad se imprime como 'N x' con espacio antes y después", () => {
    // "1 x Ramen Naruto": la x ASCII separado, no el signo × pegado al número
    // (que salía como "1識amen").
    assert.match(texto(buildComandaHtml(pedido())), /1 x Mein pollo/);
    assert.match(texto(buildComandaHtml(pedido())), /3 x Gyozas de cerdo/);
  });

  it("ordena los ítems de mayor a menor cantidad", () => {
    // La cocina lee primero lo que más veces se pidió.
    const t = texto(buildComandaHtml(pedido()));
    assert.ok(
      t.indexOf("Gyozas de cerdo") < t.indexOf("Salsa picante"),
      `Gyozas (3) tiene que ir antes que Salsa (2): ${t}`,
    );
    assert.ok(
      t.indexOf("Salsa picante") < t.indexOf("Mein pollo"),
      `Salsa (2) tiene que ir antes que Mein pollo (1): ${t}`,
    );
    assert.ok(
      t.indexOf("Mein pollo") < t.indexOf("Mein mixto"),
      `los dos de cantidad 1 mantienen el orden del pedido: ${t}`,
    );
  });

  it("mantiene cada variante junto a su producto", () => {
    // "Extra queso" pertenece al Mein mixto: si el orden los separa, la
    // cocina arma el plato con el queso de otro.
    const t = texto(buildComandaHtml(pedido()));
    assert.match(t, /Mein mixto[\s\S]*Extra queso/);
  });

  it("conserva el encabezado de cocina: marca, número, fecha y modalidad", () => {
    const t = texto(buildComandaHtml(pedido()));
    assert.match(t, /FUSION WOK/);
    assert.match(t, /Necochea/);
    assert.match(t, /COMANDA - A-412/);
    assert.match(t, /DELIVERY/);
  });

  it("no cambia el orden guardado en el pedido", () => {
    const order = pedido();
    buildComandaHtml(order);
    assert.deepEqual(
      order.items.map((it) => it.name),
      ["Mein pollo", "Salsa picante", "Mein mixto", "Gyozas de cerdo"],
    );
  });

  it("imprime la nota del ítem debajo del ítem, con prefijo", () => {
    // "sin cebolla" es la nota de "Salsa picante": tiene que salir pegada a su
    // renglón, no suelta abajo ni pegada a otro plato.
    assert.match(texto(buildComandaHtml(pedido())), /2 x Salsa picante \* sin cebolla/);
  });

  it("cada nota se mueve con su ítem al ordenar por cantidad", () => {
    // El pedido tiene "Mein pollo" (1) antes que "Salsa picante" (2), pero la
    // comanda imprime la de la salsa primero: la nota tiene que seguir a su
    // ítem, no al lugar que tenía en el pedido.
    const order = pedido();
    order.items[0].notes = "sin pollo";
    const t = texto(buildComandaHtml(order));
    assert.match(t, /1 x Mein pollo \* sin pollo/);
    assert.ok(
      t.indexOf("sin cebolla") < t.indexOf("sin pollo"),
      `la nota de la salsa (2) va antes que la del Mein pollo (1): ${t}`,
    );
  });

  it("imprime la nota general del pedido al final con el título NOTA:", () => {
    const t = texto(buildComandaHtml(pedido()));
    assert.match(t, /NOTA: Observacion: llamar antes/);
    assert.ok(
      t.endsWith("NOTA: Observacion: llamar antes"),
      `la nota general tiene que ser lo último de la comanda: ${t}`,
    );
  });

  it("sin notas no imprime filas ni títulos de más", () => {
    const html = buildComandaHtml(pedidoSinNotas());
    assert.doesNotMatch(html, /NOTA:/);
    assert.doesNotMatch(texto(html), /\*/);
    // 4 ítems + 1 variante = 5 filas. Ni una más.
    assert.equal(filas(html).length, 5);
  });

  it("con nota de ítem y sin nota general solo agrega la fila del ítem", () => {
    const order = pedidoSinNotas();
    order.items[1].notes = "poco picante";
    const html = buildComandaHtml(order);
    assert.equal(filas(html).length, 6);
    assert.doesNotMatch(html, /NOTA:/);
    assert.match(texto(html), /\* poco picante/);
  });

  it("una nota que es solo espacios no imprime una línea vacía", () => {
    const order = pedidoSinNotas();
    order.notes = "   ";
    order.items[2].notes = "  ";
    const html = buildComandaHtml(order);
    assert.doesNotMatch(html, /NOTA:/);
    assert.equal(filas(html).length, 5);
  });

  it("las notas también salen limpias para la impresora", () => {
    const order = pedidoSinNotas();
    order.notes = "Sin cebolla, por favor — thanks";
    order.items[1].notes = "Más picante 🌶";
    const html = buildComandaHtml(order);
    assertSoloAscii(html);
    const t = texto(html);
    assert.match(t, /\* Mas picante/);
    assert.match(t, /NOTA: Sin cebolla, por favor - thanks/);
  });

  it("termina con varias líneas en blanco para que no se pegue al trabajo siguiente", () => {
    // El driver convierte el HTML a texto y descarta los espacios del final: sin
    // un pie de líneas en blanco, la última línea real de la comanda queda
    // retenida en el papel y el trabajo siguiente arranca pegado a ella
    // ("...tu pedido!FUSION WOK"). Con dos comandas seguidas se lee una sola.
    const html = buildComandaHtml(pedido());
    assert.ok(
      lineasDeRelleno(html) >= 3,
      `la comanda tiene que terminar con al menos 3 líneas en blanco, tiene ${lineasDeRelleno(html)}`,
    );
  });

  it("el pie de relleno no mete caracteres fuera del ASCII", () => {
    // El pie está escrito a mano en la plantilla, no pasa por
    // sanitizeForPrinter(): si se le cuela un espacio duro (U+00A0) o una raya,
    // el driver chino lo convierte en ideograma y el pie del papel sale con
    // basura justo donde se lee el primer renglón del trabajo siguiente.
    assertSoloAscii(buildComandaHtml(pedido()));
  });
});

describe("buildTicketHtml", () => {
  it("sí imprime el mensaje de gracias", () => {
    // El ticket es el que va en la bolsa: el texto de cortesía va acá y no en
    // la comanda.
    assert.match(buildTicketHtml(pedido()), /Gracias por tu pedido!/);
  });

  it("no deja ningún carácter fuera del ASCII imprimible", () => {
    assertSoloAscii(buildTicketHtml(pedido()));
  });

  it("limpia los rótulos y los datos con tilde", () => {
    const t = texto(buildTicketHtml(pedido()));
    assert.match(t, /FUSION WOK/);
    assert.match(t, /Direccion: Cuba 1173/);
    assert.match(t, /Cliente: Maria Gomez/);
    assert.match(t, /En elaboracion/);
    assert.match(t, /Observacion: llamar antes/);
    assert.doesNotMatch(t, /FUSIÓN|Dirección|María|elaboración|Observación/);
  });

  it("ordena los ítems de mayor a menor cantidad", () => {
    const t = texto(buildTicketHtml(pedido()));
    assert.ok(
      t.indexOf("Gyozas de cerdo") < t.indexOf("Salsa picante"),
      `Gyozas (3) tiene que ir antes que Salsa (2): ${t}`,
    );
    assert.ok(
      t.indexOf("Salsa picante") < t.indexOf("Mein pollo"),
      `Salsa (2) tiene que ir antes que Mein pollo (1): ${t}`,
    );
    assert.ok(
      t.indexOf("Mein pollo") < t.indexOf("Mein mixto"),
      `los dos de cantidad 1 mantienen el orden del pedido: ${t}`,
    );
  });

  it("el precio total de cada ítem viaja con su producto", () => {
    // Si el precio se despegara del renglón, el cliente vería la cantidad de un
    // plato con el precio de otro.
    const html = buildTicketHtml(pedido());
    assert.match(filaDe(html, "Gyozas de cerdo"), /36\.000/); // 3 x 12.000
    assert.match(filaDe(html, "Salsa picante"), /3\.000/); // 2 x 1.500
    assert.match(filaDe(html, "Mein pollo"), /18\.900/);
    assert.match(filaDe(html, "Mein mixto"), /21\.000/);
  });

  it("la variante y su precio quedan en la fila de al lado del producto", () => {
    const html = buildTicketHtml(pedido());
    const fila = filaDe(html, "Extra queso");
    assert.match(fila, /2\.000/);
    assert.doesNotMatch(fila, /Gyozas|Salsa picante/);
  });

  it("la cantidad va con 'x' cuando hay más de una unidad", () => {
    const t = texto(buildTicketHtml(pedido()));
    assert.match(t, /Gyozas de cerdo x 3/);
    assert.doesNotMatch(t, /Mein pollo x/);
  });

  it("el total del pedido se imprime con el símbolo de moneda", () => {
    const t = texto(buildTicketHtml(pedido()));
    assert.match(t, /TOTAL \$ 80\.900/);
  });

  it("imprime la línea de Envío solo si es delivery con costo", () => {
    // El ticket tiene que leer los datos ACTUALES del pedido: si el envío se
    // descuenta al pasar a mostrador, esa línea desaparece del papel. La fila
    // sale de la proyección real (toPublicOrder sobre la fila de la base).
    const conEnvio = toPublicOrder({ ...filaPedido(), shipping: 4000, shipping_km: 20 });
    const t = texto(buildTicketHtml(conEnvio));
    assert.match(t, /Envio: \$ 4\.000/);
    // Y además va como fila antes del TOTAL, para que el papel cierre.
    assert.ok(
      t.lastIndexOf("Envio") > 0 && t.lastIndexOf("Envio") < t.indexOf("TOTAL $ 80.900"),
      `la fila Envio tiene que ir antes del TOTAL: ${t}`,
    );

    const mostrador = toPublicOrder({ ...filaPedido(), order_mode: "pickup", address: "" });
    const tm = texto(buildTicketHtml(mostrador));
    assert.doesNotMatch(tm, /Envio/);
    assert.doesNotMatch(tm, /Direccion/);
    assert.match(tm, /RETIRO/);
  });

  it("delivery con envío pendiente imprime 'Envio: a confirmar' en vez del monto", () => {
    // Cuando la cotización automática falló, el pedido queda con costo 0 y el
    // flag shipping_pending: el papel NO puede mostrar un monto mentiroso.
    const pendiente = toPublicOrder({ ...filaPedido(), shipping: 0, shipping_pending: 1 });
    const t = texto(buildTicketHtml(pendiente));
    assert.match(t, /Envio a confirmar/);
    assert.doesNotMatch(t, /Envio: \$/);
  });

  it("delivery sin costo de envío no imprime la línea de Envío", () => {
    // El fixture no trae shipping: es el caso de un pedido delivery cuyo
    // envío todavía no se cargó. Sin cargo, no hay renglón que escribir.
    const t = texto(buildTicketHtml(pedido()));
    assert.doesNotMatch(t, /Envio/);
    assert.match(t, /Direccion: Cuba 1173/);
  });

  it("no cambia el orden guardado en el pedido", () => {
    const order = pedido();
    buildTicketHtml(order);
    assert.deepEqual(
      order.items.map((it) => it.name),
      ["Mein pollo", "Salsa picante", "Mein mixto", "Gyozas de cerdo"],
    );
  });

  it("sigue mostrando sus notas como siempre: el NOTA: con * es solo de la comanda", () => {
    // El ticket conserva sus rótulos ("Nota:" por ítem y "Observaciones de
    // entrega"), no adoptó los de la comanda.
    const t = texto(buildTicketHtml(pedido()));
    assert.match(t, /Nota: sin cebolla/);
    assert.match(t, /Observaciones de entrega: Observacion: llamar antes/);
    assert.doesNotMatch(t, /NOTA:/);
    assert.doesNotMatch(t, /\*/);
  });

  it("termina con varias líneas en blanco para que no se pegue al trabajo siguiente", () => {
    // Mismo problema que en la comanda: el driver tira los espacios del final,
    // así que sin un pie de líneas en blanco "Gracias por tu pedido!" queda
    // retenido y el ticket siguiente arranca pegado a esa línea.
    const html = buildTicketHtml(pedido());
    assert.ok(
      lineasDeRelleno(html) >= 3,
      `el ticket tiene que terminar con al menos 3 líneas en blanco, tiene ${lineasDeRelleno(html)}`,
    );
  });

  it("el pie de relleno no mete caracteres fuera del ASCII", () => {
    // El pie está escrito a mano en la plantilla y no pasa por
    // sanitizeForPrinter(): un espacio duro (U+00A0) o una raya ahí vuelven a
    // imprimir ideogramas en el borde del papel.
    assertSoloAscii(buildTicketHtml(pedido()));
  });
});