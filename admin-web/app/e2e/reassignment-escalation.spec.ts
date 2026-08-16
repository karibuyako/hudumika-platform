import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

test('shipment row opens the drawer with the action panel', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  await page.goto('/logistics/shipments')
  const rows = page.locator('tbody tr.row-click')
  const empty = page.getByText('No shipments').first()
  await Promise.race([rows.first().waitFor(), empty.waitFor()])

  if ((await rows.count()) === 0) {
    await expect(empty).toBeVisible()
    return
  }

  await rows.first().click()
  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'Overview' })).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'Custody' })).toBeVisible()

  // Owner holds shipment.hold and shipment.reassign, so the action panel must
  // render at least one of the freeze / unfreeze / reassign / escalate actions.
  const freeze = drawer.getByRole('button', { name: 'Freeze' })
  const unfreeze = drawer.getByRole('button', { name: 'Initiate unfreeze approval' })
  const reassign = drawer.getByRole('button', { name: 'Reassign' })
  const escalate = drawer.getByRole('button', { name: 'Escalate' })
  await expect(freeze.or(unfreeze).or(reassign).or(escalate).first()).toBeVisible()
})
