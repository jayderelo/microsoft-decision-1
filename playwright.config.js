import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser-tests',
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1050 } } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'node server.js',
    url: 'http://127.0.0.1:3100/health',
    reuseExistingServer: false,
    timeout: 10000,
    // Browser regressions run offline. The real .env and Azure are never used.
    env: { PORT: '3100', HOST: '127.0.0.1', AZURE_ENDPOINT: '', AZURE_API_KEY: '', DEPLOYMENT_NAME: 'microsoft-decision-1' },
  },
});
