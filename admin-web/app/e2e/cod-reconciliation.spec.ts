import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

test('owner views COD shifts for a rider and sees the totals row', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  for (let attempt = 0; attempt < 12; attempt++) {
    await page.goto('/logistics/riders/cod')
    const select = page.getByLabel('Rider')
    const noRiders = page.getByText('No riders available')
    await Promise.race([select.waitFor(), noRiders.waitFor()])
    if ((await noRiders.count()) > 0) continue

    const optionCount = await select.locator('option').count()
    if (optionCount <= 1) continue

    const riderIndex = 1 + (attempt % (optionCount - 1))
    await select.selectOption({ index: riderIndex })
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)

    const shiftsRow = page.locator('tbody tr').first()
    const emptyState = page.getByText('No shifts in this range')
    await Promise.race([shiftsRow.waitFor(), emptyState.waitFor()])

    if ((await emptyState.count()) > 0) continue

    const totals = page.locator('.row-total')
    if ((await totals.count()) > 0) {
      await expect(totals).toContainText('Totals')
      return
    }
  }
  throw new Error('No COD shifts with a totals row found after cycling riders')
})
