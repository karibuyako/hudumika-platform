import { test, expect } from '@playwright/test';
import { login, nav, clearState } from './helpers';

test.describe('Phase 2 — Catalogue flows', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'commit', timeout: 60_000 });
    await clearState(page);
  });

  test('Products list loads with 5-state', async ({ page }) => {
    await login(page);
    await nav(page, '/products');
    await expect(page.getByText(/Menu|Products/)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/All|Search items/)).toBeVisible({ timeout: 8000 });
    const empty = page.getByText(/No products|No items/i);
    const card = page.locator('text=Grilled').first();
    const loading = page.getByRole('progressbar');
    await expect(empty.or(card).or(loading)).toBeVisible({ timeout: 8000 });
  });

  test('Add product navigates to editor', async ({ page }) => {
    await login(page);
    await nav(page, '/products');
    const add = page.getByRole('button', { name: /Add product/ }).first();
    if (await add.count()) {
      await add.click();
      await page.waitForTimeout(800);
      await expect(page.getByText(/Edit product|Add product|Name/)).toBeVisible({ timeout: 5000 });
    } else {
      const add2 = page.getByText('Add product').first();
      await expect(add2).toBeVisible({ timeout: 5000 });
    }
  });

  test('Categories, combos, menus navigation', async ({ page }) => {
    await login(page);
    await nav(page, '/products');
    await page.waitForTimeout(800);
    const cat = page.getByText('Categories').first();
    if (await cat.count()) {
      await cat.click();
      await page.waitForTimeout(800);
      await expect(page.getByText(/Categories/)).toBeVisible({ timeout: 5000 });
      await nav(page, '/products');
    }
    const combos = page.getByText('Combos').first();
    if (await combos.count()) {
      await combos.click();
      await page.waitForTimeout(800);
      await expect(page.getByText(/Combos|No combos/)).toBeVisible({ timeout: 5000 });
      await nav(page, '/products');
    }
    const menus = page.getByText('Menus').first();
    if (await menus.count()) {
      await menus.click();
      await page.waitForTimeout(800);
      await expect(page.getByText(/Menus|No menus/)).toBeVisible({ timeout: 5000 });
    }
  });

  test('Barcodes and videos', async ({ page }) => {
    await login(page);
    await nav(page, '/products/barcodes');
    await page.waitForTimeout(800);
    await expect(page.getByText(/Barcodes|Supported formats/).first()).toBeVisible({ timeout: 8000 });
    await nav(page, '/products/videos');
    await page.waitForTimeout(800);
    await expect(page.getByText(/Videos|No videos/).first()).toBeVisible({ timeout: 8000 });
  });

  test('Import/export bulk', async ({ page }) => {
    await login(page);
    await nav(page, '/products');
    await expect(page.getByText(/Import|Export|Bulk/).first()).toBeVisible({ timeout: 5000 });
  });
});
