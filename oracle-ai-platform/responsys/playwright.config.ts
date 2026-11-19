import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });
const PORT = 3100;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  // The browser journey runs against its own server on the TEST database, never the dev data.
  webServer: {
    command: 'npx tsx server/dev.ts',
    url: `http://localhost:${PORT}/api/health/ready`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'development',
      APP_DATA_MODE: 'test',
      PORT: String(PORT),
      APP_BASE_URL: `http://localhost:${PORT}`,
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
      SESSION_SECRET: 'e2e-session-secret-0123456789abcdef0123456789',
      AUTH_MODE: 'dev',
      ALLOW_WORKSPACE_CREATION: 'true',
      STORAGE_ROOT: './var/e2e-objects',
      RUN_WORKER_IN_PROCESS: 'true',
      AI_PROVIDER: 'none',
      DISABLE_HMR: 'true',
    },
  },
});
