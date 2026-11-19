import { defineConfig } from '@playwright/test';

const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: external || 'http://127.0.0.1:13000',
    trace: 'retain-on-failure',
    screenshot: 'on',
  },
  // An explicitly supplied base URL means both tiers are managed externally.
  webServer: external ? undefined : [
    {
      command: 'python -m uvicorn app.main:app --host 127.0.0.1 --port 18000',
      cwd: '../backend',
      env: {
        MONGODB_URI: process.env.E2E_MONGODB_URI || 'mongodb://127.0.0.1:27017',
        MONGODB_DB: process.env.E2E_MONGODB_DB || 'ridenow_e2e',
      },
      url: 'http://127.0.0.1:18000/api/health',
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'node node_modules/next/dist/bin/next dev -H 127.0.0.1 -p 13000',
      env: { BACKEND_URL: 'http://127.0.0.1:18000' },
      url: 'http://127.0.0.1:13000',
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
  reporter: 'list',
});
