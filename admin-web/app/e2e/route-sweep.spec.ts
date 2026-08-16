import { test, expect, type Page } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

/**
 * Route sweep — every console route must render against the MSW mocks:
 * navigate, let the loading skeleton settle, and assert the content area
 * rendered something (a crashed route leaves the shell content empty).
 */
const ROUTES: Array<{ path: string; note?: string }> = [
  { path: '/' },
  { path: '/admin/map' },
  { path: '/analytics' },
  { path: '/audit/approvals' },
  { path: '/audit/logs' },
  { path: '/bookings' },
  { path: '/carriers' },
  { path: '/catalogue' },
  { path: '/chains' },
  { path: '/commerce/merchants' },
  { path: '/commerce/orders' },
  { path: '/compliance' },
  { path: '/configuration/commissions' },
  { path: '/configuration/feature-flags' },
  { path: '/configuration/integrations' },
  { path: '/configuration/regions' },
  { path: '/configuration/sla' },
  { path: '/content' },
  { path: '/content/help' },
  { path: '/conversations' },
  { path: '/customers' },
  { path: '/exports' },
  { path: '/facilities' },
  { path: '/finance/ledger' },
  { path: '/finance/payments' },
  { path: '/finance/refunds' },
  { path: '/fleet-accounts' },
  { path: '/group-buys' },
  { path: '/growth/loyalty' },
  { path: '/growth/promotions' },
  { path: '/iam/sessions' },
  { path: '/iam/users' },
  { path: '/logistics/control-tower' },
  { path: '/logistics/reconciliation' },
  { path: '/logistics/riders' },
  { path: '/logistics/riders/cod' },
  { path: '/logistics/shipments' },
  { path: '/logistics/warehouses' },
  { path: '/logistics/waybills' },
  { path: '/operations/consignments' },
  { path: '/operations/dispatch' },
  { path: '/operations/dispatch-monitor' },
  { path: '/operations/exceptions' },
  { path: '/operations/fleet' },
  { path: '/operations/fleet-tower' },
  { path: '/operations/hubs' },
  { path: '/operations/hubs/dashboard' },
  { path: '/operations/overview' },
  { path: '/reviews' },
  { path: '/search?q=ORD-', note: 'global search requires a query' },
  { path: '/services/providers' },
  { path: '/support/inbox' },
  { path: '/trust/risk-cases' },
  { path: '/vouchers' },
  { path: '/webhooks' },
]

test.describe('route sweep', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await staffLogin(page, OWNER_PHONE)
  })

  test.afterAll(async () => {
    await page.close()
  })

  for (const { path, note } of ROUTES) {
    test(`renders ${path}`, async () => {
      await page.goto(path)
      // Let any loading skeleton settle (skeleton tables carry aria-busy).
      await page
        .locator('main [aria-busy="true"]')
        .first()
        .waitFor({ state: 'hidden', timeout: 15_000 })
        .catch(() => {})
      const main = page.locator('main').first()
      await expect(main).toBeVisible()
      // The content area must not be empty — a crashed route renders nothing.
      await expect(main).not.toBeEmpty({ timeout: 10_000 })
      // The shell must still be the console (not bounced back to login).
      await expect(page.locator('.sidebar')).toBeVisible()
      if (note) test.info().annotations.push({ type: 'note', description: note })
    })
  }
})
