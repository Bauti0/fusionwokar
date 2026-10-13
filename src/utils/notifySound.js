// ============================================================
// Alarma sonora de pedidos nuevos del panel admin.
// Generado con Web Audio API (dos tonos repetidos), sin depender
// de ningún archivo de audio externo.
//
// La alarma NO se corta sola: suena en bucle hasta stopNewOrderChime()
// (pedido visto, cancelado o desmontaje del panel). La lógica de QUÉ
// cuenta como "tiene que sonar" es pura y vive en orderAlarm.js.
// ============================================================

// --- Ajustes a mano ---
const VOLUME = 0.6; // ganancia pico (0.0 - 1.0); más alto satura
const WAVE_TYPE = "triangle"; // más audible en parlantes de PC que "sine"
const FREQ_HIGH = 880; // Hz, primer tono
const FREQ_LOW = 660; // Hz, segundo tono
const TONE_DURATION = 0.25; // segundos por tono
const SECOND_TONE_DELAY = 0.3; // hasta que arranca el segundo tono
const GAP_BETWEEN = 0.6; // pausa entre repeticiones (ajustable)
const ATTACK = 0.02; // rampa de entrada (evita golpe seco)
const VENTANA_SEGUNDOS = 120; // cuánto audio se programa por adelantado
const REPROGRAMAR_MS = 40000; // cada cuánto se completa la ventana
const STOP_RAMP = 0.03; // rampa de corte al parar (evita golpe seco)
// ----------------------

const CYCLE_DURATION = SECOND_TONE_DELAY + TONE_DURATION + GAP_BETWEEN;

let ctx = null;
// Gain maestro de la alarma actual: TODO lo programado pasa por acá,
// así stop() silencia cada ventana pendiente de un solo saque.
let master = null;
let sonando = false; // la alarma está pedida (start sin stop)
let generation = 0; // invalida timers y resumes de arranques viejos
let reprogramTimer = null;
// Fin de lo ya programado (reloj del AudioContext). La ventana siguiente
// arranca SIEMPRE ahí (o en currentTime, si ya pasó): nunca se pisan
// ciclos programados con ciclos nuevos.
let nextStartTime = 0;
let blockedCb = null;
let gestureHandler = null;

// ---------- estado del bloqueo por autoplay ----------

export function isOrderAlarmBlocked() {
  return sonando && (!ctx || ctx.state !== "running");
}

// Un solo suscriptor (el panel admin). Devuelve la función de baja.
export function onOrderAlarmBlocked(cb) {
  blockedCb = cb;
  return () => {
    if (blockedCb === cb) blockedCb = null;
  };
}

function notifyBlocked() {
  if (blockedCb) blockedCb(isOrderAlarmBlocked());
}

// ---------- API ----------

// Arranca la alarma (idempotente: si ya está activa no hace nada, así
// varios pedidos juntos suenan como UNA sola alarma).
export function playNewOrderChime() {
  if (sonando) return;
  sonando = true;
  arm(++generation);
}

// Corta TODO: audio programado, timer de reprogramación y listener de
// desbloqueo. No deja nada fantasma corriendo.
export function stopNewOrderChime() {
  sonando = false;
  generation++; // cualquier resume/timer viejo que llegue se descarta
  if (reprogramTimer) {
    clearTimeout(reprogramTimer);
    reprogramTimer = null;
  }
  desactivarDesbloqueo();
  nextStartTime = 0;
  if (master) {
    cortarMaster(master);
    master = null;
  }
  notifyBlocked();
}

// ---------- internals ----------

async function arm(myGen) {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* bloqueado por autoplay: queda el chip de "sonido desactivado" */
      }
    }
    // Mientras esperaba el resume pudo llegar un stop() o un re-arranque.
    if (!sonando || myGen !== generation) return;
    // Contexto todavía sin correr (sin interacción del usuario): no se
    // programa nada; el primer gesto re-intenta vía activarDesbloqueo().
    if (ctx.state !== "running") {
      activarDesbloqueo();
      notifyBlocked();
      return;
    }
    desactivarDesbloqueo();
    if (!master) master = ctx.createGain();
    programarVentana();
    reprogramar();
    notifyBlocked();
  } catch {
    /* audio no disponible (navegador viejo, etc.): la alarma queda off */
    sonando = false;
    notifyBlocked();
  }
}

// Programa ciclos sobre el reloj del AudioContext hasta VENTANA_SEGUNDOS
// por delante. El audio ya programado suena aunque el navegador relaje
// los timers del JS (pestaña en segundo plano).
function programarVentana() {
  const ahora = ctx.currentTime;
  if (nextStartTime < ahora) nextStartTime = ahora + 0.05;
  const fin = ahora + VENTANA_SEGUNDOS;
  while (nextStartTime < fin) {
    programarCiclo(nextStartTime);
    nextStartTime += CYCLE_DURATION;
  }
}

function programarCiclo(t) {
  [
    [FREQ_HIGH, t],
    [FREQ_LOW, t + SECOND_TONE_DELAY],
  ].forEach(([freq, start]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = WAVE_TYPE;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(VOLUME, start + ATTACK);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + TONE_DURATION);
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + TONE_DURATION + ATTACK);
  });
}

// Única cadena de reprogramación: siempre se limpia el timer anterior
// antes de programar el siguiente (una sola cadena, nunca dos).
function reprogramar() {
  if (reprogramTimer) clearTimeout(reprogramTimer);
  const myGen = generation;
  reprogramTimer = setTimeout(() => {
    reprogramTimer = null;
    if (!sonando || myGen !== generation) return;
    if (!ctx || ctx.state !== "running") {
      activarDesbloqueo();
      notifyBlocked();
      return;
    }
    programarVentana();
    reprogramar();
  }, REPROGRAMAR_MS);
}

// Baja la ganancia con rampa corta y recién ahí desconecta: sin golpe
// seco y sin dejar el nodo maestro colgado en el grafo.
function cortarMaster(g) {
  try {
    const ahora = ctx.currentTime;
    g.gain.cancelScheduledValues(ahora);
    g.gain.setValueAtTime(g.gain.value, ahora);
    g.gain.linearRampToValueAtTime(0, ahora + STOP_RAMP);
  } catch {
    /* si el contexto ya no existe, alcanza con desconectar */
  }
  setTimeout(() => {
    try {
      g.disconnect();
    } catch {
      /* ya desconectado */
    }
  }, STOP_RAMP * 1000 + 30);
}

// Política de autoplay: el resume() de un contexto bloqueado puede quedar
// PENDIENTE hasta el primer gesto. Mientras tanto no hay nada programado
// ni flags tomados: solo un listener que, ante el primer click o tecla,
// reintenta y arranca UNA ventana (la cadena vieja ya fue invalidada por
// generation, así que no se acumulan al desbloquearse).
function activarDesbloqueo() {
  if (gestureHandler) return;
  gestureHandler = () => {
    if (!sonando) {
      desactivarDesbloqueo();
      return;
    }
    const myGen = generation;
    Promise.resolve(ctx.resume())
      .then(() => {
        if (!sonando || myGen !== generation || ctx.state !== "running") return;
        desactivarDesbloqueo();
        if (!master) master = ctx.createGain();
        programarVentana();
        reprogramar();
        notifyBlocked();
      })
      .catch(() => {});
  };
  document.addEventListener("pointerdown", gestureHandler, true);
  document.addEventListener("keydown", gestureHandler, true);
}

function desactivarDesbloqueo() {
  if (!gestureHandler) return;
  document.removeEventListener("pointerdown", gestureHandler, true);
  document.removeEventListener("keydown", gestureHandler, true);
  gestureHandler = null;
}
