import { test, expect } from '@playwright/test';

test.describe('WASM shell', () => {
  test('renders terminal canvas and title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/MMT-Trade Terminal/);
    await expect(page.locator('#terminalCanvas')).toBeVisible();
    await expect(page.locator('#loaderOverlay')).toBeVisible();
  });

  test('COOP/COEP headers enable cross-origin isolation', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.ok()).toBeTruthy();
    const headers = response?.headers() ?? {};
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
  });

  test('smoke query param selects smoke wasm bundle', async ({ page }) => {
    await page.goto('/?smoke');
    await expect(page.locator('#terminalCanvas')).toBeVisible();
    const loaderText = await page.locator('#loaderOverlay').textContent();
    expect(loaderText?.length).toBeGreaterThan(0);
  });

  test('WASM survives 100+ frames without RuntimeError', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message);
    });

    await page.goto('/');
    await expect(page.locator('#terminalCanvas')).toBeVisible();
    await expect(page.locator('#loaderOverlay')).toHaveClass(/hidden/, { timeout: 30_000 });

    await page.waitForFunction(
      () => {
        const countFrames = (window as Window & { __terminalFrameCount?: () => number }).__terminalFrameCount;
        return typeof countFrames === 'function' && countFrames() >= 100;
      },
      undefined,
      { timeout: 30_000 },
    );

    const frameCount = await page.evaluate(() => {
      const countFrames = (window as Window & { __terminalFrameCount?: () => number }).__terminalFrameCount;
      return countFrames?.() ?? 0;
    });
    expect(frameCount).toBeGreaterThanOrEqual(100);

    const aborted = consoleErrors.some((line) => /Aborted|RuntimeError/i.test(line));
    expect(aborted, consoleErrors.join('\n')).toBe(false);
  });
});
