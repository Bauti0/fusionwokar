// playwright.config.js
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "**/smoke.spec.js",
  timeout: 120000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: "http://localhost:3001",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    navigationTimeout: 60000,
  },
  globalSetup: "./test/playwright-global-setup.js",
  globalTeardown: "./test/playwright-global-teardown.js",
});