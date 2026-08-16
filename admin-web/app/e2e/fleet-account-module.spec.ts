import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

test('fleet account list renders and a row opens in the drawer', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  await page.goto('/fleet-accounts')
  const rows = page.locator('tbody tr.row-click')
  const empty = page.getByText('No fleet accounts').first()
  await Promise.race([rows.first().waitFor(), empty.waitFor()])

  if ((await rows.count()) === 0) {
    await expect(empty).toBeVisible()
    return
  }

  await rows.first().click()
  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('Overview').first()).toBeVisible()
  await expect(drawer.getByText('Driver sub-accounts').first()).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'Edit' })).toBeVisible()
})
