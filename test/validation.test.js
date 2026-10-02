import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidPhone, isValidEmail, isValidIdentification, IDENTIFICATION_TYPES } from "../src/utils/validation.js";

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

// ============================================================
// Identificación del comprador: viaja a MP como payer.identification
// {type, number}. Los tipos y los largos son los que devuelve la API real
// de MP para Argentina (GET /v1/identification_types con credenciales de
// prueba, 2026-10-02): DNI (7-8), CI (1-9), LC (6-7), LE (6-7), Otro (5-20).
// Es dato sensible: no se persiste ni se loguea, solo se valida acá y pasa
// directo al body de la order.
// ============================================================
describe("isValidIdentification", () => {
  it("acepta un DNI de 7 digitos (limite inferior)", () => {
    assert.equal(isValidIdentification("DNI", "1234567"), true);
  });

  it("acepta un DNI de 8 digitos (limite superior)", () => {
    assert.equal(isValidIdentification("DNI", "12345678"), true);
  });

  it("acepta un DNI con puntos y espacios: los normaliza a digitos", () => {
    assert.equal(isValidIdentification("DNI", "12.345.678"), true);
  });

  it("rechaza un DNI de 6 digitos", () => {
    assert.equal(isValidIdentification("DNI", "123456"), false);
  });

  it("rechaza un DNI de 9 digitos", () => {
    assert.equal(isValidIdentification("DNI", "123456789"), false);
  });

  it("aceputa una cedula de 1 a 9 digitos (CI)", () => {
    assert.equal(isValidIdentification("CI", "123456789"), true);
    assert.equal(isValidIdentification("CI", "1"), true);
  });

  it("acepta LC y LE de 6 a 7 digitos", () => {
    assert.equal(isValidIdentification("LC", "123456"), true);
    assert.equal(isValidIdentification("LE", "1234567"), true);
    assert.equal(isValidIdentification("LC", "12345"), false);
  });

  it("acepta Otro de 5 a 20 digitos", () => {
    assert.equal(isValidIdentification("Otro", "12345"), true);
    assert.equal(isValidIdentification("Otro", "1".repeat(20)), true);
    assert.equal(isValidIdentification("Otro", "1".repeat(21)), false);
  });

  it("rechaza tipos que no son de la lista de MP", () => {
    assert.equal(isValidIdentification("PASAPORTE", "12345678"), false);
    assert.equal(isValidIdentification("CUIT", "20345678901"), false);
  });

  it("rechaza letras en el numero", () => {
    assert.equal(isValidIdentification("DNI", "12.34A678"), false);
  });

  it("sin tipo o sin numero, no hay identificacion: lo devuelve como vacio", () => {
    assert.equal(isValidIdentification("", "12345678"), false);
    assert.equal(isValidIdentification("DNI", ""), false);
    assert.equal(isValidIdentification(null, "12345678"), false);
    assert.equal(isValidIdentification("DNI", null), false);
  });

  it("la tabla de tipos es la que devuelve la API de MP para AR", () => {
    assert.deepEqual(Object.keys(IDENTIFICATION_TYPES).sort(), ["CI", "DNI", "LC", "LE", "Otro"]);
  });
});
