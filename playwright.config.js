import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser-tests',
  testMatch: '**/*.pw.js',
  use: { baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1440, height: 900 }, screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', channel: process.env.CI ? undefined : 'chrome' } },
    { name: 'mobile-webkit', use: { browserName: 'webkit' }, grep: /touch-screen layout and controls/,
      // CDP injects real multi-touch events in Chromium only.
      grepInvert: /real multi-touch/ },
  ],
  webServer: { command: 'npm start', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
});
