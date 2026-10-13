// ============================================================
// Sonido de aviso para pedidos nuevos en el panel admin.
// Generado con Web Audio API (dos tonos cortos), sin depender
// de ningún archivo de audio externo.
// ============================================================
let ctx;

export function playNewOrderChime() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
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
  } catch {
    /* audio no disponible (autoplay bloqueado, navegador viejo, etc.) */
  }
}
