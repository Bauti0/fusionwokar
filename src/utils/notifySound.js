// ============================================================
// Sonido de aviso para pedidos nuevos en el panel admin.
// Generado con Web Audio API (dos tonos cortos), sin depender
// de ningún archivo de audio externo.
// ============================================================
let ctx;
let loopTimerId = null;
let loopOscillators = [];

function playChimeOnce(ctx, now) {
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
    loopOscillators.push(osc);
  });
}

export function playNewOrderChime() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;
    playChimeOnce(ctx, now);
  } catch {
    console.error("No se ha podido reproducir el sonido (autoplay bloqueado, navegador viejo, etc).")
    /* audio no disponible (autoplay bloqueado, navegador viejo, etc.) */
  }
}

export function startNewOrderLoop() {
  try {
    stopNewOrderLoop(); // por si ya hay uno corriendo
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();

    const playLoop = () => {
      const now = ctx.currentTime;
      playChimeOnce(ctx, now);
      // Repetir cada 2.5 segundos (duración del chime + pausa)
      loopTimerId = setTimeout(playLoop, 2500);
    };

    playLoop();
  } catch {
    /* audio no disponible */
  }
}

export function stopNewOrderLoop() {
  if (loopTimerId) {
    clearTimeout(loopTimerId);
    loopTimerId = null;
  }
  // Detener osciladores activos
  loopOscillators.forEach((osc) => {
    try {
      osc.stop();
    } catch {
      /* ya detenido */
    }
  });
  loopOscillators = [];
}
