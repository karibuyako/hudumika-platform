import { test, expect, type Locator, type Page } from '@playwright/test'
import { staffLogin, waitForTableRows, OWNER_PHONE } from './helpers'

/**
 * MSW group buy statuses are faker-random and some deals have no id
 * (`arrayElement([uuid, undefined])`), so a decision on an id-less deal
 * fails with a modal alert. Cycle rows and reloads, retrying the reject on
 * another pending_review deal when the request fails, until the toast lands.
 */
async function tryReject(page: Page, drawer: Locator): Promise<boolean> {
  await drawer.getByRole('button', { name: 'Reject' }).click()

  const modal = page.getByRole('dialog', { name: 'Reject group buy deal' })
  await expect(modal).toBeVisible()
  await modal.locator('#reason').fill('Deal violates pricing guidelines; owner rejected.')
  await modal.getByRole('button', { name: 'Confirm' }).click()

  const toast = page.getByRole('status')
  const alert = modal.getByRole('alert')
  await Promise.race([toast.waitFor({ state: 'visible' }), alert.waitFor({ state: 'visible' })])

  if ((await toast.count()) > 0) return true

  await modal.getByRole('button', { name: 'Cancel' }).click()
  await expect(modal).not.toBeVisible()
  await drawer.getByRole('button', { name: 'Close' }).click()
  await expect(drawer).not.toBeVisible()
  return false
}

async function rejectPendingGroupBuy(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.goto('/group-buys')
    await waitForTableRows(page)
    const rows = page.locator('tbody tr')

    const count = await rows.count()
    for (let i = 0; i < count; i++) {
      await rows.nth(i).click()
      const drawer = page.getByRole('dialog')
      await expect(drawer).toBeVisible()
      if ((await drawer.getByRole('button', { name: 'Reject' }).count()) === 0) {
        await drawer.getByRole('button', { name: 'Close' }).click()
        await expect(drawer).not.toBeVisible()
        continue
      }
      if (await tryReject(page, drawer)) return
    }
  }
  throw new Error('No id-bearing pending_review group buy deal rejected after 12 reloads')
}

test('owner rejects a pending group buy deal with a reason', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await rejectPendingGroupBuy(page)

  await expect(page.getByRole('status')).toContainText('rejected')
})
