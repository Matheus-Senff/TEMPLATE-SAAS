import { defineConfig, devices } from "@playwright/test";

const PORT = 3000;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

/**
 * E2E against a production build. HTTP checks always run; the account journey (auth.spec.ts) needs the local
 * Supabase stack (CI job "Banco real" sets E2E_MAILPIT_URL and points the app at it).
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`,
    trace: "on-first-retry",
    ...(executablePath && { launchOptions: { executablePath } }),
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // The account journey (auth.spec.ts) runs once, on desktop: it creates real users and e-mails.
    { name: "mobile", use: { ...devices["Pixel 7"] }, testIgnore: /auth\.spec\.ts$/ },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: process.env.CI ? "npm run start" : "npm run build && npm run start",
        port: PORT,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
