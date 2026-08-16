import { describe, expect, test } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import type { GroupBuyDeal } from '@hudumika/contract'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'
import { GroupBuysPage } from './GroupBuysPage'

const deal = (over: Partial<GroupBuyDeal> = {}): GroupBuyDeal => ({
  id: 'gb_1',
  merchantId: 'merchant_a',
  title: 'Weekend brunch deal',
  description: 'Bottomless brunch for two',
  imageUrl: null,
  priceTZS: 15000,
  originalPriceTZS: 20000,
  quantity: 100,
  soldCount: 23,
  validityDays: 7,
  salesStartAt: '2026-08-01T08:00:00.000Z',
  salesEndAt: '2026-08-31T20:00:00.000Z',
  status: 'pending_review',
  rejectReason: null,
  ...over,
})

function listHandler(...deals: GroupBuyDeal[]) {
  return http.get('*/admin/group-buys', () => HttpResponse.json(deals))
}

describe('GroupBuysPage', () => {
  test('renders rows after loading', async () => {
    const user = userEvent.setup()
    server.use(listHandler(deal(), deal({ id: 'gb_2', title: 'Lunch deal', status: 'live' })))
    render(<GroupBuysPage />)
    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
    expect(await screen.findByText('Weekend brunch deal')).toBeInTheDocument()
    expect(screen.getByText('Lunch deal')).toBeInTheDocument()
    expect(
      screen.getAllByText((_, el) => el?.tagName === 'TD' && el.textContent?.trim() === 'TZS 15,000 from TZS 20,000'),
    ).toHaveLength(2)
    expect(screen.getAllByText('23 / 100')).toHaveLength(2)
    expect(screen.getAllByText((_, el) => el?.classList.contains('pill') === true && el?.textContent === 'pending review')).toHaveLength(1)
    expect(screen.getAllByText((_, el) => el?.classList.contains('pill') === true && el?.textContent === 'live')).toHaveLength(1)
  })

  test('shows empty state when there are no deals', async () => {
    server.use(listHandler())
    render(<GroupBuysPage />)
    expect(await screen.findByText('No group buy deals found')).toBeInTheDocument()
  })

  test('sorts by price when the Price header is clicked', async () => {
    const user = userEvent.setup()
    server.use(
      listHandler(
        deal({ id: 'gb_2', title: 'Lunch deal', priceTZS: 30000, status: 'live' }),
        deal(),
      ),
    )
    const { container } = render(<GroupBuysPage />)
    await screen.findByText('Weekend brunch deal')

    await user.click(screen.getByRole('button', { name: /Price/ }))

    const firstRow = container.querySelector('tbody tr td')!
    expect(firstRow.textContent).toContain('Weekend brunch deal')
  })

  test('shows error state and recovers via retry', async () => {
    const user = userEvent.setup()
    server.use(http.get('*/admin/group-buys', () => new HttpResponse(null, { status: 500 })))
    render(<GroupBuysPage />)
    expect(await screen.findByText('Failed to load group buy deals')).toBeInTheDocument()

    server.resetHandlers()
    server.use(listHandler(deal()))
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Weekend brunch deal')).toBeInTheDocument()
  })

  test('filter chips filter server-side and show counts from unfiltered fetch', async () => {
    const user = userEvent.setup()
    const pending = deal({ id: 'gb_1', title: 'Brunch deal', status: 'pending_review' })
    const live = deal({ id: 'gb_2', title: 'Lunch deal', status: 'live' })
    server.use(
      http.get('*/admin/group-buys', ({ request }) => {
        const state = new URL(request.url).searchParams.get('state')
        if (state === 'live') return HttpResponse.json([live])
        if (state === 'pending_review') return HttpResponse.json([pending])
        return HttpResponse.json([pending, live])
      }),
    )
    render(<GroupBuysPage />)
    expect(await screen.findByText('Brunch deal')).toBeInTheDocument()
    expect(screen.getByText('Lunch deal')).toBeInTheDocument()

    const liveChip = screen.getByRole('button', { name: /^live/ })
    expect(liveChip.querySelector('.chip-count')).toHaveTextContent('1')

    await user.click(liveChip)
    await waitFor(() => expect(screen.queryByText('Brunch deal')).not.toBeInTheDocument())
    expect(screen.getByText('Lunch deal')).toBeInTheDocument()
  })

  test('approve mutation succeeds with toast and refetch', async () => {
    const user = userEvent.setup()
    const pending = deal({ id: 'gb_1', title: 'Brunch deal', status: 'pending_review' })
    let deals: GroupBuyDeal[] = [pending]
    const decisionCalls: Array<{ decision: string; reason: string }> = []
    server.use(
      http.get('*/admin/group-buys', () => HttpResponse.json(deals)),
      http.post('*/admin/group-buys/gb_1/decision', async ({ request }) => {
        const body = (await request.json()) as { decision: string; reason: string }
        decisionCalls.push(body)
        const updated = { ...pending, status: 'live' as const }
        deals = [updated]
        return HttpResponse.json(updated)
      }),
    )
    render(<GroupBuysPage />)
    await user.click(await screen.findByText('Brunch deal'))
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    const dialog = screen.getByRole('dialog', { name: 'Approve group buy deal' })
    await user.type(dialog.querySelector('textarea')!, 'Pricing verified correct')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Brunch deal approved')).toBeInTheDocument()
    expect(decisionCalls).toEqual([{ decision: 'approved', reason: 'Pricing verified correct' }])
    await waitFor(() => {
      expect(
        screen.getByText((content, el) => el?.classList.contains('pill') === true && content === 'live'),
      ).toBeInTheDocument()
    })
  })

  test('403 denial surfaces parseApiError inline in the prompt', async () => {
    const user = userEvent.setup()
    const pending = deal({ id: 'gb_1', title: 'Brunch deal', status: 'pending_review' })
    server.use(
      listHandler(pending),
      http.post('*/admin/group-buys/gb_1/decision', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'Not allowed', requestId: 'req-1' }, { status: 403 }),
      ),
    )
    render(<GroupBuysPage />)
    await user.click(await screen.findByText('Brunch deal'))
    await user.click(screen.getByRole('button', { name: 'Reject' }))

    const dialog = screen.getByRole('dialog', { name: 'Reject group buy deal' })
    await user.type(dialog.querySelector('textarea')!, 'Violates listing policy')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Not allowed')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Reject group buy deal' })).toBeInTheDocument()
  })

  test('hides moderation actions without group_buy.moderate permission', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    server.use(listHandler(deal()))
    render(<GroupBuysPage />)

    await userEvent.click(await screen.findByText('Weekend brunch deal'))
    await screen.findByRole('dialog')

    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delist' })).not.toBeInTheDocument()
  })

  test('shows the per-entity audit trail in the drawer', async () => {
    const user = userEvent.setup()
    const AUDIT_ENTRIES = [
      {
        id: 'aud_1',
        actorUserId: 'usr_71',
        actorRole: 'admin',
        action: 'group_buy.approved',
        entityType: 'group_buy',
        entityId: 'gb_1',
        details: { reason: 'Pricing verified' },
        ipAddress: '10.0.0.17',
        at: '2026-08-09T08:00:00.000Z',
        requestId: 'req_g1',
      },
      {
        id: 'aud_2',
        actorUserId: 'usr_72',
        action: 'group_buy.delisted',
        entityType: 'group_buy',
        entityId: 'gb_1',
        at: '2026-08-10T08:00:00.000Z',
        requestId: 'req_g2',
      },
    ]
    server.use(
      listHandler(deal()),
      http.get('*/admin/audit-logs', () => HttpResponse.json(AUDIT_ENTRIES)),
    )
    render(<GroupBuysPage />)
    await user.click(await screen.findByText('Weekend brunch deal'))

    expect(await screen.findByText('group buy.delisted')).toBeInTheDocument()
    expect(screen.getByText('group buy.approved')).toBeInTheDocument()
    expect(screen.getByText('usr_71')).toBeInTheDocument()
  })

  test('shows no audit entries when the trail is empty', async () => {
    const user = userEvent.setup()
    server.use(
      listHandler(deal()),
      http.get('*/admin/audit-logs', () => HttpResponse.json([])),
    )
    render(<GroupBuysPage />)
    await user.click(await screen.findByText('Weekend brunch deal'))

    expect(await screen.findByText('No audit entries for this entity')).toBeInTheDocument()
  })
})
