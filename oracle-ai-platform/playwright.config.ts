import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3101",
    actionTimeout: 15000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? {
          launchOptions: {
            executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
          },
        }
      : { channel: process.env.PLAYWRIGHT_CHANNEL || "msedge" }),
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: "node --import tsx server/dev.ts",
    url: "http://localhost:3101/health/ready",
    reuseExistingServer: false,
    timeout: 90000,
    env: {
      NODE_ENV: "test",
      AUTH_MODE: "dev",
      PLATFORM_ADMIN_EMAILS: "admin@example.test,consultant@example.test",
      PORT: "3101",
      APP_ORIGIN: "http://localhost:3101",
      DATA_DIR: ".data/e2e-" + Date.now(),
      DATABASE_URL: "",
      DATABASE_MIGRATION_URL: "",
      AI_PROVIDER: "none",
      SESSION_SECRET: "e2e-only-session-secret-at-least-32-characters",
      ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
    },
  },
});
