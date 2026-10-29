import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// La ventana de impresión (src/components/TicketPrint.jsx): abre una pestaña
// en blanco, le escribe el documento y dispara print().
//
// El componente es JSX y el runner del repo es node:test nativo, que no parsea
// JSX. Agregar un transformador o jsdom solo para testear seis líneas sería
// meter una dependencia nueva, así que el guard va sobre el texto de la fuente:
// el bug es del ciclo de vida de la ventana, no de la lógica de impresión.

const fuente = readFileSync(
  new URL("../src/components/TicketPrint.jsx", import.meta.url),
  "utf8",
);

describe("TicketPrint", () => {
  // Entre write() y el cierre puede haber un comentario: lo que no puede cambiar
  // es la sentencia de cierre. El patrón de "hueco" acepta espacios y
  // comentarios de una línea, así que un win.close() escondido detrás de un
  // comentario tampoco pasa.
  const HUECO = /(?:(?:\/\/[^\n]*)?\s)*/;

  it("cierra el documento con document.close() antes de imprimir", () => {
    // window.close() después de document.write() destruye la ventana recién
    // escrita: el focus() y el print() de abajo caen sobre una ventana cerrada
    // y no sale nada. Con document.close() lo que se cierra es el documento,
    // que es lo que termina de escribir, y la ventana queda viva para imprimir.
    assert.match(
      fuente,
      new RegExp(`win\\.document\\.write\\([^;]*\\);${HUECO.source}win\\.document\\.close\\(\\);`),
      "después de write() tiene que ir document.close(), no window.close()",
    );
    assert.doesNotMatch(
      fuente,
      new RegExp(`document\\.write\\([^;]*\\);${HUECO.source}win\\.close\\(\\)`),
      "no se puede cerrar la ventana de impresión antes de llamar a print()",
    );
  });

  it("no imprime nada si el navegador bloquea la ventana", () => {
    // Si window.open() devuelve null (emergentes bloqueados) el componente avisa
    // y avienta en vez de seguir y romper la página entera.
    assert.match(fuente, /if \(!win\) \{/);
  });
});