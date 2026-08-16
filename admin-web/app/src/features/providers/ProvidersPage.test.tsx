import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { ProvidersPage } from './ProvidersPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const PROVIDER = {
  id: 'prv_1',
  name: 'Rapid Plumbing',
  trade: 'plumbing',
  rating: 4.6,
  reviewCount: 12,
  verified: false,
  serviceAreas: ['Kinondoni', 'Ilala'],
  baseRateTZS: 25000,
  verification: 'approved',
  payoutCycleDays: 14,
  bio: 'Same-day plumbing repairs',
  availability: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
  documents: [{ type: 'business_license', status: 'approved' }, { type: 'tax_clearance', status: 'missing' }],
  reliabilityScore: 88,
  city: 'Dar es Salaam',
  categories: ['Plumbing', 'Repairs'],
  isOpen: true,
}

function seedProviders(providers: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/providers', () => HttpResponse.json(providers)))
}

describe('ProvidersPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads providers and renders rows', async () => {
    seedProviders([{ ...PROVIDER }, { ...PROVIDER, id: 'prv_2', name: 'Rooter Co', verification: 'pending', isOpen: false }])
    render(<ProvidersPage />)

    expect(await screen.findByText('Rapid Plumbing')).toBeInTheDocument()
    expect(screen.getByText('Rooter Co')).toBeInTheDocument()
    expect(screen.getAllByText('88/100')).toHaveLength(2)
  })

  it('filters by verification state with counts', async () => {
    seedProviders([
      { ...PROVIDER },
      { ...PROVIDER, id: 'prv_2', name: 'Rooter Co', verification: 'pending', isOpen: false },
    ])
    render(<ProvidersPage />)

    const allChip = await screen.findByRole('button', { name: /^All/ })
    expect(within(allChip).getByText('2')).toBeInTheDocument()
    const approvedChip = screen.getByRole('button', { name: /^approved/ })
    expect(within(approvedChip).getByText('1')).toBeInTheDocument()
    const pendingChip = screen.getByRole('button', { name: /^pending/ })
    expect(within(pendingChip).getByText('1')).toBeInTheDocument()

    pendingChip.click()
    await waitFor(() => expect(screen.queryByText('Rapid Plumbing')).not.toBeInTheDocument())
    expect(screen.getByText('Rooter Co')).toBeInTheDocument()
  })

  it('shows the empty state when no providers exist', async () => {
    seedProviders([])
    render(<ProvidersPage />)
    expect(await screen.findByText('No providers found')).toBeInTheDocument()
  })

  it('exports providers as CSV', async () => {
    seedProviders([{ ...PROVIDER }])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<ProvidersPage />)

    await screen.findByText('Rapid Plumbing')
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Reliability')
    expect(csv).toContain('88/100')
    expect(csv).toContain('Dar es Salaam')
    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('shows an error state and recovers on retry', async () => {
    let calls = 0
    server.use(
      http.get('/admin/providers', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'SERVICE_DOWN', message: 'down', requestId: 'req_123' }, { status: 500 })
        }
        return HttpResponse.json([{ ...PROVIDER }])
      }),
    )
    render(<ProvidersPage />)

    expect(await screen.findByText('Failed to load providers')).toBeInTheDocument()
    expect(screen.getByText('req_123')).toBeInTheDocument()

    screen.getByRole('button', { name: 'Retry' }).click()
    expect(await screen.findByText('Rapid Plumbing')).toBeInTheDocument()
  })

  it('opens a read-only detail drawer on row click', async () => {
    seedProviders([{ ...PROVIDER }])
    render(<ProvidersPage />)

    ;(await screen.findByText('Rapid Plumbing')).click()

    expect(await screen.findByText('Payout cycle')).toBeInTheDocument()
    expect(screen.getByText('14 days')).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByText('prv_1')).toBeInTheDocument()
    expect(
      screen.getByText('Provider verification decisions are audited (provider.*) and notify the provider.'),
    ).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: /approve|reject|suspend/i })).not.toBeInTheDocument()
  })

  it('shows verification actions for pending, documents_review and changes_requested providers', async () => {
    seedProviders([
      { ...PROVIDER, id: 'prv_9', verification: 'pending' },
      { ...PROVIDER, id: 'prv_8', name: 'Rooter Co', verification: 'documents_review' },
    ])
    render(<ProvidersPage />)

    ;(await screen.findByText('Rapid Plumbing')).click()
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Request changes' })).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    ;(await screen.findByText('Rooter Co')).click()
    dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('hides verification actions without provider.verify', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seedProviders([{ ...PROVIDER, id: 'prv_9', verification: 'pending' }])
    render(<ProvidersPage />)

    ;(await screen.findByText('Rapid Plumbing')).click()
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Request changes' })).not.toBeInTheDocument()
  })

  it('shows the pending-endpoint notice after confirming a provider decision', async () => {
    seedProviders([{ ...PROVIDER, id: 'prv_9', verification: 'pending' }])
    render(<ProvidersPage />)

    ;(await screen.findByText('Rapid Plumbing')).click()
    const drawer = await screen.findByRole('dialog')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Request changes' }))

    const prompt = await screen.findByRole('dialog', { name: 'Request provider changes' })
    fireEvent.change(within(prompt).getByLabelText('Reason'), { target: { value: 'Upload business licence' } })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }))

    expect(screen.queryByRole('dialog', { name: 'Request provider changes' })).not.toBeInTheDocument()
    expect(within(drawer).getByText('PENDING_ENDPOINT')).toBeInTheDocument()
    expect(within(drawer).getByText(/POST \/admin\/providers\/\{providerId\}\/approval/)).toBeInTheDocument()
    expect(within(drawer).getByText(/nothing was sent/)).toBeInTheDocument()
  })

  it('shows the per-entity audit trail in the drawer', async () => {
    const AUDIT_ENTRIES = [
      {
        id: 'aud_1',
        actorUserId: 'usr_21',
        actorRole: 'compliance',
        action: 'provider.verified',
        entityType: 'provider',
        entityId: 'prv_1',
        details: { tier: 'gold' },
        ipAddress: '10.0.0.9',
        at: '2026-08-14T09:00:00.000Z',
        requestId: 'req_p1',
      },
      {
        id: 'aud_2',
        actorUserId: 'usr_22',
        action: 'provider.updated',
        entityType: 'provider',
        entityId: 'prv_1',
        at: '2026-08-15T09:00:00.000Z',
        requestId: 'req_p2',
      },
    ]
    server.use(
      http.get('/admin/providers', () => HttpResponse.json([{ ...PROVIDER }])),
      http.get('*/admin/audit-logs', () => HttpResponse.json(AUDIT_ENTRIES)),
    )
    render(<ProvidersPage />)

    ;(await screen.findByText('Rapid Plumbing')).click()
    const dialog = await screen.findByRole('dialog')

    expect(await within(dialog).findByText('provider.updated')).toBeInTheDocument()
    expect(within(dialog).getByText('provider.verified')).toBeInTheDocument()
    expect(within(dialog).getByText('usr_21')).toBeInTheDocument()
  })

  it('shows no audit entries when the trail is empty', async () => {
    server.use(
      http.get('/admin/providers', () => HttpResponse.json([{ ...PROVIDER }])),
      http.get('*/admin/audit-logs', () => HttpResponse.json([])),
    )
    render(<ProvidersPage />)

    ;(await screen.findByText('Rapid Plumbing')).click()
    await screen.findByRole('dialog')

    expect(await screen.findByText('No audit entries for this entity')).toBeInTheDocument()
  })
})
