// shipping-settings.spec.js - Tests E2E para la pantalla de Envíos en el panel admin
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VISUAL_DIR = path.join(__dirname, '..', '.visual');
const API_BASE = 'http://localhost:3001';

test.describe('Panel Admin - Envíos', () => {
  test.beforeEach(async ({ page }) => {
    // Login como superadmin
    await page.goto('/admin');
    // Esperar a que React hidrate y aparezca el formulario de login
    await page.waitForSelector('input[name="username"]', { timeout: 15000 });
    await page.waitForSelector('input[name="password"]', { timeout: 5000 });
    
    await page.fill('input[name="username"]', 'superadmin');
    await page.fill('input[name="password"]', 'SuperSecret123');
    await page.click('button[type="submit"]');
    // Esperar a que redirija al panel admin
    await page.waitForURL(/\/admin/, { timeout: 15000 });
  });

  async function navigateToShipping(page) {
    // Click en el botón de navegación "Envíos"
    await page.click('[data-testid="nav-envios"]');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500); // Esperar renderizado del componente
  }

  test('(a) Carga pantalla Envíos con valores sembrados, un solo título, sin errores consola', async ({ page }) => {
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await navigateToShipping(page);

    // Verificar un solo título
    const titles = await page.locator('h1, h2').allTextContents();
    const shippingTitles = titles.filter(t => t.toLowerCase().includes('envío') || t.toLowerCase().includes('envio'));
    expect(shippingTitles.length).toBe(1);

    // Verificar valores sembrados para ambas sucursales
    await expect(page.locator('text=Necochea')).toBeVisible();
    await expect(page.locator('text=Tandil')).toBeVisible();
    
    // Verificar precio base $4000
    await expect(page.locator('text=$4.000').first()).toBeVisible();

    // Verificar que no hay errores en consola
    expect(errors).toHaveLength(0);

    // Captura
    await page.screenshot({ path: path.join(VISUAL_DIR, 'shipping-settings-loaded.png'), fullPage: true });
  });

  test('(b) Cambiar precio base Necochea, recargar, verificar tienda Necochea actualizada y Tandil no', async ({ page }) => {
    await navigateToShipping(page);

    // Cambiar precio base de Necochea a 5000
    const necocheaInput = page.locator('input[name="base_cost"]').first();
    await necocheaInput.clear();
    await necocheaInput.fill('5000');
    
    await page.click('button:has-text("Guardar")');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('text=Guardado')).toBeVisible({ timeout: 5000 });

    // Recargar la página
    await page.reload();
    await page.waitForLoadState('networkidle');
    await navigateToShipping(page);

    // Verificar que Necochea muestra $5.000
    await expect(page.locator('text=$5.000').first()).toBeVisible();

    // Verificar que Tandil sigue en $4.000
    await expect(page.locator('text=$4.000').last()).toBeVisible();

    // Verificar en la tienda pública de Necochea
    const configResponse = await page.request.get(`${API_BASE}/api/shipping-config/necochea`);
    expect(configResponse.ok()).toBeTruthy();
    const config = await configResponse.json();
    expect(config.baseCost).toBe(5000);

    // Verificar que Tandil sigue en 4000
    const tandilResponse = await page.request.get(`${API_BASE}/api/shipping-config/tandil`);
    const tandilConfig = await tandilResponse.json();
    expect(tandilConfig.baseCost).toBe(4000);

    await page.screenshot({ path: path.join(VISUAL_DIR, 'shipping-necochea-updated.png'), fullPage: true });
  });

  test('(c) Automático apagado en Necochea: pedido a domicilio queda "a confirmar" sin bloquear botón, Tandil calcula', async ({ page }) => {
    await navigateToShipping(page);

    // Apagar automático en Necochea (primer switch)
    const necocheaSwitch = page.locator('input[type="checkbox"][name="auto_enabled"]').first();
    if (await necocheaSwitch.isChecked()) {
      await necocheaSwitch.click();
    }
    
    await page.click('button:has-text("Guardar")');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('text=Guardado')).toBeVisible({ timeout: 5000 });

    // Verificar en tienda pública que Necochea tiene auto_enabled=false
    const configResponse = await page.request.get(`${API_BASE}/api/shipping-config/necochea`);
    const config = await configResponse.json();
    expect(config.autoEnabled).toBe(0);

    // Verificar que Tandil sigue con auto_enabled=true
    const tandilResponse = await page.request.get(`${API_BASE}/api/shipping-config/tandil`);
    const tandilConfig = await tandilResponse.json();
    expect(tandilConfig.autoEnabled).toBe(1);

    // Simular cotización en Necochea (debería devolver pending)
    const quoteResponse = await page.request.post(`${API_BASE}/api/shipping/quote`, {
      data: { branch: 'necochea', address: 'Diagonal San Martín 1258, Necochea' }
    });
    const quote = await quoteResponse.json();
    expect(quote.pending).toBe(true);
    expect(quote.blocks).toBe(0);

    // Simular cotización en Tandil (debería calcular)
    const tandilQuoteResponse = await page.request.post(`${API_BASE}/api/shipping/quote`, {
      data: { branch: 'tandil', address: 'Chacabuco 660, Tandil' }
    });
    const tandilQuote = await tandilQuoteResponse.json();
    expect(tandilQuote.pending).toBeFalsy();
    expect(tandilQuote.blocks).toBeGreaterThan(0);

    await page.screenshot({ path: path.join(VISUAL_DIR, 'shipping-auto-disabled.png'), fullPage: true });
  });

  test('(d) A 390px no hay scroll horizontal', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await navigateToShipping(page);
    await page.waitForLoadState('networkidle');

    // Verificar que no hay scroll horizontal
    const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const bodyClientWidth = await page.evaluate(() => document.body.clientWidth);
    expect(bodyScrollWidth).toBeLessThanOrEqual(bodyClientWidth + 1); // Tolerancia de 1px

    await page.screenshot({ path: path.join(VISUAL_DIR, 'shipping-390px.png'), fullPage: true });
  });
});