import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { OperationsOverviewPage } from './OperationsOverviewPage'
import { server } from '../../test/setup'

function seed(overview: Record<string, unknown>) {
  server.use(http.get('/admin/overview', () => HttpResponse.json(overview)))
}

function renderPage() {
  return render(
    <MemoryRouter>
      <OperationsOverviewPage />
    </MemoryRouter>,
  )
}

describe('OperationsOverviewPage', () => {
  it('renders metrics and queues after loading', async () => {
    seed({
      metrics: { activeOrders: 12, activeBookings: 3, pendingApprovals: 2, openTickets: 5, pendingPayoutsTZS: 1500000, exceptions: 1 },
      queue: [
        { name: 'Merchant approvals', count: 2 },
        { name: 'Refund requests', count: 4 },
      ],
    })
    renderPage()

    expect(await screen.findByText('12')).toBeInTheDocument()
    expect(screen.getByText('TZS 1,500,000')).toBeInTheDocument()
    expect(screen.getByText('Merchant approvals')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
  })

  it('shows empty states when there is no data', async () => {
    seed({ metrics: {}, queue: [] })
    renderPage()
    expect(await screen.findByText('No live metrics')).toBeInTheDocument()
    expect(screen.getByText('No open queues')).toBeInTheDocument()
  })

  it('shows error state with retry when the API fails', async () => {
    server.use(http.get('/admin/overview', () => HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 })))
    renderPage()
    expect(await screen.findByText('Overview unavailable')).toBeInTheDocument()
  })

  it('recovers via retry', async () => {
    server.use(http.get('/admin/overview', () => HttpResponse.json({ code: 'X', message: 'down' }, { status: 503 })))
    renderPage()
    server.use(
      http.get('/admin/overview', () =>
        HttpResponse.json({
          metrics: { activeOrders: 1 },
          queue: [{ name: 'Refund requests', count: 1 }],
        }),
      ),
    )
    const retry = await screen.findByRole('button', { name: 'Retry' })
    retry.click()
    expect(await screen.findByText('Refund requests')).toBeInTheDocument()
  })

  it('renders the four quick-action links with the right hrefs', async () => {
    seed({ metrics: {}, queue: [] })
    renderPage()

    expect(await screen.findByRole('link', { name: 'Approve verifications' })).toHaveAttribute(
      'href',
      '/commerce/merchants',
    )
    expect(screen.getByRole('link', { name: 'Reconcile payouts' })).toHaveAttribute('href', '/finance/payments')
    expect(screen.getByRole('link', { name: 'Open two-person queue' })).toHaveAttribute('href', '/audit/approvals')
    expect(screen.getByRole('link', { name: 'New report' })).toHaveAttribute('href', '/exports')
  })
})
