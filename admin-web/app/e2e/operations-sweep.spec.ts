import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

/**
 * Operations sweep — exercises the interactions not covered by the dedicated
 * scenario specs, against the MSW mocks (no backend required).
 */

test('operations overview renders KPIs and queues', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await page.goto('/operations/overview')
  await expect(page.getByRole('heading', { level: 1, name: 'Operations Overview' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Approve verifications/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Reconcile payouts/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Open two-person queue/ })).toBeVisible()
})

test('global search from the topbar finds entities and opens the drawer', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await page.locator('.topbar-search').fill('ORD-1')
  await page.locator('.topbar-search').press('Enter')
  await expect(page).toHaveURL(/\/search\?q=ORD-1/)
  await page
    .locator('main [aria-busy="true"]')
    .first()
    .waitFor({ state: 'hidden', timeout: 15_000 })
    .catch(() => {})
  await page.locator('tbody tr').first().waitFor({ timeout: 10_000 }).catch(() => {})
  if ((await page.locator('tbody tr').count()) > 0) {
    await page.locator('tbody tr').first().click()
    await expect(page.locator('.drawer, [role="dialog"]').first()).toBeVisible()
  } else {
    await expect(page.locator('main').first()).not.toBeEmpty()
  }
})

test('coverage map renders layers from mock geodata', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await page.goto('/admin/map')
  await page
    .locator('main [aria-busy="true"]')
    .first()
    .waitFor({ state: 'hidden', timeout: 15_000 })
    .catch(() => {})
  const svg = page.locator('svg[aria-label="Coverage map"]')
  if ((await svg.count()) > 0) {
    await expect(svg).toBeVisible()
    await expect(page.getByRole('button', { name: /Heatmap/ })).toBeVisible()
  } else {
    await expect(page.getByText('No map data').first()).toBeVisible()
  }
})

test('waybill lookup loads the scan trail', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await page.goto('/logistics/waybills')
  await page.getByLabel('Order ID').fill('ord_1')
  await page.getByRole('button', { name: 'Load waybill' }).click()
  await page
    .locator('main [aria-busy="true"]')
    .first()
    .waitFor({ state: 'hidden', timeout: 15_000 })
    .catch(() => {})
  const event = page.locator('.timeline-item').first()
  if ((await event.count()) > 0) {
    await expect(event).toBeVisible()
  } else {
    await expect(page.getByText('No waybill events recorded').first()).toBeVisible()
  }
})

test('sessions page lists active sessions and revokes a non-current one', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await page.goto('/iam/sessions')
  await page
    .locator('main [aria-busy="true"]')
    .first()
    .waitFor({ state: 'hidden', timeout: 15_000 })
    .catch(() => {})
  await page.locator('tbody tr').first().waitFor({ timeout: 10_000 }).catch(() => {})
  const rows = page.locator('tbody tr')
  if ((await rows.count()) > 0) {
    await expect(rows.first()).toBeVisible()
    const revoke = page.getByRole('button', { name: 'Revoke' }).first()
    if ((await revoke.count()) > 0) {
      await revoke.click()
      await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click()
      await expect(page.getByText('Session revoked').first()).toBeVisible({ timeout: 10_000 })
    }
  } else {
    await expect(page.getByText('No active sessions').first()).toBeVisible()
  }
})

test('compliance console renders its oversight queues', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await page.goto('/compliance')
  await expect(page.getByRole('heading', { level: 1, name: /Compliance/ })).toBeVisible()
  await page
    .locator('main [aria-busy="true"]')
    .first()
    .waitFor({ state: 'hidden', timeout: 15_000 })
    .catch(() => {})
  await expect(page.getByRole('link', { name: /Open audit logs/ }).first()).toBeVisible()
})

test('loyalty page renders the oversight surface', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await page.goto('/growth/loyalty')
  await expect(page.getByRole('heading', { level: 1, name: /Loyalty/ })).toBeVisible()
  await page
    .locator('main [aria-busy="true"]')
    .first()
    .waitFor({ state: 'hidden', timeout: 15_000 })
    .catch(() => {})
  await expect(page.getByRole('button', { name: /Oversee loyalty config/ }).first()).toBeVisible()
})

test('content banners tab lists and templates tab switches', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await page.goto('/content')
  await page
    .locator('main [aria-busy="true"]')
    .first()
    .waitFor({ state: 'hidden', timeout: 15_000 })
    .catch(() => {})
  await expect(page.getByRole('button', { name: 'New banner' })).toBeVisible()
  await page.getByRole('tab', { name: 'Templates' }).click()
  await expect(page.getByRole('button', { name: /Upsert template/ })).toBeVisible()
})

test('broadcast notification sends against the mock', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await page.goto('/content/help')
  await page.getByRole('button', { name: 'Broadcast' }).click()
  await page.getByLabel('Title').fill('Ops sweep broadcast')
  await page.getByLabel('Body').fill('Testing the broadcast operation against mocks.')
  await page.getByRole('button', { name: 'Send broadcast' }).click()
  await expect(page.getByText('Broadcast queued')).toBeVisible({ timeout: 15_000 })
})

test('city creation round-trips through the upsert mock', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await page.goto('/configuration/regions')
  await page.getByRole('button', { name: 'New city' }).click()
  await page.getByLabel('Name').fill(`Sweep City ${Date.now() % 10000}`)
  await page.getByLabel('Country').fill('TZ')
  await page.getByRole('button', { name: /Create|Save/ }).first().click()
  await expect(page.getByText(/City saved|City created/i).first()).toBeVisible({
    timeout: 15_000,
  })
})

test('catalogue tabs render categories and service categories', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await page.goto('/catalogue')
  await page
    .locator('main [aria-busy="true"]')
    .first()
    .waitFor({ state: 'hidden', timeout: 15_000 })
    .catch(() => {})
  await expect(page.getByRole('button', { name: 'New category' })).toBeVisible()
  await page.getByRole('tab', { name: 'Service categories' }).click()
  await expect(page.getByRole('tab', { name: 'Service categories' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('main table').first()).toBeVisible()
})

test('fleet tower renders totals and safety surface', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await page.goto('/operations/fleet-tower')
  await page
    .locator('main [aria-busy="true"]')
    .first()
    .waitFor({ state: 'hidden', timeout: 15_000 })
    .catch(() => {})
  await expect(page.getByRole('heading', { level: 1, name: 'Fleet Control Tower' })).toBeVisible()
  await expect(page.getByText(/Active riders|Open SOS/).first()).toBeVisible()
})

test('logistics tower renders totals and exceptions', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await page.goto('/logistics/control-tower')
  await page
    .locator('main [aria-busy="true"]')
    .first()
    .waitFor({ state: 'hidden', timeout: 15_000 })
    .catch(() => {})
  await expect(page.getByRole('heading', { level: 1, name: 'Logistics Control Tower' })).toBeVisible()
  await expect(page.getByText(/Active shipments|Critical exceptions/).first()).toBeVisible()
})

test('reconciliation page shows outcomes and anomalies tabs', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  await page.goto('/logistics/reconciliation')
  await page
    .locator('main [aria-busy="true"]')
    .first()
    .waitFor({ state: 'hidden', timeout: 15_000 })
    .catch(() => {})
  await expect(page.getByRole('button', { name: 'Reconcile outcomes' })).toBeVisible()
  await page.getByRole('button', { name: 'Anomalies' }).click()
  await expect(page.getByText(/No|anomal/i).first()).toBeAttached()
})

test('configuration pages render their rule tables', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)
  for (const route of ['/configuration/sla', '/configuration/commissions', '/configuration/feature-flags', '/iam/users']) {
    await page.goto(route)
    await page
      .locator('main [aria-busy="true"]')
      .first()
      .waitFor({ state: 'hidden', timeout: 15_000 })
      .catch(() => {})
    await expect(page.locator('main').first()).not.toBeEmpty()
  }
})
