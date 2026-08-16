import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

/**
 * The MSW verify endpoint accepts any code and returns a faker-random
 * Voucher with 200, so a fixed lookup code is safe; the result card always
 * renders a status (or a dash in the per-field fallbacks).
 */
test('owner verifies a voucher code and sees the result card', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  await page.goto('/vouchers')
  await expect(page.getByText('Verify a voucher', { exact: true })).toBeVisible()

  await page.locator('#voucher-code').fill('E2E-TEST-VOUCHER')
  await page.getByRole('button', { name: 'Verify', exact: true }).click()

  const resultCard = page.locator('.state-card').filter({ hasText: 'Verification result' })
  await expect(resultCard).toBeVisible()
  await expect(resultCard.getByText('Code')).toBeVisible()
  await expect(resultCard.getByText('Status')).toBeVisible()
})
