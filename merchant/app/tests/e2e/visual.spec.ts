import { test, expect } from '@playwright/test';
import { login, nav, clearState } from './helpers';

test.describe('Phase 4 — Visual regression & responsive', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'commit', timeout: 60_000 });
    await clearState(page);
    await login(page);
  });

  test('Dashboard visual (mobile)', async ({ page }) => {
    await nav(page, '/dashboard');
    await page.waitForTimeout(1500);
    await expect(page.getByText("Today's revenue")).toBeVisible({ timeout: 8000 });
    // Mask dynamic clock
    await expect(page).toHaveScreenshot('dashboard-mobile.png', { maxDiffPixels: 300, mask: [page.locator('text=/\\d{1,2}:\\d{2}/').first()] });
  });

  test('Orders visual (mobile)', async ({ page }) => {
    await nav(page, '/orders');
    await page.waitForTimeout(1500);
    await expect(page.getByText('Orders')).toBeVisible({ timeout: 8000 });
    await expect(page).toHaveScreenshot('orders-mobile.png', { maxDiffPixels: 300 });
  });

  test('Responsive 390 vs 1280 no overflow', async ({ page }) => {
    await nav(page, '/orders');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(800);
    const overflow390 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow390).toBeFalsy();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(800);
    const overflow1280 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow1280).toBeFalsy();
  });
});
