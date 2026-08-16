import { test, expect, type Page } from '@playwright/test'
import { staffLogin, waitForTableRows, AUDITOR_PHONE } from './helpers'

/**
 * Prefer a pending refund for the assertion; if none exists across 8 reloads
 * (faker-random statuses), fall back to any refund row — the read-only
 * auditor never gets decision actions regardless of status.
 */
async function openPendingRefund(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.goto('/finance/refunds')
    await waitForTableRows(page)
    const rows = page.locator('tbody tr')

    const count = await rows.count()
    for (let i = 0; i < count; i++) {
      await rows.nth(i).click()
      const drawer = page.getByRole('dialog')
      await expect(drawer).toBeVisible()
      if ((await drawer.getByText('pending', { exact: true }).count()) > 0) return true
      await drawer.getByRole('button', { name: 'Close' }).click()
      await expect(drawer).not.toBeVisible()
    }
  }
  return false
}

test('read-only auditor sees no approve or reject actions on refunds', async ({ page }) => {
  await staffLogin(page, AUDITOR_PHONE)

  const foundPending = await openPendingRefund(page)
  if (!foundPending) {
    await page.goto('/finance/refunds')
    await waitForTableRows(page)
    await page.locator('tbody tr').first().click()
  }

  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'Approve' })).toHaveCount(0)
  await expect(drawer.getByRole('button', { name: 'Reject' })).toHaveCount(0)
  await expect(drawer.getByRole('button', { name: 'Initiate approval' })).toHaveCount(0)

  await expect(page.locator('.badge')).toContainText('Read-only Auditor')
})
