import { test, expect, type Page } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

/**
 * The MSW merchant list is faker-generated, so an actionable (pending /
 * documents_review / changes_requested) row is not guaranteed on any single
 * load. Cycle the drawer over every row and reload for fresh mock data until
 * an Approve action appears, then complete the approval.
 */
async function openActionableMerchant(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.goto('/commerce/merchants')
    const rows = page.locator('tbody tr')
    await rows.first().waitFor()

    const count = await rows.count()
    for (let i = 0; i < count; i++) {
      await rows.nth(i).click()
      const drawer = page.getByRole('dialog')
      const approve = drawer.getByRole('button', { name: 'Approve' })
      if ((await approve.count()) > 0) return
      await drawer.getByRole('button', { name: 'Close' }).click()
      await expect(drawer).not.toBeVisible()
    }
  }
  throw new Error('No actionable merchant found in the mock queue after 12 reloads')
}

test('owner approves a pending merchant with a reason', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await openActionableMerchant(page)

  const drawer = page.getByRole('dialog')
  await drawer.getByRole('button', { name: 'Approve' }).click()

  const modal = page.getByRole('dialog', { name: 'Approve merchant' })
  await expect(modal).toBeVisible()
  await modal.locator('#approve-reason').fill('Verified documents and terms; owner approved.')
  await modal.getByRole('button', { name: 'Confirm' }).click()

  await expect(page.getByRole('status')).toContainText('approved')
  await expect(page.getByRole('dialog')).not.toBeVisible()
})
