import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

/**
 * Moderation is keyed by review ID and the MSW handler accepts any ID,
 * returning a faker-random Review with 200, so a fixed lookup ID is safe.
 */
test('owner publishes a review by ID and sees the moderation result panel', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  await page.goto('/reviews')
  await expect(page.getByText('Review ID', { exact: true })).toBeVisible()

  await page.locator('#review-id').fill('rev_e2e_publish')
  await page.getByRole('button', { name: 'Look up' }).click()

  await expect(page.getByText('Moderate review')).toBeVisible()
  await page.getByRole('button', { name: 'Publish', exact: true }).click()

  const modal = page.getByRole('dialog', { name: 'Moderate review' })
  await expect(modal).toBeVisible()
  await modal.locator('#reason').fill('Verified review content; owner approved publishing.')
  await modal.getByRole('button', { name: 'Confirm' }).click()

  await expect(page.getByRole('status')).toContainText('published')
  await expect(page.getByText('Rating', { exact: true })).toBeVisible()
  await expect(page.getByText('Author', { exact: true })).toBeVisible()
  await expect(page.getByText('Target', { exact: true })).toBeVisible()
})
