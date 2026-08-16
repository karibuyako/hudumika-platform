import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ExportAnalyticsReport200 } from '@hudumika/contract'
import { AnalyticsPage } from './AnalyticsPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

function seedAnalytics(data: Record<string, unknown>, capture?: (url: string) => void) {
  server.use(
    http.get('*/admin/analytics/:scope', ({ request }) => {
      capture?.(request.url)
      return HttpResponse.json(data)
    }),
  )
}

describe('AnalyticsPage', () => {
  it('refetches with the selected scope in the URL', async () => {
    const urls: string[] = []
    seedAnalytics({ ordersToday: 42 }, (url) => urls.push(url))
    render(<AnalyticsPage />)

    await screen.findByText('ordersToday')

    fireEvent.click(screen.getByRole('button', { name: 'Orders' }))

    await waitFor(() => {
      expect(urls.some((u) => u.includes('/admin/analytics/orders'))).toBe(true)
    })
  })

  it('shows the empty state for an empty payload', async () => {
    seedAnalytics({})
    render(<AnalyticsPage />)

    expect(await screen.findByText('No analytics data for this scope and range')).toBeInTheDocument()
    expect(
      screen.getByText(
        'The analytics endpoint returns opaque data; structured dashboards ship with the analytics milestone',
      ),
    ).toBeInTheDocument()
  })

  it('shows an error and recovers via Retry', async () => {
    server.use(
      http.get('*/admin/analytics/:scope', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'analytics access denied' }, { status: 403 }),
      ),
    )
    render(<AnalyticsPage />)

    expect(await screen.findByText('Failed to load analytics')).toBeInTheDocument()
    expect(screen.getByText('analytics access denied')).toBeInTheDocument()

    seedAnalytics({ ordersToday: 1 })
    fireEvent.click(screen.getByText('Retry'))

    expect(await screen.findByText('ordersToday')).toBeInTheDocument()
  })

  it('renders key/value rows and formats TZS keys with formatTZS', async () => {
    seedAnalytics({ ordersToday: 42, revenueTZS: 150000 })
    render(<AnalyticsPage />)

    expect(await screen.findByText('ordersToday')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('revenueTZS')).toBeInTheDocument()
    expect(screen.getByText('TZS 150,000')).toBeInTheDocument()
  })

  it('exports the current scope and range and shows the success toast', async () => {
    seedAnalytics({ ordersToday: 42 })
    render(<AnalyticsPage />)
    await screen.findByText('ordersToday')

    let captured: unknown = null
    server.use(
      http.post('*/analytics/reports/export', async ({ request }) => {
        captured = await request.json()
        return HttpResponse.json<ExportAnalyticsReport200>({
          downloadUrl: 'https://cdn.example.test/analytics.csv',
          expiresInSeconds: 900,
        })
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Export report' }))

    await waitFor(() => {
      expect(captured).toEqual({ reportType: 'revenue', from: '', to: '' })
    })
    expect(await screen.findByText('Report exported — logged')).toBeInTheDocument()
  })

  it('hides the export action without export.request', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seedAnalytics({ ordersToday: 42 })
    render(<AnalyticsPage />)

    await screen.findByText('ordersToday')
    expect(screen.queryByRole('button', { name: 'Export report' })).not.toBeInTheDocument()
  })
})
