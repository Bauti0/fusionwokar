// test/test-guard.test.js — Verifica que la guarda de entorno rechaza tests inseguros

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { assertSafeTestEnv } from "./db.js";

describe("test guard — assertSafeTestEnv", () => {
  const originalEnv = { ...process.env };

  after(() => {
    process.env = originalEnv;
  });

  it("pasa con entorno limpio (sin TURSO_DATABASE_URL)", () => {
    process.env.TURSO_DATABASE_URL = "";
    process.env.NODE_ENV = "development";
    process.env.DEMO_MODE = "true";
    assert.doesNotThrow(() => assertSafeTestEnv());
  });

  it("pasa con TURSO_DATABASE_URL=file::memory:", () => {
    process.env.TURSO_DATABASE_URL = "file::memory:";
    process.env.NODE_ENV = "development";
    assert.doesNotThrow(() => assertSafeTestEnv());
  });

  it("pasa con TURSO_DATABASE_URL=file:test.db", () => {
    process.env.TURSO_DATABASE_URL = "file:test.db";
    process.env.NODE_ENV = "development";
    assert.doesNotThrow(() => assertSafeTestEnv());
  });

  it("FALLA si TURSO_DATABASE_URL apunta a turso.io", () => {
    process.env.TURSO_DATABASE_URL = "libsql://mi-db.turso.io";
    process.env.NODE_ENV = "development";
    assert.throws(() => assertSafeTestEnv(), /host remoto/);
  });

  it("FALLA si TURSO_DATABASE_URL apunta a cualquier dominio no local", () => {
    process.env.TURSO_DATABASE_URL = "https://mi-base.planetscale.com";
    process.env.NODE_ENV = "development";
    assert.throws(() => assertSafeTestEnv(), /host remoto/);
  });

  it("FALLA si NODE_ENV=production", () => {
    process.env.TURSO_DATABASE_URL = "";
    process.env.NODE_ENV = "production";
    assert.throws(() => assertSafeTestEnv(), /prohibidos en NODE_ENV=production/);
  });

  it("FALLA si DEMO_MODE=false (producción implícita)", () => {
    process.env.TURSO_DATABASE_URL = "";
    process.env.NODE_ENV = "development";
    process.env.DEMO_MODE = "false";
    assert.throws(() => assertSafeTestEnv(), /prohibidos en NODE_ENV=production/);
  });
});