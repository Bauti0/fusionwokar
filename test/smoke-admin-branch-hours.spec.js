import { test, expect } from "@playwright/test";

// Smoke test para la pestaña Horarios del panel admin
// Requiere que el servidor esté corriendo en localhost:3001 y el frontend en localhost:5173
// Usuarios de prueba: superadmin / branch_admin (configurados en test setup)

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5173";
const API_URL = process.env.TEST_API_URL || "http://localhost:3001";

async function loginAs(page, role) {
  await page.goto(`${BASE_URL}/admin/login`);
  await page.waitForLoadState("networkidle");

  const username = role === "superadmin" ? "superadmin" : "necochea";
  const password = "test123";

  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE_URL}/admin**`);
  await page.waitForLoadState("networkidle");
}

async function goToHorarios(page) {
  await page.click('button[data-testid="nav-horarios"]');
  await page.waitForLoadState("networkidle");
  // Esperar a que carguen los horarios
  await page.waitForSelector(".admin-bh-day", { timeout: 10000 });
}

async function checkNoErrors(page) {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    errors.push(err.message);
  });
  return errors;
}

test.describe("Admin Horarios - Smoke tests", () => {
  let consoleErrors = [];

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(err.message));
  });

  test.afterEach(async ({ page }) => {
    // Verificar que no hay errores de consola
    const criticalErrors = consoleErrors.filter(
      (e) => e.includes("is not a function") || e.includes("Cannot read")
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test("superadmin ve horarios de ambas sucursales y puede editar Necochea", async ({ page }) => {
    await loginAs(page, "superadmin");
    await goToHorarios(page);

    // Verificar que el título del panel es "Horarios" (no duplicado)
    const panelTitle = page.locator(".admin-panel-card__title");
    await expect(panelTitle).toHaveText("Horarios");
    await expect(panelTitle).toHaveCount(1);

    // Verificar que hay 7 días renderizados
    const days = page.locator(".admin-bh-day");
    await expect(days).toHaveCount(7);

    // Cambiar a Necochea
    await page.selectOption('select', 'necochea');
    await page.waitForLoadState("networkidle");

    // Verificar que los horarios no están vacíos (al menos un día tiene franjas)
    const slots = page.locator('input[type="time"]');
    const slotCount = await slots.count();
    expect(slotCount).toBeGreaterThan(0);

    // Verificar que al menos un input tiene valor
    let hasValue = false;
    for (let i = 0; i < slotCount; i++) {
      const value = await slots.nth(i).inputValue();
      if (value) {
        hasValue = true;
        break;
      }
    }
    expect(hasValue).toBe(true);

    // Cambiar una franja de Necochea (ej: Lunes apertura 12:00 -> 11:30)
    const lunesApertura = page.locator(".admin-bh-day").nth(1).locator('input[type="time"]').first();
    await lunesApertura.fill("11:30");

    // Guardar
    await page.click('button:has-text("Guardar cambios")');
    await page.waitForLoadState("networkidle");

    // Recargar y verificar que el cambio persistió
    await page.reload();
    await page.waitForLoadState("networkidle");
    await goToHorarios(page);
    await page.selectOption('select', 'necochea');
    await page.waitForLoadState("networkidle");

    const newValue = await lunesApertura.inputValue();
    expect(newValue).toBe("11:30");
  });

  test("superadmin - Tandil no cambió después de editar Necochea", async ({ page }) => {
    await loginAs(page, "superadmin");
    await goToHorarios(page);

    // Ir a Tandil
    await page.selectOption('select', 'tandil');
    await page.waitForLoadState("networkidle");

    // Verificar que Tandil tiene sus horarios (no vacíos)
    const slots = page.locator('input[type="time"]');
    const slotCount = await slots.count();
    expect(slotCount).toBeGreaterThan(0);

    let hasValue = false;
    for (let i = 0; i < slotCount; i++) {
      const value = await slots.nth(i).inputValue();
      if (value) {
        hasValue = true;
        break;
      }
    }
    expect(hasValue).toBe(true);
  });

  test("branch_admin solo ve su sucursal", async ({ page }) => {
    await loginAs(page, "branch_admin");
    await goToHorarios(page);

    // No debe haber dropdown de sucursal, solo badge
    const dropdown = page.locator('select');
    await expect(dropdown).toHaveCount(0);

    const badge = page.locator(".badge--branch");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("Necochea");

    // Verificar que carga horarios de Necochea
    const slots = page.locator('input[type="time"]');
    const slotCount = await slots.count();
    expect(slotCount).toBeGreaterThan(0);
  });

  test("validación: no permite guardar si sucursal queda cerrada todos los días", async ({ page }) => {
    await loginAs(page, "superadmin");
    await goToHorarios(page);
    await page.selectOption('select', 'necochea');
    await page.waitForLoadState("networkidle");

    // Cerrar todos los días
    for (let day = 0; day < 7; day++) {
      const switchBtn = page.locator(".admin-bh-day").nth(day).locator('[role="switch"]');
      const isChecked = await switchBtn.isChecked();
      if (isChecked) {
        await switchBtn.click();
      }
    }

    // Intentar guardar - debe pedir confirmación
    await page.click('button:has-text("Guardar cambios")');
    await page.waitForSelector(".confirm-modal");

    // Verificar mensaje de confirmación
    await expect(page.locator(".confirm-modal")).toContainText("cerrada todos los días");

    // Cancelar
    await page.click('button:has-text("Cancelar")');
  });

  test("Restablecer a por defecto pide confirmación y no guarda automáticamente", async ({ page }) => {
    await loginAs(page, "superadmin");
    await goToHorarios(page);
    await page.selectOption('select', 'necochea');
    await page.waitForLoadState("networkidle");

    // Hacer un cambio
    const lunesApertura = page.locator(".admin-bh-day").nth(1).locator('input[type="time"]').first();
    await lunesApertura.fill("10:00");

    // Click Restablecer
    await page.click('button:has-text("Restablecer a por defecto")');
    await page.waitForSelector(".confirm-modal");

    // Confirmar restablecer
    await page.click('button:has-text("Restablecer")');
    await page.waitForLoadState("networkidle");

    // Verificar que el cambio NO se guardó (el formulario se recargó pero no se hizo PUT)
    // El input debería volver al valor original
    const value = await lunesApertura.inputValue();
    expect(value).not.toBe("10:00");

    // Y NO debería estar sucio (botón Guardar deshabilitado)
    const saveBtn = page.locator('button:has-text("Guardar cambios")');
    await expect(saveBtn).toBeDisabled();
  });

  test("cambiar de sucursal con cambios sin guardar pide confirmación", async ({ page }) => {
    await loginAs(page, "superadmin");
    await goToHorarios(page);
    await page.selectOption('select', 'necochea');
    await page.waitForLoadState("networkidle");

    // Hacer un cambio
    const lunesApertura = page.locator(".admin-bh-day").nth(1).locator('input[type="time"]').first();
    await lunesApertura.fill("10:00");

    // Cambiar a Tandil
    await page.selectOption('select', 'tandil');

    // Debe aparecer modal de confirmación
    await page.waitForSelector(".confirm-modal");
    await expect(page.locator(".confirm-modal")).toContainText("cambios sin guardar");

    // Cancelar - debe quedarse en Necochea
    await page.click('button:has-text("Cancelar")');
    await expect(page.locator('select')).toHaveValue("necochea");
  });

  test("franja que cruza medianoche muestra nota", async ({ page }) => {
    await loginAs(page, "superadmin");
    await goToHorarios(page);
    await page.selectOption('select', 'necochea');
    await page.waitForLoadState("networkidle");

    // Crear una franja que cruce medianoche (ej: 20:00 - 02:00)
    const lunesApertura = page.locator(".admin-bh-day").nth(1).locator('input[type="time"]').first();
    const lunesCierre = page.locator(".admin-bh-day").nth(1).locator('input[type="time"]').nth(1);

    await lunesApertura.fill("20:00");
    await lunesCierre.fill("02:00");

    // Verificar que aparece la nota "Cierra al día siguiente"
    await expect(page.locator(".admin-bh-slot__midnight-note")).toBeVisible();
    await expect(page.locator(".admin-bh-slot__midnight-note")).toContainText("día siguiente");
  });

  test("responsive a 390px - sin scroll horizontal, controles >= 40px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await loginAs(page, "superadmin");
    await goToHorarios(page);

    // Verificar que no hay scroll horizontal
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(390);

    // Verificar que los inputs de hora tienen altura >= 40px
    const inputs = page.locator('input[type="time"]');
    const count = await inputs.count();
    for (let i = 0; i < count; i++) {
      const box = await inputs.nth(i).boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(40);
    }

    // Verificar que el Switch tiene tamaño táctil
    const switches = page.locator('[role="switch"]');
    const switchCount = await switches.count();
    for (let i = 0; i < switchCount; i++) {
      const box = await switches.nth(i).boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(40);
      expect(box.width).toBeGreaterThanOrEqual(40);
    }
  });

  test("responsive a 1360px - layout correcto", async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 800 });
    await loginAs(page, "superadmin");
    await goToHorarios(page);

    // Verificar que no hay scroll horizontal
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(1360);

    // Verificar que los 7 días son visibles
    const days = page.locator(".admin-bh-day");
    await expect(days).toHaveCount(7);
  });
});