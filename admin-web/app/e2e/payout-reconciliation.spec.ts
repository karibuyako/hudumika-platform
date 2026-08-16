import { test, expect } from '@playwright/test'
import { staffLogin, waitForTableRows, OWNER_PHONE } from './helpers'

test('owner opens a payout batch and sees its detail fields', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  await page.goto('/finance/payments')
  await waitForTableRows(page)
  const rows = page.locator('tbody tr')
  await rows.first().click()

  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  for (const label of ['ID', 'Cycle', 'Status', 'Total', 'Payouts', 'Exceptions']) {
    await expect(drawer.getByText(label, { exact: true })).toBeVisible()
  }
})
