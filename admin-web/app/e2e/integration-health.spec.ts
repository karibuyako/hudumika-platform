import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

test('integration registry renders and a row opens in the drawer', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  await page.goto('/configuration/integrations')
  const rows = page.locator('tbody tr.row-click')
  const empty = page.getByText('No integrations registered').first()
  await Promise.race([rows.first().waitFor(), empty.waitFor()])
  await expect(page.getByRole('heading', { name: 'Integration Health' })).toBeVisible()

  if ((await rows.count()) === 0) {
    await expect(empty).toBeVisible()
    return
  }

  await rows.first().click()
  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('Integration').first()).toBeVisible()
  await expect(drawer.getByText('Provider').first()).toBeVisible()
  await expect(drawer.getByText('Health').first()).toBeVisible()
})
