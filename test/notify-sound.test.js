import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadAudioEnabled,
  AUDIO_KEY,
  shouldPlayAlert,
  shouldShowUnlockBanner,
} from "../src/utils/notifySound.js";

// Mini localStorage para testear loadAudioEnabled en Node: mismas firmas que
// las tres APIs que usa el código (getItem/setItem/removeItem).
function storageStub(items = {}) {
  const m = new Map(Object.entries(items));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    has: (k) => m.has(k),
  };
}

// shouldPlayAlert y shouldShowUnlockBanner deciden si suena el loop de aviso y
// si se muestra el banner del panel admin. Son puras (sin window ni
// AudioContext), por eso se importan acá en Node sin tocar server/db.js.
// Cubren la regresión del botón "Activar sonido": el sonido debe funcionar
// solo y el banner solo avisa cuando el sonido NO va a sonar.

describe("shouldPlayAlert", () => {
  // Regresión: el loop debe sonar con pedidos sin ver cuando el usuario no
  // silenció y el audio ya fue desbloqueado (gesto o desbloqueo al montar).
  it("suena con pedidos sin ver, sin silencio y desbloqueado", () => {
    assert.equal(shouldPlayAlert({ unseenCount: 2, muted: false, unlocked: true }), true);
  });

  // Regresión: si el usuario silenció desde el toggle del header, no debe
  // sonar aunque haya pedidos sin ver y el audio esté desbloqueado.
  it("no suena si el usuario silenció el header", () => {
    assert.equal(shouldPlayAlert({ unseenCount: 2, muted: true, unlocked: true }), false);
  });

  // Regresión: pestaña recién cargada sin ningún gesto del usuario: el audio
  // sigue bloqueado por la política de autoplay y no debe intentar sonar.
  it("no suena si el audio todavía no está desbloqueado", () => {
    assert.equal(shouldPlayAlert({ unseenCount: 2, muted: false, unlocked: false }), false);
  });

  // Regresión: con todos los pedidos vistos el loop debe quedar detenido,
  // aunque el sonido esté activo y desbloqueado.
  it("no suena sin pedidos sin ver", () => {
    assert.equal(shouldPlayAlert({ unseenCount: 0, muted: false, unlocked: true }), false);
  });
});

describe("shouldShowUnlockBanner", () => {
  // Regresión: el banner debe avisar cuando hay pedidos sin ver y el sonido
  // está bloqueado (caso típico de recién cargado, sin tocar nada todavía).
  it("se muestra con pedidos sin ver y audio bloqueado", () => {
    assert.equal(shouldShowUnlockBanner({ unseenCount: 1, muted: false, unlocked: false }), true);
  });

  // Regresión: con el sonido silenciado el banner sigue siendo útil como aviso
  // informativo de pedidos sin ver (sin pedirle que active el sonido).
  it("se muestra con pedidos sin ver y sonido silenciado", () => {
    assert.equal(shouldShowUnlockBanner({ unseenCount: 1, muted: true, unlocked: true }), true);
  });

  // Regresión: con sonido activo y desbloqueado no debe aparecer ningún
  // banner; no queda nada que pedirle al usuario (el botón fue eliminado).
  it("no se muestra con sonido activo y desbloqueado", () => {
    assert.equal(shouldShowUnlockBanner({ unseenCount: 1, muted: false, unlocked: true }), false);
  });

  // Regresión: sin pedidos sin ver no se muestra ningún banner, ni silenciado
  // ni bloqueado.
  it("no se muestra sin pedidos sin ver", () => {
    assert.equal(shouldShowUnlockBanner({ unseenCount: 0, muted: true, unlocked: false }), false);
  });
});

describe("loadAudioEnabled — clave v2", () => {
  // Regresión: la clave vieja (v1) guardaba "false" por defecto y dejaba mudo
  // a cualquiera que la pisó sin querer. Con la v2 ausente el sonido arranca
  // activo aunque la v1 diga "false"; la v1 se borra del storage.
  it("v2 ausente (con la vieja en 'false') → true y borra la v1", () => {
    const s = storageStub({ "fw.admin.audioEnabled": "false" });
    assert.equal(loadAudioEnabled(s), true);
    assert.equal(s.has("fw.admin.audioEnabled"), false);
  });

  // Regresión: si el usuario silenció a mano desde el toggle (eso escribe la
  // v2), el "false" se respeta y no vuelve a sonar en la próxima carga.
  it("v2 'false' → false", () => {
    assert.equal(loadAudioEnabled(storageStub({ [AUDIO_KEY]: "false" })), false);
  });

  // Regresión: un "true" guardado en la v2 se lee tal cual (el toggle no
  // pierde el estado al recargar).
  it("v2 'true' → true", () => {
    assert.equal(loadAudioEnabled(storageStub({ [AUDIO_KEY]: "true" })), true);
  });
});
