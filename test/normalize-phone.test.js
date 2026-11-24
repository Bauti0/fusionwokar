// ============================================================
// normalizePhone — Normalización de teléfonos compartida
// ============================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone } from "../src/utils/phone.js";

describe("normalizePhone", () => {
  it("normaliza teléfono con +54 y 9", () => {
    assert.equal(normalizePhone("+54 9 2262 123456"), "2262123456");
  });

  it("normaliza teléfono sin código de país", () => {
    assert.equal(normalizePhone("2262123456"), "2262123456");
  });

  it("normaliza teléfono con 0 inicial", () => {
    assert.equal(normalizePhone("02262 123456"), "2262123456");
  });

  it("normaliza teléfono con 15 inicial", () => {
    assert.equal(normalizePhone("15 2262 123456"), "2262123456");
  });

  it("normaliza teléfono con espacios y guiones", () => {
    assert.equal(normalizePhone("2262-123-456"), "2262123456");
    assert.equal(normalizePhone("(2262) 123456"), "2262123456");
  });

  it("devuelve string vacío para entrada vacía o nula", () => {
    assert.equal(normalizePhone(""), "");
    assert.equal(normalizePhone(null), "");
    assert.equal(normalizePhone(undefined), "");
  });

  it("trunca a últimos 10 dígitos si es más largo", () => {
    // 11 dígitos -> últimos 10
    assert.equal(normalizePhone("12262123456"), "2262123456");
  });

  it("mantiene menos de 10 dígitos como está (para validación posterior)", () => {
    assert.equal(normalizePhone("1234567"), "1234567");
  });

  it("formatos equivalentes de Argentina coinciden", () => {
    // +54 9 2262 123456 y 2262123456 deben normalizar a lo mismo
    assert.equal(normalizePhone("+54 9 2262 123456"), normalizePhone("2262123456"));
    // Con 0 inicial
    assert.equal(normalizePhone("02262 123456"), normalizePhone("2262123456"));
    // Con 15
    assert.equal(normalizePhone("15 2262 123456"), normalizePhone("2262123456"));
  });
});