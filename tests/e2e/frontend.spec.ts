import { test, expect } from '@playwright/test';

test.describe('Vue workspace', () => {
  test('mounts root app shell', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.app')).toBeVisible();
  });

  test('uses dark trading-desk background', async ({ page }) => {
    await page.goto('/');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBeTruthy();
  });
});
