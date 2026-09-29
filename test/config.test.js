import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, isProduction, isDemo, MIN_WEBHOOK_SECRET_LENGTH } from "../server/config.js";

// ---------------------------------------------------------------------
// LA REGRESION (2b/2c): al arrancar, el secret del webhook de MP ya estaba
// en 8 caracteres ("un secret de ejemplo"). validateConfig lo reportaba como
// un WARNING yseguia: el proceso levantaba, deployaba, y el webhook
// rechazaba TODAS las notificaciones silenciosamente. Todo reembolso que
// MP mandara por webhook se perdia y nadie se enteraba hasta buscar el
// pedido.
//
// En produccion eso tiene que PARAR el arranque, no avisar. En dev/test los
// tests y `npm run verify` tienen que seguir levantando sin credenciales
// reales, asi que ahi solo avisa.
// ---------------------------------------------------------------------

const SECRET_OK = "a".repeat(MIN_WEBHOOK_SECRET_LENGTH);

function prod(over = {}) {
  return {
    NODE_ENV: "production",
    DEMO_MODE: "false",
    MP_ACCESS_TOKEN: "APP_USR-1234567890",
    MP_WEBHOOK_SECRET: SECRET_OK,
    ADMIN_PASSWORD: "UnaClaveLargaYSegura1!",
    TURSO_DATABASE_URL: "libsql://fusionwok-org.turso.io",
    TURSO_AUTH_TOKEN: "eyJhbGciOiJIUzI1NiJ9.token",
    ...over,
  };
}

describe("modo del entorno", () => {
  it("produccion es NODE_ENV=production o DEMO_MODE=false explicito", () => {
    assert.equal(isProduction({ NODE_ENV: "production" }), true);
    assert.equal(isProduction({ DEMO_MODE: "false" }), true);
    assert.equal(isProduction({ NODE_ENV: "production", DEMO_MODE: "true" }), false, "DEMO_MODE manda");
    assert.equal(isProduction({ NODE_ENV: "development" }), false);
    assert.equal(isProduction({}), false);
  });

  it("demo es DEMO_MODE=true o falta el access token de MP", () => {
    assert.equal(isDemo({ DEMO_MODE: "true" }), true);
    assert.equal(isDemo({}), true, "sin token de MP la app corre en demo");
    assert.equal(isDemo({ MP_ACCESS_TOKEN: "APP_USR-1" }), false);
  });
});

describe("secret del webhook (2b)", () => {
  it("en produccion, un secret corto ABORTA el arranque", () => {
    const r = validateConfig(prod({ MP_WEBHOOK_SECRET: "ochochars" }));
    assert.equal(r.fatal, true, "tenia que ser fatal, no un warning");
    assert.match(r.problems.join(" "), /MP_WEBHOOK_SECRET/);
  });

  it("en produccion, el secret de ejemplo que hay hoy (.env) ABORTA", () => {
    // Este es el valor real que hay en .env hoy (8 chars).
    const r = validateConfig(prod({ MP_WEBHOOK_SECRET: "6e7js6wk" }));
    assert.equal(r.fatal, true);
    assert.match(r.problems.join(" "), /placeholder|corto/i);
  });

  it("en produccion, un secret de diccionario aunque sea largo ABORTA", () => {
    const r = validateConfig(prod({ MP_WEBHOOK_SECRET: "cambiame-esto-por-el-secret-real-de-mp-2026" }));
    assert.equal(r.fatal, true);
    assert.match(r.problems.join(" "), /placeholder/i);
  });

  it("en produccion, sin secret ABORTA", () => {
    const r = validateConfig(prod({ MP_WEBHOOK_SECRET: "" }));
    assert.equal(r.fatal, true);
    assert.match(r.problems.join(" "), /MP_WEBHOOK_SECRET/);
  });

  it("en produccion, un secret de 32+ caracteres al azar pasa", () => {
    const r = validateConfig(prod());
    assert.equal(r.fatal, false);
    assert.equal(r.problems.length, 0);
  });

  it("en dev, un secret corto NO corta: solo avisa (asi se puede probar)", () => {
    const r = validateConfig({ NODE_ENV: "development", MP_ACCESS_TOKEN: "TEST-123", MP_WEBHOOK_SECRET: "corto" });
    assert.equal(r.fatal, false);
    assert.equal(r.problems.length, 0);
    assert.match(r.warnings.join(" "), /MP_WEBHOOK_SECRET/);
  });

  it("en dev, un secret de ejemplo solo avisa, no corta", () => {
    const r = validateConfig({ NODE_ENV: "development", ADMIN_PASSWORD: "UnaClaveLargaYSegura1!", MP_WEBHOOK_SECRET: "ochochars" });
    assert.equal(r.fatal, false);
    assert.equal(r.warnings.length, 1);
  });

  it("en demo no se revisa el secret: no hay webhooks reales a los que firmar", () => {
    const r = validateConfig({
      NODE_ENV: "production",
      DEMO_MODE: "true",
      ADMIN_PASSWORD: "UnaClaveLargaYSegura1!",
      TURSO_DATABASE_URL: "libsql://fusionwok-org.turso.io",
      TURSO_AUTH_TOKEN: "eyJtoken",
      MP_WEBHOOK_SECRET: "",
    });
    assert.equal(r.fatal, false);
    assert.equal(r.warnings.length, 0);
  });
});

describe("credenciales obligatorias (2c)", () => {
  it("en produccion, sin ADMIN_PASSWORD arranca igual? NO: aborta", () => {
    assert.equal(validateConfig(prod({ ADMIN_PASSWORD: "" })).fatal, true);
    assert.equal(validateConfig(prod({ ADMIN_PASSWORD: "fusionwok" })).fatal, true, "el default publicado");
  });

  it("en produccion, sin URL de Turso aborta", () => {
    const r = validateConfig(prod({ TURSO_DATABASE_URL: "" }));
    assert.equal(r.fatal, true);
    assert.match(r.problems.join(" "), /TURSO_DATABASE_URL/);
  });

  it("en produccion, sin token de Turso aborta", () => {
    const r = validateConfig(prod({ TURSO_AUTH_TOKEN: "" }));
    assert.equal(r.fatal, true);
    assert.match(r.problems.join(" "), /TURSO_AUTH_TOKEN/);
  });

  it("en produccion, una base local (file:) aborta: la data no puede vivir en el server", () => {
    const r = validateConfig(prod({ TURSO_DATABASE_URL: "file:./local.db", TURSO_AUTH_TOKEN: "" }));
    assert.equal(r.fatal, true);
    assert.match(r.problems.join(" "), /Turso/);
  });

  it("en produccion, sin MP_ACCESS_TOKEN aborta: no puede caer a modo demo", () => {
    const r = validateConfig(prod({ MP_ACCESS_TOKEN: "", DEMO_MODE: "false" }));
    assert.equal(r.fatal, true, "producion no puede arrancar en modo demo");
    assert.match(r.problems.join(" "), /MP_ACCESS_TOKEN/);
  });

  it("en produccion, el problema se explica con el arreglo, no solo el nombre de la var", () => {
    const r = validateConfig(prod({ MP_WEBHOOK_SECRET: "corto" }));
    const problema = r.problems.find((p) => /MP_WEBHOOK_SECRET/.test(p));
    assert.match(problema, /Panel de MP|Webhooks/);
  });
});

describe("los tests y npm run verify levantan sin credenciales (2c)", () => {
  it("un env vacio no es fatal: es desarrollo, no produccion", () => {
    const r = validateConfig({});
    assert.equal(r.fatal, false);
    assert.equal(r.problems.length, 0, "no deberia quejarse de nada en dev");
  });

  it("dev con MP de prueba levanta aunque falte el secret del webhook", () => {
    const r = validateConfig({ NODE_ENV: "development", MP_ACCESS_TOKEN: "TEST-123", MP_WEBHOOK_SECRET: "" });
    assert.equal(r.fatal, false);
  });

  it("dev con la base local no se queja del token de Turso", () => {
    const r = validateConfig({ NODE_ENV: "development", TURSO_DATABASE_URL: "file::memory:" });
    assert.equal(r.fatal, false);
    assert.equal(r.problems.length, 0);
  });

  it("nunca lanza ni sale: solo devuelve el informe", () => {
    // validateConfig se llama en el arranque del server; si hiciera throw o
    // process.exit los tests no podrian ni inspeccionar el resultado.
    assert.doesNotThrow(() => validateConfig({ NODE_ENV: "production" }));
  });
});
