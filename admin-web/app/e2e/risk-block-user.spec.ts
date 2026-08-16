import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

/**
 * Risk cases are faker-generated with a random status, so an actionable
 * (open / investigating) row is not guaranteed on any single load. Cycle the
 * drawer over every case row and reload for fresh mock data until the five
 * review action buttons appear.
 */
test('owner opens an actionable risk case and sees all five review actions', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  const casesRows = () => page.locator('table.table').nth(1).locator('tbody tr')
  const noCases = page.getByText('No risk cases').first()

  for (let attempt = 0; attempt < 12; attempt++) {
    await page.goto('/trust/risk-cases')
    const matrix = page.getByRole('table', { name: 'Risk cases by severity and status' })
    await expect(matrix).toBeVisible()
    await Promise.race([casesRows().first().waitFor(), noCases.waitFor()])
    if (await noCases.isVisible()) continue

    const count = await casesRows().count()
    for (let i = 0; i < count; i++) {
      await casesRows().nth(i).click()
      const drawer = page.getByRole('dialog')
      await expect(drawer).toBeVisible()
      if ((await drawer.getByRole('button', { name: 'Dismiss' }).count()) === 0) {
        await drawer.getByRole('button', { name: 'Close' }).click()
        await expect(drawer).not.toBeVisible()
        continue
      }
      for (const name of ['Dismiss', 'Block user', 'Block provider', 'Escalate', 'Hold']) {
        await expect(drawer.getByRole('button', { name })).toBeVisible()
      }
      return
    }
  }
  throw new Error('No actionable risk case found in the mock queue after 12 reloads')
})
