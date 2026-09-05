/**
 * tests-ui/playwright.config.ts — Playwright for the DEVELOPMENT org only.
 * Production hosts are refused in auth.setup.ts; preprod runs are engine-driven (least-privilege test user) and pass the
 * host via SFSMITHS_UI_ALLOW_HOSTS. Optional: needs `npm i -D playwright@1.63.0 @playwright/test@1.63.0`.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  timeout: 60_000,
  retries: 0,                                   // flaky specs go to quarantine/, not into retries
  reporter: [["list"], ["html", { open: "never", outputFolder: "../work/.playwright-report" }]],
  use: {
    ...devices["Desktop Chrome"],
    storageState: process.env.SFSMITHS_STORAGE_STATE ?? "../.sfsmiths/ui/storageState.json",
    baseURL: process.env.SFSMITHS_UI_BASE_URL,   // set by `npm run ui:auth` from the development org's instance URL
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "dev", dependencies: ["setup"], testIgnore: /quarantine/ },
  ],
});
