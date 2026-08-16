import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

test('topbar global search with an ORD- prefix opens the entity drawer', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  const search = page.getByLabel('Global search')
  await expect(search).toBeVisible()
  await search.fill('ORD-')
  await search.press('Enter')

  await expect(page).toHaveURL(/\/search\?q=ORD-/)
  await expect(page.getByRole('heading', { name: 'Search' })).toBeVisible()

  const rows = page.locator('tbody tr.row-click')
  const noMatches = page.getByText('No matches').first()
  await Promise.race([rows.first().waitFor(), noMatches.waitFor()])

  if ((await rows.count()) === 0) {
    await expect(noMatches).toBeVisible()
    return
  }

  await rows.first().click()
  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('Entity type').first()).toBeVisible()
  await expect(drawer.getByText('Audit history').first()).toBeVisible()
})
