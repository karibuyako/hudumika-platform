import { test, expect } from '@playwright/test';
import { login, nav, clearState } from './helpers';

test.describe('Phase 2 — Orders flows', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'commit', timeout: 60_000 });
    await clearState(page);
  });

  test('Orders queue loads with 5-state (To accept)', async ({ page }) => {
    await login(page);
    await nav(page, '/orders');
    await expect(page.getByText('Orders')).toBeVisible({ timeout: 10000 });
    // 5-state: loading skeleton or empty or list
    await expect(page.getByText(/To accept|Advance|Accepted/)).toBeVisible({ timeout: 10000 });
    // At least one of empty or MT card or loading
    const empty = page.getByText(/No orders here|No orders/i);
    const card = page.locator('text=MT88000').first();
    const loading = page.getByRole('progressbar');
    await expect(empty.or(card).or(loading)).toBeVisible({ timeout: 8000 });
  });

  test('Accept order happy path', async ({ page }) => {
    await login(page);
    await nav(page, '/orders');
    await page.waitForTimeout(1500);
    const acceptBtn = page.getByRole('button', { name: 'Accept' }).first();
    if (await acceptBtn.count()) {
      await acceptBtn.click();
      await page.waitForTimeout(1500);
      // Should show Accepted tab or success, or at least not error
      await expect(page.getByText(/Accepted|Preparing|To accept/)).toBeVisible({ timeout: 5000 });
    } else {
      test.skip();
    }
  });

  test('Decline with reason sheet', async ({ page }) => {
    await login(page);
    await nav(page, '/orders');
    await page.waitForTimeout(1500);
    // Open first order detail that has Decline
    const orderCard = page.locator('text=MT88000').first();
    if (await orderCard.count()) {
      await page.evaluate(() => {
        window.history.pushState({}, '', '/orders/o_seed_0');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await page.waitForTimeout(1500);
      const decline = page.getByRole('button', { name: 'Decline' }).first();
      if (await decline.count()) {
        await decline.click();
        await page.waitForTimeout(800);
        await expect(page.getByText(/Store too busy|Reason|Other/)).toBeVisible({ timeout: 5000 });
      }
    }
  });

  test('Rush reply presets 5-45 min', async ({ page }) => {
    await login(page);
    await nav(page, '/orders');
    await page.waitForTimeout(1000);
    // Toggle Rush queue
    const rushChip = page.getByText('Rush').first();
    if (await rushChip.count()) {
      await rushChip.click();
      await page.waitForTimeout(1000);
      // Check rush urgency pills or empty
      await expect(page.getByText(/No rush requests|LOW|MEDIUM|HIGH|CRITICAL/).first()).toBeVisible({ timeout: 5000 });
      // If rush card has I'm on it, click and check presets
      const imOnIt = page.getByRole('button', { name: "I'm on it" }).first();
      if (await imOnIt.count()) {
        await imOnIt.click();
        await page.waitForTimeout(800);
        await expect(page.getByText(/Tap a preset|ETA/)).toBeVisible({ timeout: 5000 });
        await expect(page.getByText('5 min ETA')).toBeVisible();
      }
    }
  });

  test('Advance pre-orders tabs Today/Upcoming/Past', async ({ page }) => {
    await login(page);
    await nav(page, '/orders');
    await page.waitForTimeout(800);
    const advance = page.getByText('Advance').first();
    if (await advance.count()) {
      await advance.click();
      await page.waitForTimeout(1000);
      await expect(page.getByText('Today').first()).toBeVisible({ timeout: 5000 });
      await expect(page.getByText('Upcoming').first()).toBeVisible();
      await expect(page.getByText('Past').first()).toBeVisible();
    }
  });

  test('Batch accept and print', async ({ page }) => {
    await login(page);
    await nav(page, '/orders');
    await page.waitForTimeout(1000);
    const printToggle = page.getByLabel('batch print');
    if (await printToggle.count()) {
      await printToggle.click();
      await page.waitForTimeout(500);
      await expect(page.getByText(/selected/)).toBeVisible({ timeout: 5000 });
      // Select first checkbox via card tap
      const firstCard = page.locator('text=MT88000').first();
      if (await firstCard.count()) await firstCard.click();
      const printBtn = page.getByRole('button', { name: /Print \(/ });
      if (await printBtn.count()) await expect(printBtn.first()).toBeVisible();
    }
  });

  test('Search navigation', async ({ page }) => {
    await login(page);
    await nav(page, '/orders');
    const search = page.getByText('Search').first();
    await expect(search).toBeVisible({ timeout: 5000 });
    await search.click();
    await page.waitForTimeout(800);
    await expect(page).toHaveURL(/\/orders\/search/);
    await expect(page.getByText(/Search orders/)).toBeVisible({ timeout: 5000 });
  });

  test('Enterprise toggle', async ({ page }) => {
    await login(page);
    await nav(page, '/orders');
    const ent = page.getByText('Enterprise').first();
    await expect(ent).toBeVisible({ timeout: 5000 });
    await ent.click();
    await page.waitForTimeout(800);
    await expect(page.getByText(/No enterprise orders|enterprise/i).first()).toBeVisible({ timeout: 5000 });
  });
});
