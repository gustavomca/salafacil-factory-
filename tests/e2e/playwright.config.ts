import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const run = process.env.E2E_RUN_ID ?? new Date().toISOString().replaceAll(/[:.]/g, '-');
process.env.E2E_RUN_ID = run;
const artifacts = path.resolve(here, '../../.factory/artifacts/e2e', run);
const baseURL = process.env.BASE_URL;
if (!baseURL) throw new Error('BASE_URL must point to the disposable SalaFácil Docker stack.');

export default defineConfig({
  testDir: here,
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: path.join(artifacts, 'results'),
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(artifacts, 'report.json') }],
    ['html', { outputFolder: path.join(artifacts, 'html'), open: 'never' }],
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
