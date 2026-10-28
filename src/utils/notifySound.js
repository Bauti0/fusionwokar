// ============================================================
// Sonido de aviso para pedidos nuevos en el panel admin.
// Loop de dos tonos hasta stopNewOrderLoop().
// unlockAudio(onUnlocked) desbloquea el AudioContext en el primer gesto del
// usuario y avisa con onUnlocked() una sola vez (para el estado del panel).
// shouldPlayAlert / shouldShowUnlockBanner son funciones puras de decisión.
// Reutiliza el mismo AudioContext; no hay archivos externos.
// ============================================================
let ctx;
let loopTimer = null;
let unlockDone = false;

// resume() puede rechazar (NotAllowedError); el catch evita el
// "Unhandled Promise Rejection" en consola. No se reintenta en loop.
function resumeCtx() {
  if (!ctx || ctx.state !== "suspended") return;
  const p = ctx.resume();
  if (p && typeof p.catch === "function") p.catch(() => {});
}

function playChimePair() {
  if (!ctx) return;
  resumeCtx();
  const now = ctx.currentTime;
  [[880, now, 0.14], [660, now + 0.16, 0.16]].forEach(([freq, start, dur]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  });
}

export function startNewOrderLoop() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    resumeCtx();
    if (loopTimer) return;
    playChimePair();
    loopTimer = setInterval(playChimePair, 1200);
  } catch {
    /* autoplay bloqueado, navegador viejo, etc. */
  }
}

export function stopNewOrderLoop() {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
}

// Beep corto de confirmación al activar/desactivar el sonido (un solo tono)
export function playConfirmBeep() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    resumeCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.14);
  } catch {
    /* ignorar */
  }
}

// Desbloquea el AudioContext del aviso de pedidos (política de autoplay).
// 1) Al montar NO crea el AudioContext: crearlo fuera de un gesto imprime el
//    warning "The AudioContext was not allowed to start". Solo desbloquea si el
//    ctx ya existe de antes y está corriendo (remount del panel en la misma
//    página).
// 2) Registra click/keydown/pointerup/touchend a nivel de documento; en el
//    primer gesto crea (si hace falta) y reanuda. SOLO si ctx.state ===
//    "running" llama a onUnlocked() (guard: una sola vez) y recién ahí quita
//    los listeners.
// Si resume() rechaza (NotAllowedError) se traga con catch y no se reintenta en
// loop; los listeners quedan para el próximo gesto.
// Devuelve cleanup para desmontar (quita los listeners si aún estaban puestos).
export function unlockAudio(onUnlocked) {
  const avisar = typeof onUnlocked === "function" ? onUnlocked : () => {};
  if (unlockDone) {
    avisar();
    return () => {};
  }
  const EVENTOS = ["click", "keydown", "pointerup", "touchend"];
  let avisado = false;
  function detach() {
    EVENTOS.forEach((e) => document.removeEventListener(e, onGesto));
  }
  function listo() {
    if (avisado) return;
    avisado = true;
    unlockDone = true;
    detach();
    avisar();
  }
  function intentar(enGesto) {
    try {
      if (!ctx) {
        // Crear el AudioContext fuera de un gesto imprime el warning del
        // navegador ("The AudioContext was not allowed to start"): recién se
        // crea cuando el usuario toca algo. Al montar solo sirve si el ctx ya
        // existe de antes (remount del panel en la misma página).
        if (!enGesto) return;
        ctx = new (window.AudioContext || window.webkitAudioContext)();
      }
      const p = ctx.resume();
      // ctx.state puede quedar "suspended" un instante: confirmo recién en el then
      if (p && typeof p.then === "function") {
        p.then(() => {
          if (ctx.state === "running") listo();
        }).catch(() => {});
      } else if (ctx.state === "running") {
        listo();
      }
    } catch {
      /* navegador viejo sin WebAudio */
    }
  }
  const onGesto = () => intentar(true);
  intentar(false);
  if (!avisado) EVENTOS.forEach((e) => document.addEventListener(e, onGesto));
  return detach;
}

// true si el AudioContext existe y está running (no suspended/closed)
export function isAudioRunning() {
  return !!ctx && ctx.state === "running";
}

// ============================================================
// Persistencia del toggle de sonido del header. El storage se inyecta para
// poder testearlo en Node sin window/localStorage.
// ============================================================
export const AUDIO_KEY = "fw.admin.audioEnabled.v2";
// La clave v1 guardaba "false" por defecto: cualquiera que la haya pisado sin
// querer quedaba mudo para siempre. Se ignora y se borra al cargar.
const AUDIO_KEY_V1 = "fw.admin.audioEnabled";

// Sonido activo por defecto; solo un "false" explícito en la v2 lo apaga.
export function loadAudioEnabled(storage) {
  try {
    storage.removeItem(AUDIO_KEY_V1);
    const v2 = storage.getItem(AUDIO_KEY);
    return v2 === null ? true : JSON.parse(v2);
  } catch {
    return true;
  }
}

export function saveAudioEnabled(storage, v) {
  try {
    storage.setItem(AUDIO_KEY, JSON.stringify(v));
  } catch {}
}

// ============================================================
// Funciones puras de decisión (testeadas en test/notify-sound.test.js).
// Sin acceso a window/document: el test las importa en Node directo.
// ============================================================

// ¿Debe sonar el loop de aviso? Solo con pedidos sin ver, sin silencio
// del header y con el audio ya desbloqueado por un gesto del usuario.
export function shouldPlayAlert({ unseenCount, muted, unlocked }) {
  return unseenCount > 0 && !muted && unlocked;
}

// ¿Debe mostrarse el banner? Solo si hay pedidos sin ver Y el sonido no va a
// sonar (bloqueado por autoplay o silenciado por el usuario). Con sonido
// activo y desbloqueado no se muestra nada.
export function shouldShowUnlockBanner({ unseenCount, muted, unlocked }) {
  return unseenCount > 0 && (muted || !unlocked);
}
