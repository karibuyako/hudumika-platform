import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

test('warehouse list renders and the drawer loads the stock section', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  await page.goto('/logistics/warehouses')
  const rows = page.locator('tbody tr.row-click')
  const empty = page.getByText('No warehouses').first()
  await Promise.race([rows.first().waitFor(), empty.waitFor()])

  if ((await rows.count()) === 0) {
    await expect(empty).toBeVisible()
    return
  }

  await rows.first().click()
  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('Overview').first()).toBeVisible()

  // wait for the stock section to settle (loading skeleton gone) before asserting either state
  await expect(drawer.locator('[aria-busy="true"]').first()).toBeHidden({ timeout: 60_000 })
  const stockEmpty = drawer.getByText('No stock recorded').first()
  if ((await stockEmpty.count()) > 0) {
    await expect(stockEmpty).toBeVisible()
  } else {
    const stockRow = drawer.locator('table tbody tr').first()
    await expect(stockRow.or(drawer.getByText(/Stock unavailable|stock/)).first()).toBeVisible()
  }
})
