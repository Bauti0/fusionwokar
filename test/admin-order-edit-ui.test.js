import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Reglas de wiring del panel que no se pueden ejercer sin renderizar JSX
// (el runner es node:test nativo, sin jsdom): mism criterio que
// test/ticket-print.test.js, el guard va sobre el texto de la fuente.
//
// Cubren las dos invariantes de la edición de pedidos:
//   1) después de guardar manda el total del SERVIDOR, no la vista previa;
//   2) el ticket se arma con el pedido actual del momento del click,
//      nunca con una copia guardada al abrir el detalle.

const fuente = readFileSync(new URL("../src/components/AdminPanel.jsx", import.meta.url), "utf8");

describe("AdminPanel — edición de pedidos", () => {
  it("tras guardar, el detalle se refresca con la respuesta del servidor", () => {
    // Si se aplicara la vista previa local (o se quedara el objeto viejo),
    // el modal y el ticket mostrarían un total que la base no tiene.
    assert.match(
      fuente,
      /adminEditOrder\([^)]*\);(?:(?!setSelected)[\s\S]){0,400}setSelected\(res\.order\)/,
      "el resultado del PATCH tiene que pisar el detalle con res.order"
    );
    assert.doesNotMatch(
      fuente,
      /adminEditOrder\([\s\S]{0,400}setSelected\(selected\)/,
      "no se puede volver a mostrar el objeto anterior al guardado"
    );
  });

  it("imprime el pedido actual, no una copia vieja", () => {
    // El ticket se arma en el click con el `selected` vigente (que se
    // reemplazó al guardar); una copia guardada al abrir el detalle se
    // quedaría con el tipo de entrega y el total viejos.
    assert.match(fuente, /setPrintOrder\(selected\)/);
    assert.match(fuente, /setPrintComanda\(selected\)/);
    assert.doesNotMatch(fuente, /setPrintOrder\(order\)/);
  });
});
