import { expect, type Page } from '@playwright/test'

export const OWNER_PHONE = '+255 700 000 001'
export const OPS_MANAGER_PHONE = '+255 700 000 002'
export const AUDITOR_PHONE = '+255 700 000 003'

/**
 * Staff OTP login against the MSW browser worker. The generated mock accepts
 * any one-time code, so '123456' is used throughout.
 */
export async function staffLogin(page: Page, phone: string) {
  await page.goto('/')
  await expect(page.getByText('Staff sign-in')).toBeVisible()
  await page.getByLabel('Staff phone').fill(phone)
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(page.getByLabel('One-time code')).toBeVisible()
  await page.getByLabel('One-time code').fill('123456')
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
}

/**
 * Wait for a real data table. LoadingSkeleton also renders `tbody tr`, so
 * waiting for a row alone can match skeleton rows; require the aria-busy
 * table to be gone (data loaded) before returning.
 */
export async function waitForTableRows(page: Page) {
  await page.locator('tbody tr').first().waitFor()
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
  await expect(page.locator('tbody tr').first()).toBeVisible()
}
