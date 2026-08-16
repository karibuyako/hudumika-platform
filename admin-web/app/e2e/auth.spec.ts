import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

test('staff OTP login with MFA renders the owner console', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Staff sign-in')).toBeVisible()

  await page.getByLabel('Staff phone').fill(OWNER_PHONE)
  await page.getByRole('button', { name: 'Send code' }).click()

  await expect(page.getByLabel('One-time code')).toBeVisible()
  await page.getByLabel('One-time code').fill('123456')
  await page.getByRole('button', { name: 'Verify' }).click()

  await expect(page.getByRole('link', { name: 'Control Tower' }).first()).toBeVisible()
  await expect(page.locator('.badge')).toContainText('Platform Owner')
  await expect(page.getByText('MFA verified')).toBeVisible()
})
