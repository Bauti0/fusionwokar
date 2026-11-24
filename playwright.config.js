import { defineConfig, devices } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure .visual directory exists
const visualDir = path.join(__dirname, '.visual');
if (!fs.existsSync(visualDir)) {
  fs.mkdirSync(visualDir, { recursive: true });
}

export default defineConfig({
  testDir: './test-e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1, // Add 1 retry locally for flaky tests
  workers: 1,
  reporter: 'list',
  timeout: 90000, // Increase test timeout to 90s
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 30000, // Increase action timeout
    navigationTimeout: 30000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  globalSetup: './test-e2e/global-setup.js',
  globalTeardown: './test-e2e/global-teardown.js',
});