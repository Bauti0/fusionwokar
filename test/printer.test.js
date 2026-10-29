import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeForPrinter, sortItemsByQty } from "../src/utils/printer.js";

// El ticket y la comanda salen por el driver de la impresora térmica, que en
// modo "carácter chino de doble byte" combina cualquier byte no ASCII con el
// que viene después. Por eso el papel decía "FUSI觀 WOK", "Tandil 集Chacabuco",
// "Direcci髓:", "Pedido online 耗" y "1識amen Naruto": no era un error de
// codificación del texto, sino que se mandaban bytes que la impresora no sabe
// representar. Estos tests fijan qué texto llega a la impresora.

describe("sanitizeForPrinter", () => {
  it("saca la tilde de los rótulos impresos", () => {
    assert.equal(sanitizeForPrinter("Dirección"), "Direccion");
  });

  it("saca la eñe y las tildes de la marca y de los productos", () => {
    assert.equal(sanitizeForPrinter("Fusión Wok"), "Fusion Wok");
    assert.equal(sanitizeForPrinter("ningún extras"), "ningun extras");
  });

  it("convierte el signo de multiplicación en una x", () => {
    assert.equal(sanitizeForPrinter("Ramen × 2"), "Ramen x 2");
  });

  it("quita el signo de apertura de las frases de cortesía", () => {
    // "¡Gracias!" salía como "Â¡Gracias!": el Â es el byte anterior mezclado.
    assert.equal(sanitizeForPrinter("¡Gracias!"), "Gracias!");
    assert.equal(sanitizeForPrinter("¿Algo más?"), "Algo mas?");
  });

  it("convierte los guiones largos y los puntos medio enguion", () => {
    assert.equal(sanitizeForPrinter("Tandil — Chacabuco"), "Tandil - Chacabuco");
    assert.equal(sanitizeForPrinter("Necochea – San Martín"), "Necochea - San Martin");
    assert.equal(sanitizeForPrinter("Pedido online · 10:00"), "Pedido online - 10:00");
    assert.equal(sanitizeForPrinter("Salsa • picante"), "Salsa - picante");
  });

  it("limpia los textos que en el papel salían con ideogramas", () => {
    // Estos son los datos reales que la impresora combinaba con el carácter
    // siguiente. Cada caso es el texto tal como está guardado + lo que salía.
    assert.equal(sanitizeForPrinter("FUSIÓN WOK"), "FUSION WOK"); // salía FUSI觀 WOK
    assert.equal(sanitizeForPrinter("Tandil — Chacabuco 660, Tandil"), "Tandil - Chacabuco 660, Tandil"); // salía Tandil 集Chacabuco
    assert.equal(sanitizeForPrinter("Dirección: Cuba 1173"), "Direccion: Cuba 1173"); // salía Direcci髓: Cuba 1173
    // Ojo: el × se cambia por "x" sin agregar espacios. El espacio alrededor
    // ("1 x Ramen") lo pone el template de la comanda, no el limpiador: acá
    // solo se traduce el símbolo.
    assert.equal(sanitizeForPrinter("1× Ramen Naruto"), "1x Ramen Naruto"); // salía 1識amen Naruto
  });

  it("borra un ideograma que venga pegado en el dato (nota del cliente)", () => {
    // Las notas son texto libre: si alguien pega un ideograma, en el papel
    // tiene que salir un hueco, no un ideograma.
    assert.equal(sanitizeForPrinter("Ramen 熱"), "Ramen ");
  });

  it("deja solo el texto: el ideograma final se va pero el espacio no", () => {
    // "Pedido online 耗" salía con el símbolo sobrante al final. La limpieza
    // borra el carácter, no recorta la cadena: el espacio ya estaba en el
    // original y las plantillas dependen de él para separar los campos.
    assert.equal(sanitizeForPrinter("Pedido online 耗"), "Pedido online ");
  });

  it("convierte las comillas tipográficas en comillas ASCII", () => {
    assert.equal(sanitizeForPrinter("“Ramen”"), '"Ramen"');
    assert.equal(sanitizeForPrinter("‘Picante’"), "'Picante'");
  });

  it("borra los emojis y los selectores de variación que quedan sueltos", () => {
    // Regresión de 8c28501: los emojis ya no imprimían nada, pero el selector
    // de variación (U+FE0F) y el ZWJ se colaban como caracteres raros.
    assert.equal(sanitizeForPrinter("Ramen 🍜"), "Ramen ");
    assert.equal(sanitizeForPrinter("Empanada ❤️"), "Empanada ");
    assert.equal(sanitizeForPrinter("Chef 👨‍🍳"), "Chef ");
  });

  it("convierte los espacios que no son ASCII en un espacio normal", () => {
    // El precio sale de Intl con un espacio duro entre el $ y el número
    // ("$\u00A036.000") y la fecha con un espacio finísimo antes de "a. m."
    // ("10:05\u202Fa. m.") en Chrome. Con esos bytes la impresora sigue
    // combining caracteres, así que el espacio se normaliza y se conserva.
    assert.equal(sanitizeForPrinter("$\u00A036.000"), "$ 36.000");
    assert.equal(sanitizeForPrinter("10:05\u202Fa. m."), "10:05 a. m.");
  });

  it("conserva los saltos de línea", () => {
    // El texto se arma por líneas; si se perdieran, todo el ticket saldría
    // pegado en un párrafo.
    assert.equal(sanitizeForPrinter("Mein pollo\nSalsa picante"), "Mein pollo\nSalsa picante");
  });

  it("no deja ningún carácter fuera del ASCII imprimible", () => {
    // Este es el contrato que sostiene todo lo demás: la impresora no puede
    // representar nada fuera de 0x20-0x7E salvo el salto de línea.
    const sucio = "Fusión Wok — Ñandú · 熱 · ©\u0007 10€";
    // Los caracteres que se borran dejan el espacio que ya estaba alrededor: la
    // limpieza no recorta ni junta espacios, así los campos siguen separados.
    assert.equal(sanitizeForPrinter(sucio), "Fusion Wok - Nandu -  -  10");
    for (const ch of sanitizeForPrinter(sucio)) {
      const code = ch.charCodeAt(0);
      assert.ok(code === 0x0a || (code >= 0x20 && code <= 0x7e), `carácter no ASCII: ${ch}`);
    }
  });

  it("devuelve cadena vacía ante null, undefined o número", () => {
    assert.equal(sanitizeForPrinter(null), "");
    assert.equal(sanitizeForPrinter(undefined), "");
    assert.equal(sanitizeForPrinter(7), "7");
  });

  it("no rompe el escapado de HTML: el texto limpio sigue sin caracteres peligrosos", () => {
    // El escapado de HTML va DESPUÉS de la limpieza; si la limpieza metiera
    // < o &, el escapado los convertiría en texto visible en el ticket.
    assert.equal(sanitizeForPrinter("<script>alert(1)</script>"), "<script>alert(1)</script>");
  });
});

// Un ítem con la forma que devuelve la API (ver POST /api/orders).
function item(name, qty, extra = {}) {
  return { productId: `p-${name}`, name, qty, unitPrice: 10000, extras: [], notes: "", ...extra };
}

describe("sortItemsByQty", () => {
  it("ordena de mayor a menor cantidad", () => {
    // El caso del pedido real: la cocina lee primero lo que más veces se pidió.
    const items = [item("Mein pollo", 1), item("Salsa picante", 2), item("Mein mixto", 1)];
    const ordenados = sortItemsByQty(items);
    assert.deepEqual(
      ordenados.map((it) => it.name),
      ["Salsa picante", "Mein pollo", "Mein mixto"],
    );
  });

  it("ordena bien con tres o más cantidades distintas", () => {
    const items = [item("a", 1), item("b", 5), item("c", 3), item("d", 2)];
    assert.deepEqual(
      sortItemsByQty(items).map((it) => it.name),
      ["b", "c", "d", "a"],
    );
  });

  it("en los empates mantiene el orden original", () => {
    // Estable a propósito: si dos platos están igual, la cocina los quiere en
    // el orden en que los pidió el cliente, no en uno arbitrario.
    const items = [item("Mein pollo", 2), item("Gyoza", 1), item("Salsa picante", 2), item("Baos", 1), item("Empanada", 2)];
    assert.deepEqual(
      sortItemsByQty(items).map((it) => it.name),
      ["Mein pollo", "Salsa picante", "Empanada", "Gyoza", "Baos"],
    );
  });

  it("mueve cada ítem junto con sus variantes, notas y precio", () => {
    // Si el precio o la nota quedaran atrás, el ticket mostraría la cantidad
    // de un plato con el precio de otro.
    const items = [
      item("Mein pollo", 1),
      item("Wok", 3, { extras: [{ id: "s", label: "Salsa picante", price: 1500 }], notes: "sin cebolla" }),
    ];
    const ordenados = sortItemsByQty(items);
    assert.equal(ordenados[0].name, "Wok");
    assert.equal(ordenados[0].extras[0].label, "Salsa picante");
    assert.equal(ordenados[0].notes, "sin cebolla");
    assert.equal(ordenados[0].unitPrice, 10000);
  });

  it("no modifica el array original (el orden de la base de datos queda igual)", () => {
    const items = [item("a", 1), item("b", 2)];
    sortItemsByQty(items);
    assert.deepEqual(
      items.map((it) => it.name),
      ["a", "b"],
    );
  });

  it("los ítems sin cantidad válida van al final sin desordenar el resto", () => {
    // Una cantidad en null no puede romper el sort (NaN en el comparador).
    const items = [item("sin qty", null), item("b", 2), item("a", 1)];
    assert.deepEqual(
      sortItemsByQty(items).map((it) => it.name),
      ["b", "a", "sin qty"],
    );
  });

  it("acepta la cantidad como texto (así puede venir de la base)", () => {
    assert.deepEqual(
      sortItemsByQty([item("a", "1"), item("b", "3")]).map((it) => it.name),
      ["b", "a"],
    );
  });

  it("con un solo ítem devuelve ese ítem", () => {
    const unico = item("solo", 1);
    assert.deepEqual(sortItemsByQty([unico]), [unico]);
  });

  it("con la lista vacía devuelve la lista vacía", () => {
    assert.deepEqual(sortItemsByQty([]), []);
  });
});