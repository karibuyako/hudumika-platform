import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

test('feature flag row opens the edit modal with the targeting fields', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  await page.goto('/configuration/feature-flags')
  const rows = page.locator('tbody tr.row-click')
  const empty = page.getByText('No feature flags').first()
  await Promise.race([rows.first().waitFor(), empty.waitFor()])

  if ((await rows.count()) === 0) {
    await expect(empty).toBeVisible()
    return
  }

  await rows.first().click()
  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('Targeting').first()).toBeVisible()

  await drawer.getByRole('button', { name: 'Edit feature' }).click()
  const modal = page.locator('form.modal[role="dialog"]')
  await expect(modal).toBeVisible()
  await expect(modal.getByText('Edit feature').first()).toBeVisible()

  for (const label of [
    'Rollout %',
    'Beta only',
    'Target countries',
    'Target regions',
    'Target cities',
    'Target segments',
    'Target user %',
  ]) {
    await expect(modal.getByLabel(label)).toBeVisible()
  }
  await expect(modal.getByRole('button', { name: 'Save changes' })).toBeVisible()
})
