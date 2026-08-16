import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

test('owner creates a hub from the hubs page and sees the confirmation toast', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  await page.goto('/operations/hubs')
  const rows = page.locator('tbody tr.row-click')
  const empty = page.getByText('No hubs').first()
  await Promise.race([rows.first().waitFor(), empty.waitFor()])
  await expect(page.getByRole('heading', { name: 'Hubs' })).toBeVisible()

  await page.getByRole('button', { name: 'New hub' }).click()
  const modal = page.getByRole('dialog', { name: 'New hub' })
  await expect(modal).toBeVisible()
  await modal.getByLabel('Name').fill('E2E Test Hub')
  await modal.getByLabel('City').fill('city_e2e_dar_es_salaam')
  await modal.getByRole('button', { name: 'Create' }).click()

  await expect(page.getByRole('status')).toContainText('Hub created')
  await expect(modal).not.toBeVisible()
})
