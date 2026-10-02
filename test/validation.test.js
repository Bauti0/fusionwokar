import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidPhone, isValidEmail } from "../src/utils/validation.js";

// isValidPhone es compartido: el server lo usa en index.js:~724 para admitir o
// rechazar el pedido. Estos tests fijan la regla de admision, no solo la del
// formulario, asi que un cliente nunca deberia ver un telefono aceptado en
// pantalla y rechazado al enviar.
describe("isValidPhone", () => {
  it("acepta un celular de 10 digitos", () => {
    assert.equal(isValidPhone("2262555555"), true);
  });

  it("acepta espacios y guiones", () => {
    assert.equal(isValidPhone("02262 55-5555"), true);
  });

  it("acepta el prefijo internacional", () => {
    assert.equal(isValidPhone("+54 9 2262 555555"), true);
  });

  it("acepta parentesis", () => {
    assert.equal(isValidPhone("(02262) 555555"), true);
  });

  it("hacia 8 digitosExactamente: es el limite inferior", () => {
    assert.equal(isValidPhone("12345678"), true);
  });

  it("acepta hasta 15 digitos exactamente: es el limite superior", () => {
    assert.equal(isValidPhone("123456789012345"), true);
  });

  it("rechaza 7 digitos: uno menos que el minimo", () => {
    assert.equal(isValidPhone("1234567"), false);
  });

  it("rechaza 16 digitos: uno mas que el maximo", () => {
    assert.equal(isValidPhone("1234567890123456"), false);
  });

  it("rechaza letras", () => {
    assert.equal(isValidPhone("2262abc555"), false);
  });

  it("rechaza simbolos no contemplados", () => {
    assert.equal(isValidPhone("2262/5555"), false);
  });

  it("rechaza el vacio", () => {
    assert.equal(isValidPhone(""), false);
  });

  it("rechaza null y undefined sin tirar", () => {
    assert.equal(isValidPhone(null), false);
    assert.equal(isValidPhone(undefined), false);
  });

  it("solo espacios no cuenta como un telefono", () => {
    assert.equal(isValidPhone("   "), false);
  });

  it("no le importa el espacio alrededor", () => {
    assert.equal(isValidPhone("  2262555555  "), true);
  });
});

// isValidEmail es compartido (como isValidPhone): el server lo usa en
// validateOrderBody para aceptar o rechazar el pedido, y el checkout para
// frenar el submit antes de viajar. La regla de admisión es la MISMA en
// ambos lados, así que lo que pasa en pantalla también pasa en el server.
describe("isValidEmail", () => {
  it("acepta un email común", () => {
    assert.equal(isValidEmail("cliente@gmail.com"), true);
  });

  it("acepta guiones, puntos y subdominios", () => {
    assert.equal(isValidEmail("juan.perez@mail.corp.com.ar"), true);
  });

  it("no le importa el espacio alrededor", () => {
    assert.equal(isValidEmail("  cliente@gmail.com  "), true);
  });

  it("rechaza el vacio", () => {
    assert.equal(isValidEmail(""), false);
  });

  it("rechaza solo espacios", () => {
    assert.equal(isValidEmail("   "), false);
  });

  it("rechaza null y undefined sin tirar", () => {
    assert.equal(isValidEmail(null), false);
    assert.equal(isValidEmail(undefined), false);
  });

  it("rechaza sin arroba", () => {
    assert.equal(isValidEmail("cliente.gmail.com"), false);
  });

  it("rechaza dominio sin punto", () => {
    assert.equal(isValidEmail("cliente@gmail"), false);
  });

  it("rechaza espacios internos", () => {
    assert.equal(isValidEmail("cliente@ gmail.com"), false);
  });

  it("rechaza doble arroba", () => {
    assert.equal(isValidEmail("cli@ente@gmail.com"), false);
  });

  it("rechaza mas de 100 caracteres: es el maximo que acepta MP", () => {
    const largo = "a".repeat(91) + "@gmail.com"; // 101 caracteres
    assert.equal(isValidEmail(largo), false);
  });

  it("acepta hasta 100 caracteres exactos", () => {
    const justo = "a".repeat(89) + "@gmail.com"; // 100 caracteres
    assert.equal(isValidEmail(justo), true);
  });
});
