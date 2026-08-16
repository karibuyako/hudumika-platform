import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

test('delivery exception queue renders and a row opens in the drawer', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  await page.goto('/operations/exceptions')
  const rows = page.locator('tbody tr.row-click')
  const empty = page.getByText('No delivery exceptions').first()
  await Promise.race([rows.first().waitFor(), empty.waitFor()])

  if ((await rows.count()) === 0) {
    await expect(empty).toBeVisible()
    return
  }

  await rows.first().click()
  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('Kind').first()).toBeVisible()
  await expect(drawer.getByText('Status').first()).toBeVisible()
  await expect(drawer.getByText('Created').first()).toBeVisible()
})
