// ============================================================
// ValidaciÃƒÂ³n de configuraciÃƒÂ³n al arrancar.
//
// Fail-fast: si en producciÃƒÂ³n falta una variable obligatoria, el proceso
// muere acÃƒÂ¡ con un mensaje que dice QUÃƒâ€° falta y DÃƒâ€œNDE se arregla. La
// alternativa (arrancar "en modo roto" y esperar el primer cliente) convierte
// un error de deploy de 30 segundos en un pedido perdido.
//
// Por quÃƒÂ© una funciÃƒÂ³n pura y no cÃƒÂ³digo suelto en index.js: asÃƒÂ­ se puede
// probar CADA combinaciÃƒÂ³n de variables sin arrancar el server ni tocar la
// base real. `validateConfig` no lanza ni llama a process.exit: devuelve el
// informe y decide quien lo ejecuta (index.js).
//
// Tres modos, bien separados:
//   - producciÃƒÂ³n: NODE_ENV=production o DEMO_MODE=false explÃƒÂ­cito. AcÃƒÂ¡ un
//     problema IMPIDE arrancar.
//   - desarrollo: todo lo demÃƒÂ¡s. Los mismos problemas avisan pero no cortan,
//     asÃƒÂ­ se puede probar con .env.example sin credenciales.
//   - demo: DEMO_MODE=true o sin MP_ACCESS_TOKEN. No se chequea nada de MP
//     porque no hay webhooks reales a los que firmar.
// ============================================================

// El secret de MP es una cadena larga y aleatoria. 32 es el piso: cualquier
// valor mÃƒÂ¡s corto o de ejemplo no puede ser el real, y con uno falso el
// webhook firma distinto y rechaza TODAS las notificaciones.
export const MIN_WEBHOOK_SECRET_LENGTH = 32;

// Palabras que delatan un secret de ejemplo. Se buscan sobre el secret
// normalizado (minÃƒÂºsculas, solo alfanumÃƒÂ©ricos) para que "Cambiame-esto" y
// "cambiame_esto" caigan igual. Son palabras largas con letras que no son
// hex: un secret real generado al azar no puede contenerlas, asÃƒÂ­ que el
// chequeo no puede dar un falso positivo y frenar un deploy sano.
const PLACEHOLDER_FRAGMENTS = [
  "cambiame",
  "changeme",
  "placeholder",
  "ponetuaqui",
  "tusecret",
  "secretdeejemplo",
  "secretreal",
  "example",
  "abcdefgh",
  "12345678",
  "00000000",
];

// Mínimo del secret del cron externo (PAY-04): autentica el header
// X-Cron-Secret de POST /api/cron/reconcile. 24 caracteres hex = 96 bits
// para un secret que viaja por Internet con un rate limit de 6 intentos
// cada 10 min; más corto le regala margen a la fuerza bruta.
export const MIN_CRON_SECRET_LENGTH = 24;

// Por qué el secret del cron NO sirve, o "" si sirve. Mismo patrón que
// webhookSecretProblem: separa "falta" de "corto" porque el arreglo es
// distinto (hay que generarlo y pegarlo, vs. regenerarlo más largo).
// A diferencia del de MP, este NUNCA corta el arranque: CRON_SECRET es
// opcional y sin él el endpoint queda apagado (404) y el barrido lo
// dispara solo el timer interno de 15 min.
export function cronSecretProblem(secret) {
  const value = String(secret || "").trim();
  if (!value) return "falta";
  if (value.length < MIN_CRON_SECRET_LENGTH) return "corto";
  return "";
}

// Mismas reglas que isDemoMode() de mp.js, pero sobre un env pasado por
// parámetro para poder probarlas sin tocar process.env.
export function isDemo(env = process.env) {
  return env.DEMO_MODE === "true" || !env.MP_ACCESS_TOKEN;
}

export function isProduction(env = process.env) {
  // DEMO_MODE explÃƒÂ­cito gana: con DEMO_MODE=true alguien estÃƒÂ¡ probando aunque
  // NODE_ENV diga production (serve para docker-compose de pruebas).
  if (env.DEMO_MODE === "true") return false;
  return env.NODE_ENV === "production" || env.DEMO_MODE === "false";
}

function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Por quÃƒÂ© el secret NO sirve, o "" si sirve. Separa los tres casos porque el
// arreglo es distinto para cada uno: uno hay que copiarlo, otro hay que
// pegarlo, el otro hay que dejar de inventarlo.
export function webhookSecretProblem(secret) {
  const value = String(secret || "").trim();
  if (!value) return "falta";
  if (value.length < MIN_WEBHOOK_SECRET_LENGTH) return "corto";
  if (PLACEHOLDER_FRAGMENTS.some((w) => normalize(value).includes(w))) return "placeholder";
  return "";
}

// Devuelve { production, demo, problems, warnings, fatal }.
//   problems: en producciÃƒÂ³n impiden arrancar. En desarrollo nunca se llenan.
//   warnings: avisan pero dejan arrancar (para probar sin credenciales).
//   fatal:    problems.length > 0 y estamos en producciÃƒÂ³n.
export function validateConfig(env = process.env) {
  const production = isProduction(env);
  const demo = isDemo(env);
  const problems = [];
  const warnings = [];

  // Anotar: en producciÃƒÂ³n aborta, en desarrollo avisa.
  const REQUIRED = (ok, message) => {
    if (ok) return;
    (production ? problems : warnings).push(message);
  };

  // ---------- base de datos (Turso) ----------
  const url = String(env.TURSO_DATABASE_URL || "").trim();
  if (!url) {
    REQUIRED(
      false,
      "Falta TURSO_DATABASE_URL: la base de FusiÃƒÂ³n Wok corre en Turso y no hay fallback local."
    );
  } else if (/^file:/i.test(url)) {
    // En dev vale (las pruebas usan file::memory:), pero en producciÃƒÂ³n los
    // datos vivirÃƒÂ­an en el disco del contenedor y se perderÃƒÂ­an en cada deploy.
    REQUIRED(
      false,
      "TURSO_DATABASE_URL es una base local (file:): en producciÃƒÂ³n los datos se pierden en cada deploy. " +
        "UsÃƒÂ¡ la URL de Turso (turso db show --url)."
    );
  } else if (!String(env.TURSO_AUTH_TOKEN || "").trim()) {
    REQUIRED(false, "Falta TURSO_AUTH_TOKEN: sin token Turso rechaza la conexiÃƒÂ³n a la base.");
  }

  // ---------- Mercado Pago ----------
  if (demo) {
    // Sin token, isDemoMode() devuelve true y la app "funciona" sin cobrar.
    // En producciÃƒÂ³n eso es lo peor que puede pasar: el sitio queda entero y
    // nadie cobra. Se corta acÃƒÂ¡ en vez de dejarlo pasar.
    if (production) {
      problems.push(
        "Falta MP_ACCESS_TOKEN y el arranque caerÃƒÂ­a en modo DEMO: en producciÃƒÂ³n no se puede publicar " +
          "una tienda que no cobra. Panel de MP Ã¢â€ â€™ tu app Ã¢â€ â€™ Credenciales Ã¢â€ â€™ copiar el Access Token."
      );
    }
  } else {
    const secretProblem = webhookSecretProblem(env.MP_WEBHOOK_SECRET);
    if (secretProblem) {
      const detalle = {
        falta: "no estÃƒÂ¡ configurado",
        corto: `es demasiado corto (${String(env.MP_WEBHOOK_SECRET || "").trim().length} caracteres; mÃƒÂ­nimo ${MIN_WEBHOOK_SECRET_LENGTH})`,
        placeholder: "es un valor de ejemplo (placeholder)",
      }[secretProblem];
      problems.push(
        `MP_WEBHOOK_SECRET ${detalle}: el webhook firmarÃƒÂ­a distinto y rechazarÃƒÂ­a TODAS las notificaciones de MP, ` +
          "dejando los pagos aprobados colgados y perdiendo los reembolsos. " +
          "CopiÃƒÂ¡ el secret real desde el panel de MP Ã¢â€ â€™ tu app Ã¢â€ â€™ Webhooks."
      );
      if (!production) warnings.push(problems.pop());
    }
  }

  // ---------- panel admin ----------
  // La contraseÃƒÂ±a por defecto ("fusionwok") quedÃƒÂ³ publicada como ejemplo en
  // .env.example y en el README: con esa contraseÃƒÂ±a, cualquiera que abra /admin
  // entra al panel.
  const password = String(env.ADMIN_PASSWORD || "");
  if (!password || password === "fusionwok") {
    REQUIRED(
      false,
      'ADMIN_PASSWORD sin configurar o con el valor por defecto ("fusionwok"): /admin quedarÃƒÂ­a abierto a cualquiera.'
    );
  }

  // ---------- barrido de reconciliación (cron externo, PAY-04) ----------
  // CRON_SECRET autentica el header X-Cron-Secret de POST /api/cron/reconcile.
  // Es OPCIONAL y nunca corta el arranque (ni en producción): sin él (o
  // corto), el endpoint queda apagado (404) y el barrido lo sigue
  // disparando el timer interno de 15 min. Este warning es el aviso único
  // que se loguea al arrancar; nunca imprime el valor del secret.
  const cronProblem = cronSecretProblem(env.CRON_SECRET);
  if (cronProblem) {
    const detalle = {
      falta: "no está configurado",
      corto: `es demasiado corto (${String(env.CRON_SECRET || "").trim().length} caracteres; mínimo ${MIN_CRON_SECRET_LENGTH})`,
    }[cronProblem];
    warnings.push(
      `CRON_SECRET ${detalle}: el endpoint de barrido POST /api/cron/reconcile queda apagado (404) ` +
        "y la reconciliación la dispara solo el timer interno de 15 min. Para habilitarlo, generá un secret " +
        `de ${MIN_CRON_SECRET_LENGTH}+ caracteres con: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
    );
  }

  return { production, demo, problems, warnings, fatal: production && problems.length > 0 };
}
