import { defineConfig, devices } from "@playwright/test";

// CSS MUST own :3000 (the auth issuer map keys localhost:3000 to the local CSS issuer);
// next dev ALSO defaults to :3000, so the app moves to :3200 (AGENTS.md §Servers).


const APP_PORT = 3200;
const CSS_PORT = 3000;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    trace: "retain-on-failure",
    headless: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  globalSetup: "./e2e/global-setup.ts",
  webServer: [
    {
      // In-memory WAC CSS, pinned major 7 (AGENTS.md §Servers).
      command: `npx -y @solid/community-server@7 -p ${CSS_PORT}`,
      url: `http://localhost:${CSS_PORT}/`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `npx next dev -p ${APP_PORT}`,
      url: `http://localhost:${APP_PORT}`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
