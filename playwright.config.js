import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser-tests',
  testMatch: '**/*.pw.js',
  use: { baseURL: 'http://127.0.0.1:4173', browserName: 'chromium', channel: process.env.CI ? undefined : 'chrome',
    viewport: { width: 1440, height: 900 }, screenshot: 'only-on-failure' },
  webServer: { command: 'npm start', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
});
