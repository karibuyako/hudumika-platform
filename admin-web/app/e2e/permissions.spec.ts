import { test, expect } from '@playwright/test'
import { staffLogin, AUDITOR_PHONE } from './helpers'

test('read-only auditor sees no approve or reject actions on merchants', async ({ page }) => {
  await staffLogin(page, AUDITOR_PHONE)

  await page.goto('/commerce/merchants')
  const rows = page.locator('tbody tr')
  await rows.first().waitFor()
  await rows.first().click()

  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'Approve' })).toHaveCount(0)
  await expect(drawer.getByRole('button', { name: 'Reject' })).toHaveCount(0)
  await expect(drawer.getByRole('button', { name: 'Request changes' })).toHaveCount(0)

  await expect(page.locator('.badge')).toContainText('Read-only Auditor')
})
