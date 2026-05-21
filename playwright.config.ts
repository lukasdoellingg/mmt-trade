import { defineConfig, devices } from '@playwright/test';

const shellPort = Number(process.env.SHELL_PREVIEW_PORT || 4173);
const frontendPort = Number(process.env.FRONTEND_PREVIEW_PORT || 4174);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'shell',
      testMatch: '**/shell.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${shellPort}`,
      },
    },
    {
      name: 'frontend',
      testMatch: '**/frontend.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${frontendPort}`,
      },
    },
  ],
  webServer: [
    {
      command: `npm --workspace packages/shell run preview -- --port ${shellPort} --strictPort`,
      port: shellPort,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `npm --workspace web/frontend run preview -- --port ${frontendPort} --strictPort`,
      port: frontendPort,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
