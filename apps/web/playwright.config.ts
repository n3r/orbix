import { defineConfig, devices } from "@playwright/test";

// Ensure DATABASE_URL is available for globalSetup
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://orbix:orbix@localhost:1062/orbix";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Serial execution (1 worker) ensures each spec sees a clean account state
  // and eliminates first-account setup-wizard races across specs.
  // (The previous 2-worker comment acknowledged the same concern; discovery
  // spec makes a 4th concurrent spec that definitively requires serial order.)
  workers: 1,
  use: {
    baseURL: "http://localhost:1060",
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "pnpm --filter @orbix/api dev",
      port: 1061,
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        DATABASE_URL: "postgresql://orbix:orbix@localhost:1062/orbix",
        REDIS_URL: "redis://localhost:1063",
        API_PORT: "1061",
        WEB_PORT: "1060",
        WEB_ORIGIN: "http://localhost:1060",
        SESSION_SECRET: "dev-session-secret-change-me-32chars",
        NODE_ENV: "development",
      },
    },
    {
      command: "pnpm --filter @orbix/web dev",
      url: "http://localhost:1060",
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        NEXT_PUBLIC_API_URL: "http://localhost:1061",
      },
    },
  ],
});
