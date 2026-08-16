import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

test('facility list renders and a row opens in the drawer', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  await page.goto('/facilities')
  const rows = page.locator('tbody tr.row-click')
  const empty = page.getByText('No facilities').first()
  await Promise.race([rows.first().waitFor(), empty.waitFor()])

  if ((await rows.count()) === 0) {
    await expect(empty).toBeVisible()
    return
  }

  await rows.first().click()
  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('Overview').first()).toBeVisible()
  await expect(drawer.getByText('Access policy').first()).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'Manage whitelist' })).toBeVisible()
})
