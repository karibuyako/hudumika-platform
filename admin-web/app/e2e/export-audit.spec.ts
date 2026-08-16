import { test, expect } from '@playwright/test'
import { staffLogin, waitForTableRows, OWNER_PHONE } from './helpers'

test('owner sees the data export job list and the new report control', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  await page.goto('/exports')
  await expect(page.getByRole('heading', { name: 'Data exports' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New report' })).toBeVisible()

  await waitForTableRows(page)
  const hasJobs = (await page.locator('tbody tr td .mono').count()) > 0
  const isEmpty = (await page.getByText('No export jobs').count()) > 0
  expect(hasJobs || isEmpty).toBe(true)
})
