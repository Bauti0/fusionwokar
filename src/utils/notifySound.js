// ============================================================
// Sonido de aviso para pedidos nuevos en el panel admin.
// Loop de dos tonos hasta stopNewOrderLoop(). playConfirmBeep() para el click del botón.
// unlockAudio() para el primer gesto del usuario. isAudioRunning() para el banner.
// Reutiliza el mismo AudioContext; no hay archivos externos.
// ============================================================
let ctx;
let loopTimer = null;
let unlockDone = false;

function playChimePair() {
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume();
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
    if (ctx.state === "suspended") ctx.resume();
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
    if (ctx.state === "suspended") ctx.resume();
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

// Primer gesto del usuario (click/tecla) → resume AudioContext una sola vez.
// Llamar al montar el panel; devuelve cleanup para desmontar.
export function unlockAudio() {
  if (unlockDone) return () => {};
  function resume() {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    unlockDone = true;
  }
  document.addEventListener("click", resume, { once: true });
  document.addEventListener("keydown", resume, { once: true });
  return () => {
    document.removeEventListener("click", resume);
    document.removeEventListener("keydown", resume);
  };
}

// true si el AudioContext existe y está running (no suspended/closed)
export function isAudioRunning() {
  return !!ctx && ctx.state === "running";
}

// Compat: código viejo llama a playNewOrderChime(); redirige al loop.
export function playNewOrderChime() {
  startNewOrderLoop();
}