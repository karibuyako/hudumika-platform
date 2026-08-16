import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { MerchantsPage } from './MerchantsPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const APPROVED: Record<string, unknown> = {
  id: 'mrc_2',
  businessName: 'Solo Duka',
  city: 'Dar es Salaam',
  serviceAreas: ['Kinondoni'],
  categories: ['Groceries'],
  rating: 4.8,
  reviewCount: 132,
  isOpen: true,
  verification: 'approved',
  commercial: { commissionRateBps: 250, payoutCycleDays: 14, payoutAccount: 'GRP-PAYOUT-8821' },
  documents: [{ type: 'business_license', status: 'approved' }],
  openedAt: '2026-06-01T08:00:00.000Z',
}

const PENDING: Record<string, unknown> = {
  id: 'mrc_1',
  businessName: 'Mama Mia Pizza',
  city: 'Arusha',
  serviceAreas: ['Sekei', 'Njiro'],
  categories: ['Restaurant', 'Delivery'],
  rating: 4.2,
  reviewCount: 41,
  isOpen: false,
  verification: 'pending',
  commercial: { commissionRateBps: 300, payoutCycleDays: 7, payoutAccount: 'GRP-PAYOUT-0019' },
  documents: [
    { type: 'business_license', status: 'approved' },
    { type: 'tin_certificate', status: 'pending' },
  ],
  openedAt: '2026-07-20T08:00:00.000Z',
}

describe('MerchantsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders merchants after loading', async () => {
    server.use(http.get('/admin/merchants', () => HttpResponse.json([PENDING])))
    render(<MerchantsPage />)

    expect(await screen.findByText('Mama Mia Pizza')).toBeInTheDocument()
    expect(screen.getByText('Arusha')).toBeInTheDocument()
    expect(screen.getByText('4.2')).toBeInTheDocument()
  })

  it('refetches with status param when a filter chip is clicked', async () => {
    let lastStatus: string | null = null
    server.use(
      http.get('/admin/merchants', ({ request }) => {
        const url = new URL(request.url)
        lastStatus = url.searchParams.get('status')
        return HttpResponse.json(
          [APPROVED, PENDING].filter((m) => (lastStatus ? m.verification === lastStatus : true)),
        )
      }),
    )
    render(<MerchantsPage />)
    await screen.findByText('Mama Mia Pizza')

    fireEvent.click(screen.getByRole('button', { name: /approved/ }))

    await waitFor(() => expect(lastStatus).toBe('approved'))
    await waitFor(() => expect(screen.queryByText('Mama Mia Pizza')).not.toBeInTheDocument())
    expect(screen.getByText('Solo Duka')).toBeInTheDocument()
  })

  it('shows the empty state when no merchants exist', async () => {
    server.use(http.get('/admin/merchants', () => HttpResponse.json([])))
    render(<MerchantsPage />)

    expect(await screen.findByText('No merchants found')).toBeInTheDocument()
  })

  it('exports merchants as CSV', async () => {
    server.use(http.get('/admin/merchants', () => HttpResponse.json([PENDING])))
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<MerchantsPage />)

    await screen.findByText('Mama Mia Pizza')
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Business')
    expect(csv).toContain('4.2')
    expect(csv).toContain('41')
    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('shows an error state and recovers on retry', async () => {
    server.use(
      http.get('/admin/merchants', () => HttpResponse.json({ code: 'DOWN', message: 'merchants down' }, { status: 500 })),
    )
    render(<MerchantsPage />)
    expect(await screen.findByText('Failed to load merchants')).toBeInTheDocument()

    server.use(http.get('/admin/merchants', () => HttpResponse.json([PENDING])))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Mama Mia Pizza')).toBeInTheDocument()
  })

  it('approves a pending merchant with a reason', async () => {
    let current: Record<string, unknown> = { ...PENDING }
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/admin/merchants', () => HttpResponse.json([current])),
      http.post('/admin/merchants/mrc_1/approval', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>
        current = { ...current, verification: 'approved' }
        return HttpResponse.json(current)
      }),
    )
    render(<MerchantsPage />)

    fireEvent.click(await screen.findByText('Mama Mia Pizza'))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    const modal = screen.getByRole('dialog', { name: 'Approve merchant' })
    fireEvent.change(within(modal).getByLabelText('Reason'), { target: { value: 'All documents verified' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Mama Mia Pizza approved')
    await waitFor(() => expect(posted?.decision).toBe('approved'))
    await waitFor(() => expect(posted?.reason).toBe('All documents verified'))
    await waitFor(() => expect(screen.getAllByText('approved').length).toBeGreaterThan(0))
    expect(screen.queryByRole('dialog', { name: 'Approve merchant' })).not.toBeInTheDocument()
  })

  it('surfaces a 403 denial inline in the approve prompt', async () => {
    server.use(
      http.get('/admin/merchants', () => HttpResponse.json([PENDING])),
      http.post('/admin/merchants/mrc_1/approval', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'Requires finance approver role', requestId: 'req_1' }, { status: 403 }),
      ),
    )
    render(<MerchantsPage />)

    fireEvent.click(await screen.findByText('Mama Mia Pizza'))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    const modal = screen.getByRole('dialog', { name: 'Approve merchant' })
    fireEvent.change(within(modal).getByLabelText('Reason'), { target: { value: 'Documents look complete' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Requires finance approver role')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Approve merchant' })).toBeInTheDocument()
  })

  it('hides merchant decision actions without merchant approve permission', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    server.use(http.get('/admin/merchants', () => HttpResponse.json([PENDING])))
    render(<MerchantsPage />)

    fireEvent.click(await screen.findByText('Mama Mia Pizza'))
    await screen.findByRole('dialog')

    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Request changes' })).not.toBeInTheDocument()
  })

  it('shows the per-entity audit trail in the drawer', async () => {
    const AUDIT_ENTRIES = [
      {
        id: 'aud_1',
        actorUserId: 'usr_11',
        actorRole: 'admin',
        action: 'merchant.status_changed',
        entityType: 'merchant',
        entityId: 'mrc_1',
        details: { reason: 'Compliance review' },
        ipAddress: '10.0.0.5',
        at: '2026-08-15T10:00:00.000Z',
        requestId: 'req_a1',
      },
      {
        id: 'aud_2',
        actorUserId: 'usr_12',
        action: 'merchant.created',
        entityType: 'merchant',
        entityId: 'mrc_1',
        at: '2026-08-16T10:00:00.000Z',
        requestId: 'req_a2',
      },
    ]
    server.use(
      http.get('/admin/merchants', () => HttpResponse.json([PENDING])),
      http.get('*/admin/audit-logs', () => HttpResponse.json(AUDIT_ENTRIES)),
    )
    render(<MerchantsPage />)

    fireEvent.click(await screen.findByText('Mama Mia Pizza'))
    const dialog = await screen.findByRole('dialog')

    expect(await within(dialog).findByText('merchant.created')).toBeInTheDocument()
    expect(within(dialog).getByText('merchant.status changed')).toBeInTheDocument()
    expect(within(dialog).getByText('usr_11')).toBeInTheDocument()
    expect(within(dialog).getByText('usr_12')).toBeInTheDocument()
  })

  it('shows no audit entries when the trail is empty', async () => {
    server.use(
      http.get('/admin/merchants', () => HttpResponse.json([PENDING])),
      http.get('*/admin/audit-logs', () => HttpResponse.json([])),
    )
    render(<MerchantsPage />)

    fireEvent.click(await screen.findByText('Mama Mia Pizza'))
    await screen.findByRole('dialog')

    expect(await screen.findByText('No audit entries for this entity')).toBeInTheDocument()
  })
})
