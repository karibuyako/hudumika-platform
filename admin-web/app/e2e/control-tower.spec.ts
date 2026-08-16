import { test, expect } from '@playwright/test'
import { staffLogin, OWNER_PHONE } from './helpers'

const CRITICAL_ACTION_LINKS: Array<[label: string, href: string]> = [
  ['Shipment exceptions', '/operations/exceptions'],
  ['Provider incidents', '/services/providers'],
  ['Payment failures', '/finance/payments'],
  ['Fraud cases', '/trust/risk-cases'],
  ['SLA breaches', '/configuration/sla'],
  ['Hub capacity warnings', '/operations/hubs'],
]

test('control tower renders stat cards and the six critical action deep links', async ({ page }) => {
  await staffLogin(page, OWNER_PHONE)

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Operations Control Tower' })).toBeVisible()

  for (const label of [
    'Orders today',
    'Active deliveries',
    'Active service jobs',
    'Providers online',
    'Riders online',
    'Open incidents',
    'Delayed shipments',
    'Pending disputes',
  ]) {
    await expect(page.getByText(label)).toBeVisible()
  }

  for (const [label, href] of CRITICAL_ACTION_LINKS) {
    const link = page.getByRole('link', { name: label })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', href)
  }
})
