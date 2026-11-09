import { test, expect } from "@playwright/test";

// ============================================================
// Bug de regresión: el botón del parlante del header mostraba el
// ícono de silenciado SUPERPUESTO con el de volumen normal.
//
// Causa real (verificada en el DOM): IconVolumeX (icons.jsx) tenía
// TAMBIÉN los arcos de ondas de IconVolume2 dentro del mismo svg
// (1 svg con 5 paths: parlante + ondas + X). El fix deja cada
// estado con UN solo svg: Volume2 = 3 paths (sin X), VolumeX =
// parlante + 2 lines de la X, sin ondas.
//
// Este spec clava el contrato en el panel real:
//   - exactamente 1 svg adentro del botón, antes y después del
//     clic, y al recargar (el estado vive en localStorage);
//   - el aria-label/title siguen cambiando según el estado;
//   - sin console.error mientras se usa el botón (los errores se
//     escuchan solo en la fase del panel: el 401 previo al login
//     es el chequeo de sesión que existe por diseño).
// Requiere dev server (5173) + API (3001) con los usuarios de
// prueba sembrados (NODE_ENV=test siembra superadmin/testpass123).
// Capturas en .visual/ (ignorada por git), a 390px y 1360px.
// ============================================================

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5173";
const USER = process.env.FW_ADMIN_USER || "superadmin";
const PASS = process.env.FW_ADMIN_PASS || "testpass123";

const SOUND_BTN = '.admin__actions button[aria-label*="sonido"]';

async function loginToPanel(page) {
  await page.goto(`${BASE_URL}/admin`);
  await page.waitForSelector('[data-testid="admin-username"]', { timeout: 10000 });
  // Estado de sonido limpio: default activado (la v1 "fw.admin.audioEnabled"
  // se ignora; borramos ambas para que no contagie desde un perfil previo).
  await page.evaluate(() => {
    try {
      localStorage.removeItem("fw.admin.audioEnabled.v2");
      localStorage.removeItem("fw.admin.audioEnabled");
    } catch {}
  });
  await page.fill('[data-testid="admin-username"]', USER);
  await page.fill('[data-testid="admin-password"]', PASS);
  await page.click('[data-testid="admin-login-submit"]');
  await page.waitForSelector(SOUND_BTN, { timeout: 10000 });
}

// Estructura del svg del botón: cuántos svg y qué shapes tiene adentro.
function svgShape(locator) {
  return locator.evaluate((el) => {
    const svgs = el.querySelectorAll("svg");
    const svg = svgs[0];
    return {
      svgCount: svgs.length,
      paths: svg ? svg.querySelectorAll("path").length : 0,
      lines: svg ? svg.querySelectorAll("line").length : 0,
    };
  });
}

test("el botón de sonido tiene exactamente 1 svg por estado, sin superposición, y persiste al recargar", async ({ page }) => {
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await loginToPanel(page);

  // A partir de acá se escuchan errores: el 401 del chequeo de sesión
  // anónimo ya pasó (es esperado, no es un bug del panel).
  consoleErrors.length = 0;

  const btn = page.locator(SOUND_BTN);

  // Estado inicial: sonido ACTIVADO → IconVolume2 (3 paths, 0 lines, 1 svg).
  await expect(btn).toHaveAttribute("aria-label", "Desactivar sonido de pedidos");
  let shape = await svgShape(btn);
  expect(shape.svgCount).toBe(1);
  expect(shape.paths).toBe(3);
  expect(shape.lines).toBe(0);

  // Click → SILENCIADO → IconVolumeX: 1 svg, parlante (1 path) + X (2 lines).
  // El bug de la superposición se ve acá: antes había 3 paths de ondas.
  await btn.click();
  await expect(btn).toHaveAttribute("aria-label", "Activar sonido de pedidos");
  expect(await btn.getAttribute("title")).toBe("Click para activar sonido de pedidos");
  shape = await svgShape(btn);
  expect(shape.svgCount).toBe(1);
  expect(shape.paths).toBe(1);
  expect(shape.lines).toBe(2);

  // Click de ida y vuelta: el toggle no deja íconos apilados ni parpadea
  // duplicando nodos (si el contenedor acumulara svgs, esto lo caza).
  await btn.click();
  await expect(btn).toHaveAttribute("aria-label", "Desactivar sonido de pedidos");
  shape = await svgShape(btn);
  expect(shape.svgCount).toBe(1);
  expect(shape.paths).toBe(3);
  expect(shape.lines).toBe(0);

  await btn.click();
  await expect(btn).toHaveAttribute("aria-label", "Activar sonido de pedidos");
  shape = await svgShape(btn);
  expect(shape.svgCount).toBe(1);
  expect(shape.lines).toBe(2);

  // Persistencia: recarga y el silenciado sigue (localStorage), con 1 svg.
  await page.reload();
  await page.waitForSelector(SOUND_BTN, { timeout: 10000 });
  const btnAfterReload = page.locator(SOUND_BTN);
  await expect(btnAfterReload).toHaveAttribute("aria-label", "Activar sonido de pedidos");
  shape = await svgShape(btnAfterReload);
  expect(shape.svgCount).toBe(1);
  expect(shape.lines).toBe(2);

  // Sin errores de consola durante todo el uso del botón.
  expect(consoleErrors).toEqual([]);
});

// A 390px los cinco botones de período entran sin scroll horizontal
// (flex-wrap) y "Este mes" queda activable con el estado resaltado igual
// que los demás. El default sigue siendo "Últimos 30 días".
test("a 390px el filtro de período de Estadísticas no desborda", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await loginToPanel(page);
  await page.click('[data-testid="nav-stats"]');
  const wrap = page.locator(".admin-stats__period");
  await page.waitForSelector(".admin-stats__period");
  const btns = await wrap.locator(".period-btn").allTextContents();
  expect(btns.map((b) => b.trim())).toEqual([
    "Hoy",
    "Últimos 7 días",
    "Este mes",
    "Últimos 30 días",
    "Personalizado",
  ]);
  // Default intacto: 30 días activado.
  const labels = [];
  for (const b of await wrap.locator(".period-btn").all()) {
    const active = await b.evaluate((el) => el.classList.contains("is-active"));
    if (active) labels.push((await b.textContent()).trim());
  }
  expect(labels).toEqual(["Últimos 30 días"]);
  // Sin scroll horizontal en toda la página.
  const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
  // Y "Este mes" se activa como los demás.
  await wrap.locator('.period-btn:has-text("Este mes")').click();
  const activeNow = await wrap
    .locator(".period-btn.is-active")
    .evaluate((el) => el.textContent.trim());
  expect(activeNow).toBe("Este mes");
});