import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

test('hub dashboard loads the stat cards for a hub from the hubs page', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  let hubId = 'hub_1'
  await page.goto('/operations/hubs')
  const rows = page.locator('tbody tr.row-click')
  const empty = page.getByText('No hubs').first()
  await Promise.race([rows.first().waitFor(), empty.waitFor()])
  if ((await rows.count()) > 0) {
    await rows.first().click()
    const drawer = page.getByRole('dialog')
    await expect(drawer).toBeVisible()
    hubId = (await drawer.locator('.meta-item').first().locator('.meta-value').innerText()).trim()
    await drawer.getByRole('button', { name: 'Close' }).click()
    await expect(drawer).not.toBeVisible()
  }

  await page.goto('/operations/hubs/dashboard')
  await expect(page.getByRole('heading', { name: 'Hub dashboard' })).toBeVisible()
  await page.getByLabel('Hub ID').fill(hubId)
  await page.getByRole('button', { name: 'Load dashboard' }).click()

  const statCard = page.getByText('Incoming').first()
  const notFound = page.getByText('Hub not found').first()
  await Promise.race([statCard.waitFor(), notFound.waitFor()])
  if (await notFound.isVisible()) return

  for (const label of ['Incoming', 'Outgoing', 'Awaiting sort', 'Exceptions', 'Capacity']) {
    await expect(page.getByText(label).first()).toBeVisible()
  }
})
