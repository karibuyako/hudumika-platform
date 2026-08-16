import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/setup'
import { toLocal } from '../../lib/time'
import type { AdminIntegrationHealth200Item } from '@hudumika/contract'
import { IntegrationHealthPage } from './IntegrationHealthPage'

const LONG_ERROR =
  'SMS delivery latency above 2s for the last 15 minutes — investigating provider incident'

const ITEMS: AdminIntegrationHealth200Item[] = [
  { provider: 'vodacom-mpesa', category: 'payment', health: 'healthy', lastCheckedAt: '2026-08-15T08:00:00Z' },
  { provider: 'twilio-sms', category: 'sms', health: 'degraded', error: LONG_ERROR },
  { provider: 'google-maps', category: 'maps', health: 'down', error: 'Geocoding API 500s' },
]

describe('IntegrationHealthPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows rows after loading', async () => {
    server.use(http.get('*/admin/integrations', () => HttpResponse.json(ITEMS)))
    render(<IntegrationHealthPage />)

    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
    expect(await screen.findByText('vodacom-mpesa')).toBeInTheDocument()
    expect(screen.getByText('twilio-sms')).toBeInTheDocument()
    expect(screen.getByText('google-maps')).toBeInTheDocument()
    expect(screen.getByText('degraded')).toBeInTheDocument()
    expect(screen.getByText(toLocal('2026-08-15T08:00:00Z'))).toBeInTheDocument()
  })

  it('filters by category client-side with counts', async () => {
    server.use(http.get('*/admin/integrations', () => HttpResponse.json(ITEMS)))
    render(<IntegrationHealthPage />)
    await screen.findByText('vodacom-mpesa')

    const group = screen.getByRole('group', { name: 'Integration category filters' })
    expect(within(group).getByRole('button', { name: /^payment/ })).toHaveTextContent('1')
    expect(within(group).getByRole('button', { name: /^sms/ })).toHaveTextContent('1')

    await userEvent.click(within(group).getByRole('button', { name: /^sms/ }))

    expect(screen.getByText('twilio-sms')).toBeInTheDocument()
    expect(screen.queryByText('vodacom-mpesa')).not.toBeInTheDocument()
    expect(screen.queryByText('google-maps')).not.toBeInTheDocument()
  })

  it('shows the empty state when no integrations are registered', async () => {
    server.use(http.get('*/admin/integrations', () => HttpResponse.json([])))
    render(<IntegrationHealthPage />)

    expect(await screen.findByText('No integrations registered')).toBeInTheDocument()
  })

  it('shows an error state and retries', async () => {
    let calls = 0
    server.use(
      http.get('*/admin/integrations', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'FORBIDDEN', message: 'nope', requestId: 'r-1' }, { status: 403 })
        }
        return HttpResponse.json(ITEMS)
      }),
    )
    render(<IntegrationHealthPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load integrations')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('vodacom-mpesa')).toBeInTheDocument()
  })

  it('opens a drawer with full details', async () => {
    server.use(http.get('*/admin/integrations', () => HttpResponse.json(ITEMS)))
    render(<IntegrationHealthPage />)

    await userEvent.click(await screen.findByText('twilio-sms'))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getAllByText('twilio-sms').length).toBeGreaterThan(0)
    expect(within(dialog).getByText('sms')).toBeInTheDocument()
    expect(within(dialog).getByText('degraded')).toBeInTheDocument()
    expect(within(dialog).getByText(LONG_ERROR)).toBeInTheDocument()
    expect(within(dialog).getByText(/audited \(integration_health\.\*\)/)).toBeInTheDocument()

    const truncated = screen.getByTitle(LONG_ERROR)
    expect(truncated.textContent).toContain('…')
  })

  it('shows a notice banner when payment integrations are down', async () => {
    server.use(
      http.get('*/admin/integrations', () =>
        HttpResponse.json([
          ...ITEMS,
          { provider: 'airtel-money', category: 'payment', health: 'down', error: 'API 500s' },
          { provider: 'tigo-pesa', category: 'payment', health: 'down', error: 'timeout' },
        ]),
      ),
    )
    render(<IntegrationHealthPage />)
    await screen.findByText('vodacom-mpesa')

    expect(
      screen.getByText('Payment provider down — 2 payment integration(s) failing'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Payment integration degraded')).not.toBeInTheDocument()
  })

  it('shows a muted degraded hint when payment integrations are degraded but not down', async () => {
    server.use(
      http.get('*/admin/integrations', () =>
        HttpResponse.json([
          { provider: 'vodacom-mpesa', category: 'payment', health: 'degraded', error: 'latency' },
          { provider: 'twilio-sms', category: 'sms', health: 'down', error: 'SMS down' },
        ]),
      ),
    )
    render(<IntegrationHealthPage />)
    await screen.findByText('vodacom-mpesa')

    expect(screen.getByText('Payment integration degraded')).toBeInTheDocument()
    expect(screen.queryByText(/Payment provider down/)).not.toBeInTheDocument()
  })

  it('sorts rows by provider via the column header', async () => {
    server.use(http.get('*/admin/integrations', () => HttpResponse.json(ITEMS)))
    render(<IntegrationHealthPage />)
    await screen.findByText('vodacom-mpesa')

    await userEvent.click(screen.getByRole('button', { name: /Provider/ }))

    const table = screen.getByRole('table', { name: 'Integration health' })
    const providers = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(providers).toEqual(['google-maps', 'twilio-sms', 'vodacom-mpesa'])

    await userEvent.click(screen.getByRole('button', { name: /Provider/ }))
    const desc = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(desc).toEqual(['vodacom-mpesa', 'twilio-sms', 'google-maps'])
  })

  it('exports integrations as CSV via the DataTable', async () => {
    server.use(http.get('*/admin/integrations', () => HttpResponse.json(ITEMS)))
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let downloadName = ''
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadName = this.download
      })
    render(<IntegrationHealthPage />)
    await screen.findByText('vodacom-mpesa')

    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(downloadName).toBe('integration-health.csv')
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Provider,Category,Health,Last checked,Error')
    expect(csv).toContain('vodacom-mpesa')
    expect(csv).toContain(toLocal('2026-08-15T08:00:00Z'))
    expect(revokeObjectURL).toHaveBeenCalled()
  })
})
