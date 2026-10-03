import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BRANCHES, BRANCH_LIST, phonePlaceholderFor, DEFAULT_PHONE_PLACEHOLDER } from "../src/data/branches.js";

// El ejemplo del campo "Celular" estaba escrito a mano en cada formulario
// (checkout, landing, mis pedidos) con el código de área de Necochea, así que
// un cliente de Tandil veía "2262" al pedir su número. Estos tests fijan que
// cada sucursal muestre el suyo y que el fallback siga siendo el de Necochea,
// para el caso en que el componente todavía no sabe la sucursal.
describe("phonePlaceholderFor", () => {
  it("muestra el ejemplo de Necochea en Necochea", () => {
    assert.equal(phonePlaceholderFor("necochea"), "Ej: 2262 555555");
  });

  it("muestra el ejemplo de Tandil en Tandil", () => {
    assert.equal(phonePlaceholderFor("tandil"), "Ej: 249 4555555");
  });

  it("acepta el objeto de sucursal, no solo el id", () => {
    assert.equal(phonePlaceholderFor(BRANCHES.tandil), "Ej: 249 4555555");
    assert.equal(phonePlaceholderFor(BRANCHES.necochea), "Ej: 2262 555555");
  });

  it("cae en el ejemplo de Necochea si todavía no hay sucursal", () => {
    assert.equal(phonePlaceholderFor(null), DEFAULT_PHONE_PLACEHOLDER);
    assert.equal(phonePlaceholderFor(""), DEFAULT_PHONE_PLACEHOLDER);
  });

  it("cae en el ejemplo de Necochea si la sucursal no existe", () => {
    assert.equal(phonePlaceholderFor("olavarría"), DEFAULT_PHONE_PLACEHOLDER);
  });

  it("toda sucursal de BRANCH_LIST define su propio ejemplo", () => {
    for (const b of BRANCH_LIST) {
      assert.equal(typeof b.phonePlaceholder, "string", `${b.id} sin phonePlaceholder`);
      assert.notEqual(b.phonePlaceholder, "", `${b.id} con phonePlaceholder vacío`);
    }
  });
});