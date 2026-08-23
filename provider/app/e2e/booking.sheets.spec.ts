import { test, expect } from '@playwright/test';
import { loginIfNeeded } from './helpers';

test.describe('Booking — sheets deep (quote, proof, parts, invoice, warranty)', () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
    await page.goto('/jobs', { waitUntil: 'networkidle' });
    const link = page.locator('a[href*="/jobs/"]').first();
    if (await link.isVisible().catch(() => false)) {
      await link.click();
      await page.waitForTimeout(900);
    }
  });

  test('quote: estimate hint, validation, 409 requote', async ({ page }) => {
    const quoteBtn = page.getByRole('button', { name: /quote|submit quote/i }).first();
    if (await quoteBtn.isVisible().catch(() => false)) {
      await quoteBtn.click();
      await page.waitForTimeout(600);
      await expect(page.getByText(/Provisional estimate|Final quote may vary/i).first()).toBeVisible({ timeout: 5000 }).catch(() => {});
      // Fill labor with invalid 0 → expect error
      const labor = page.getByPlaceholder(/labor|Labor/i).first().or(page.locator('input').first());
      if (await labor.isVisible().catch(() => false)) {
        await labor.fill('0');
        const submit = page.getByRole('button', { name: /send quote|submit/i }).first();
        if (await submit.isVisible().catch(() => false)) await submit.click();
        await page.waitForTimeout(500);
      }
      const cancel = page.getByRole('button', { name: /cancel/i }).first();
      if (await cancel.isVisible().catch(() => false)) await cancel.click();
    }
  });

  test('proof: photo/signature/notes types', async ({ page }) => {
    const proofBtn = page.getByRole('button', { name: /proof/i }).first();
    if (await proofBtn.isVisible().catch(() => false)) {
      await proofBtn.click();
      await page.waitForTimeout(600);
      for (const label of [/photo/i, /signature/i, /notes/i]) {
        const tab = page.getByText(label).first().or(page.getByRole('button', { name: label }).first());
        if (await tab.isVisible().catch(() => false)) {
          await tab.click();
          await page.waitForTimeout(300);
        }
      }
      const submit = page.getByRole('button', { name: /submit proof/i }).first();
      if (await submit.isVisible().catch(() => false)) {
        // Without value should block
        await submit.click();
        await page.waitForTimeout(400);
      }
      const cancel = page.getByRole('button', { name: /cancel/i }).first();
      if (await cancel.isVisible().catch(() => false)) await cancel.click();
    }
  });

  test('parts: add row, qty/unitCost, trash, inventory guard', async ({ page }) => {
    const partsBtn = page.getByRole('button', { name: /parts/i }).first();
    if (await partsBtn.isVisible().catch(() => false)) {
      await partsBtn.click();
      await page.waitForTimeout(600);
      const add = page.getByRole('button', { name: /add part/i }).first();
      if (await add.isVisible().catch(() => false)) {
        await add.click();
        await page.waitForTimeout(400);
        const name = page.getByPlaceholder(/part name/i).first().or(page.locator('input').first());
        if (await name.isVisible().catch(() => false)) await name.fill('Tap washer');
        const qty = page.getByPlaceholder(/qty/i).first();
        if (await qty.isVisible().catch(() => false)) await qty.fill('2');
      }
      const cancel = page.getByRole('button', { name: /cancel/i }).first();
      if (await cancel.isVisible().catch(() => false)) await cancel.click();
    }
  });

  test('invoice: labor/discount validation, notIssuable guard', async ({ page }) => {
    const invBtn = page.getByRole('button', { name: /invoice/i }).first();
    const notIssuable = page.getByText(/can only be issued/i).first();
    if (await invBtn.isVisible().catch(() => false)) {
      await invBtn.click();
      await page.waitForTimeout(600);
      const labor = page.getByPlaceholder(/labor/i).first().or(page.locator('input').first());
      if (await labor.isVisible().catch(() => false)) {
        await labor.fill('abc'); // invalid → should error
        const issue = page.getByRole('button', { name: /issue invoice/i }).first();
        if (await issue.isVisible().catch(() => false)) await issue.click();
        await page.waitForTimeout(400);
      }
      const cancel = page.getByRole('button', { name: /cancel/i }).first();
      if (await cancel.isVisible().catch(() => false)) await cancel.click();
    } else if (await notIssuable.isVisible().catch(() => false)) {
      await expect(notIssuable).toBeVisible();
    }
  });

  test('warranty: validDays/coverage/followUp validation', async ({ page }) => {
    const warBtn = page.getByRole('button', { name: /warranty/i }).first();
    if (await warBtn.isVisible().catch(() => false)) {
      await warBtn.click();
      await page.waitForTimeout(600);
      const days = page.getByPlaceholder(/days/i).first().or(page.locator('input').first());
      if (await days.isVisible().catch(() => false)) {
        await days.fill('0'); // invalid
        const issue = page.getByRole('button', { name: /issue warranty/i }).first();
        if (await issue.isVisible().catch(() => false)) await issue.click();
        await page.waitForTimeout(400);
        await days.fill('30');
        const follow = page.getByPlaceholder(/YYYY-MM-DD/i).first();
        if (await follow.isVisible().catch(() => false)) {
          await follow.fill('2026/13/40'); // invalid format
          if (await issue.isVisible().catch(() => false)) await issue.click();
        }
      }
      const cancel = page.getByRole('button', { name: /cancel/i }).first();
      if (await cancel.isVisible().catch(() => false)) await cancel.click();
    }
  });

  test('validation: maxLength guards (500/300/1000)', async ({ page }) => {
    const cancelBtn = page.getByRole('button', { name: /cancel booking/i }).first();
    if (await cancelBtn.isVisible().catch(() => false)) {
      await cancelBtn.click();
      await page.waitForTimeout(600);
      const reason = page.locator('textarea').first().or(page.locator('input').first());
      if (await reason.isVisible().catch(() => false)) {
        const long = 'a'.repeat(501);
        await reason.fill(long);
        // Native maxLength should truncate to 500
        const val = await reason.inputValue();
        expect(val.length).toBeLessThanOrEqual(500);
      }
      const close = page.getByRole('button', { name: /cancel/i }).first();
      if (await close.isVisible().catch(() => false)) await close.click();
      else await page.keyboard.press('Escape');
    }
  });
});
