import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { PromotionsPage } from './PromotionsPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const PENDING: Record<string, unknown> = {
  id: 'prom_1',
  merchantId: 'mrc_1',
  type: 'discount',
  title: 'Mama Mia 20% Off',
  description: 'Weekend discount on all pizzas.',
  status: 'pending_review',
  couponAmountTZS: null,
  thresholdTZS: null,
  discountRateBps: 2000,
  budgetTZS: 500000,
  startsAt: '2026-08-20T08:00:00.000Z',
  endsAt: '2026-09-20T23:00:00.000Z',
  redeemCount: 0,
  spendTZS: 0,
  impressions: 0,
  clicks: 0,
  attributedOrders: 0,
  attributedRevenueTZS: 0,
  rejectReason: null,
}

const LIVE: Record<string, unknown> = {
  id: 'prom_2',
  merchantId: 'mrc_2',
  type: 'free_delivery',
  title: 'Free Delivery Weekend',
  description: 'Free delivery on orders above TZS 20,000.',
  status: 'live',
  couponAmountTZS: 2000,
  thresholdTZS: 20000,
  discountRateBps: null,
  budgetTZS: 1000000,
  startsAt: '2026-08-01T08:00:00.000Z',
  endsAt: '2026-08-31T23:00:00.000Z',
  redeemCount: 45,
  spendTZS: 120000,
  impressions: 2300,
  clicks: 310,
  attributedOrders: 22,
  attributedRevenueTZS: 1800000,
  rejectReason: null,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PromotionsPage', () => {
  it('renders promotion rows after loading', async () => {
    server.use(http.get('/admin/promotions', () => HttpResponse.json([PENDING, LIVE])))
    render(<PromotionsPage />)

    expect(await screen.findByText('Mama Mia 20% Off')).toBeInTheDocument()
    expect(screen.getByText('Free Delivery Weekend')).toBeInTheDocument()
    expect(screen.getByText('discount')).toBeInTheDocument()
    expect(screen.getAllByText('pending review').length).toBeGreaterThan(0)
    expect(screen.getByText('TZS 500,000')).toBeInTheDocument()
    expect(screen.getByText('20%')).toBeInTheDocument()
  })

  it('refetches with the state param when a status chip is clicked', async () => {
    let lastState: string | null = null
    server.use(
      http.get('/admin/promotions', ({ request }) => {
        const url = new URL(request.url)
        lastState = url.searchParams.get('state')
        const rows = [PENDING, LIVE].filter((p) => (lastState ? p.status === lastState : true))
        return HttpResponse.json(rows)
      }),
    )
    render(<PromotionsPage />)
    await screen.findByText('Mama Mia 20% Off')

    fireEvent.click(screen.getByRole('button', { name: /live/ }))

    await waitFor(() => expect(lastState).toBe('live'))
    await waitFor(() => expect(screen.queryByText('Mama Mia 20% Off')).not.toBeInTheDocument())
    expect(screen.getByText('Free Delivery Weekend')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /live/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('exports the promotions as CSV', async () => {
    server.use(http.get('/admin/promotions', () => HttpResponse.json([PENDING, LIVE])))
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    render(<PromotionsPage />)
    await screen.findByText('Mama Mia 20% Off')
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Title,Merchant,Type,Status,Budget,Benefit,Redeems,Schedule')
    expect(csv).toContain('mrc_1')
    expect(csv).toContain('TZS 500,000')
    expect(csv).toContain('20%')
    expect(csv).toContain('mrc_2')
    expect(csv).toContain('TZS 1,000,000')
  })

  it('shows the empty state when no promotions exist', async () => {
    server.use(http.get('/admin/promotions', () => HttpResponse.json([])))
    render(<PromotionsPage />)

    expect(await screen.findByText('No promotions found')).toBeInTheDocument()
  })

  it('shows an error state and recovers on retry', async () => {
    server.use(
      http.get('/admin/promotions', () =>
        HttpResponse.json({ code: 'DOWN', message: 'promotions down' }, { status: 500 }),
      ),
    )
    render(<PromotionsPage />)
    expect(await screen.findByText('Failed to load promotions')).toBeInTheDocument()

    server.use(http.get('/admin/promotions', () => HttpResponse.json([PENDING])))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Mama Mia 20% Off')).toBeInTheDocument()
  })

  it('approves a pending promotion with a reason, shows a toast and refetches', async () => {
    let current: Record<string, unknown> = { ...PENDING }
    let listCalls = 0
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/admin/promotions', () => {
        listCalls++
        return HttpResponse.json([current])
      }),
      http.post('/admin/promotions/prom_1/decision', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>
        current = { ...current, status: 'live' }
        return HttpResponse.json(current)
      }),
    )
    render(<PromotionsPage />)

    fireEvent.click(await screen.findByText('Mama Mia 20% Off'))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    const modal = screen.getByRole('dialog', { name: 'Approve promotion' })
    fireEvent.change(within(modal).getByLabelText('Reason'), { target: { value: 'Meets moderation guidelines' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Mama Mia 20% Off approved')
    await waitFor(() => expect(posted?.decision).toBe('approved'))
    await waitFor(() => expect(posted?.reason).toBe('Meets moderation guidelines'))
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2))
    expect(screen.queryByRole('dialog', { name: 'Approve promotion' })).not.toBeInTheDocument()
  })

  it('surfaces a 403 denial inline in the reject prompt', async () => {
    server.use(
      http.get('/admin/promotions', () => HttpResponse.json([PENDING])),
      http.post('/admin/promotions/prom_1/decision', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'Requires promotions manager role', requestId: 'req_1' },
          { status: 403 },
        ),
      ),
    )
    render(<PromotionsPage />)

    fireEvent.click(await screen.findByText('Mama Mia 20% Off'))
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))

    const modal = screen.getByRole('dialog', { name: 'Reject promotion' })
    fireEvent.change(within(modal).getByLabelText('Reason'), { target: { value: 'Policy violation' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Requires promotions manager role')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Reject promotion' })).toBeInTheDocument()
  })

  it('hides moderation actions without promotion.moderate permission', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    server.use(http.get('/admin/promotions', () => HttpResponse.json([PENDING, LIVE])))
    render(<PromotionsPage />)

    fireEvent.click(await screen.findByText('Mama Mia 20% Off'))
    await screen.findByRole('dialog')

    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
  })

  it('shows the per-entity audit trail in the drawer', async () => {
    const AUDIT_ENTRIES = [
      {
        id: 'aud_1',
        actorUserId: 'usr_61',
        actorRole: 'admin',
        action: 'promotion.approved',
        entityType: 'promotion',
        entityId: 'prom_1',
        details: { reason: 'Meets guidelines' },
        ipAddress: '10.0.0.13',
        at: '2026-08-10T08:00:00.000Z',
        requestId: 'req_m1',
      },
      {
        id: 'aud_2',
        actorUserId: 'usr_62',
        action: 'promotion.paused',
        entityType: 'promotion',
        entityId: 'prom_1',
        at: '2026-08-11T08:00:00.000Z',
        requestId: 'req_m2',
      },
    ]
    server.use(
      http.get('/admin/promotions', () => HttpResponse.json([PENDING])),
      http.get('*/admin/audit-logs', () => HttpResponse.json(AUDIT_ENTRIES)),
    )
    render(<PromotionsPage />)

    fireEvent.click(await screen.findByText('Mama Mia 20% Off'))
    const dialog = await screen.findByRole('dialog')

    expect(await within(dialog).findByText('promotion.paused')).toBeInTheDocument()
    expect(within(dialog).getByText('promotion.approved')).toBeInTheDocument()
    expect(within(dialog).getByText('usr_61')).toBeInTheDocument()
  })

  it('shows no audit entries when the trail is empty', async () => {
    server.use(
      http.get('/admin/promotions', () => HttpResponse.json([PENDING])),
      http.get('*/admin/audit-logs', () => HttpResponse.json([])),
    )
    render(<PromotionsPage />)

    fireEvent.click(await screen.findByText('Mama Mia 20% Off'))
    await screen.findByRole('dialog')

    expect(await screen.findByText('No audit entries for this entity')).toBeInTheDocument()
  })
})
