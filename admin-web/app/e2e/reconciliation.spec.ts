import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

test('reconciliation shows outcomes and the anomalies tab', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  await page.goto('/logistics/reconciliation')
  const rows = page.locator('tbody tr.row-click')
  const empty = page.getByText('No consignments to reconcile').first()
  await Promise.race([rows.first().waitFor(), empty.waitFor()])

  if ((await rows.count()) === 0) {
    await expect(empty).toBeVisible()
    return
  }

  await expect(page.getByRole('button', { name: 'Reconcile outcomes' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Anomalies' })).toBeVisible()
  await expect(rows.first()).toBeVisible()

  await page.getByRole('button', { name: 'Anomalies' }).click()
  const anomalyRows = page.locator('tbody tr.row-click')
  const noAnomalies = page.getByText('No anomalies').first()
  await Promise.race([anomalyRows.first().waitFor(), noAnomalies.waitFor()])
  if ((await noAnomalies.count()) === 0) {
    await expect(anomalyRows.first()).toBeVisible()
  }
})
