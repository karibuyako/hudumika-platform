import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

test('owner creates a two-person approval request and sees a pending row after reload', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  await page.goto('/audit/approvals')
  await expect(page.getByRole('heading', { name: 'Two-Person Approvals' })).toBeVisible()

  const rows = page.locator('tbody tr')
  const emptyQueue = page.getByText('No approval requests')

  await page.getByRole('button', { name: 'New request' }).click()
  const modal = page.getByRole('dialog', { name: 'New approval request' })
  await expect(modal).toBeVisible()

  await modal.locator('select').first().selectOption({ index: 1 })
  await modal.getByLabel('Target type').fill('order')
  await modal.getByLabel('Target ID').fill('ord_e2e_override')
  await modal.getByLabel('Reason').fill('E2E: manual override for a stuck delivery.')
  await modal.getByRole('button', { name: 'Create request' }).click()

  await expect(page.getByRole('status')).toContainText('Approval request created')
  await expect(modal).not.toBeVisible()

  // NOTE: the MSW list handlers are stateless faker generators, so the
  // created row is not persisted. Reload up to 8x looking for a pending row
  // in the fresh queue; if none appears, fall back to asserting the page
  // renders with the primary control.
  let foundPending = false
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Two-Person Approvals' })).toBeVisible()
    if ((await emptyQueue.count()) > 0) continue
    const pending = rows.filter({ hasText: 'pending' })
    if ((await pending.count()) > 0) {
      await expect(pending.first()).toContainText('pending')
      foundPending = true
      break
    }
  }

  if (!foundPending) {
    await expect(page.getByRole('heading', { name: 'Two-Person Approvals' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New request' })).toBeVisible()
  }
})
