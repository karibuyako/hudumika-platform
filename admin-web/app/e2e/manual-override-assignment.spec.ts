import { test, expect, type Page } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

/**
 * MSW order statuses and rider verification states are faker-random. A row
 * only appears in the assignment queue when it is paid/merchant_accepted/
 * preparing with no rider, and riders only become clickable when at least
 * one is verification-approved. Reload until both conditions hold.
 */
async function openAssignableDispatch(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.goto('/operations/dispatch')
    const queueHeading = page.getByRole('heading', { name: 'Assignment queue', exact: true })
    await queueHeading.waitFor()
    const queue = page.locator('section').filter({ has: queueHeading })

    if ((await page.getByText('Dispatch console unavailable').count()) > 0) continue
    if ((await queue.getByText('No orders awaiting dispatch').count()) > 0) continue
    if ((await page.locator('.rider-card').count()) === 0) continue
    if ((await queue.getByRole('button', { name: 'Assign' }).count()) === 0) continue
    return
  }
  throw new Error('No assignable order with an approved rider found in the mock queue after 12 reloads')
}

test('owner manually assigns an order to a rider with a reason', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await openAssignableDispatch(page)

  const queue = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Assignment queue', exact: true }),
  })
  await queue.getByRole('button', { name: 'Assign' }).first().click()
  const riderCard = page.locator('.rider-card').first()
  await expect(riderCard).toBeEnabled()

  await riderCard.click()
  const modal = page.getByRole('dialog', { name: 'Assign order' })
  await expect(modal).toBeVisible()
  await modal.locator('#reason').fill('Manual override assignment to keep the delivery on time.')
  await modal.getByRole('button', { name: 'Confirm' }).click()

  await expect(page.locator('.notice')).toContainText('assigned to')
})
