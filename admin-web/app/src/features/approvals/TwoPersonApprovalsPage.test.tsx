import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { AdminTwoPersonApproval } from '@hudumika/contract'
import { TwoPersonApprovalsPage } from './TwoPersonApprovalsPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

function approval(overrides: Partial<AdminTwoPersonApproval> = {}): AdminTwoPersonApproval {
  return {
    id: 'aprv_1',
    actionType: 'large_refund',
    targetType: 'order',
    targetId: 'ord_123',
    reason: 'Refund duplicate charge',
    payload: { amountTZS: 500000 },
    status: 'pending',
    requestedBy: 'admin_1',
    decidedBy: null,
    decisionComment: null,
    createdAt: '2026-08-10T09:00:00.000Z',
    decidedAt: null,
    ...overrides,
  }
}

describe('TwoPersonApprovalsPage', () => {
  it('renders approval rows after loading', async () => {
    server.use(
      http.get('/admin/two-person-approvals', () =>
        HttpResponse.json([
          approval(),
          approval({
            id: 'aprv_2',
            actionType: 'change_commission',
            targetType: 'merchant',
            targetId: 'mrc_9',
            reason: 'Adjust commission to 2.5%',
            status: 'approved',
            requestedBy: 'admin_2',
            decidedBy: 'admin_3',
            decisionComment: 'OK',
            decidedAt: '2026-08-11T09:00:00.000Z',
          }),
        ]),
      ),
    )
    render(<TwoPersonApprovalsPage />)

    expect(await screen.findByText('large refund')).toBeInTheDocument()
    expect(screen.getByText('change commission')).toBeInTheDocument()
    expect(screen.getAllByText(/ord_123/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('pending').length).toBeGreaterThan(0)
    expect(screen.getAllByText('approved').length).toBeGreaterThan(0)
    expect(screen.getByText('admin_1')).toBeInTheDocument()
    expect(screen.getByText('admin_3')).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.getByText(/Dangerous actions require a second admin's approval/)).toBeInTheDocument()
  })

  it('refetches with the status param when a status chip is clicked', async () => {
    let lastStatus: string | null = null
    server.use(
      http.get('/admin/two-person-approvals', ({ request }) => {
        const url = new URL(request.url)
        lastStatus = url.searchParams.get('status')
        const rows = [
          approval(),
          approval({
            id: 'aprv_2',
            actionType: 'release_hold',
            targetType: 'shipment',
            targetId: 'shp_2',
            status: 'approved',
            requestedBy: 'admin_2',
            decidedBy: 'admin_3',
            decisionComment: 'OK',
            decidedAt: '2026-08-11T09:00:00.000Z',
          }),
        ].filter((a) => (lastStatus ? a.status === lastStatus : true))
        return HttpResponse.json(rows)
      }),
    )
    render(<TwoPersonApprovalsPage />)
    await screen.findByText('large refund')

    fireEvent.click(screen.getByRole('button', { name: /pending/ }))

    await waitFor(() => expect(lastStatus).toBe('pending'))
    await waitFor(() => expect(screen.queryByText('release hold')).not.toBeInTheDocument())
    expect(screen.getByText('large refund')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /pending/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows the empty state when no approval requests exist', async () => {
    server.use(http.get('/admin/two-person-approvals', () => HttpResponse.json([])))
    render(<TwoPersonApprovalsPage />)

    expect(await screen.findByText('No approval requests')).toBeInTheDocument()
  })

  it('shows an error state and recovers on retry', async () => {
    server.use(
      http.get('/admin/two-person-approvals', () =>
        HttpResponse.json({ code: 'DOWN', message: 'approvals down' }, { status: 500 }),
      ),
    )
    render(<TwoPersonApprovalsPage />)
    expect(await screen.findByText('Failed to load approvals')).toBeInTheDocument()

    server.use(http.get('/admin/two-person-approvals', () => HttpResponse.json([approval()])))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('large refund')).toBeInTheDocument()
  })

  it('creates a request with actionType and reason, shows a toast and refetches', async () => {
    let listCalls = 0
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/admin/two-person-approvals', () => {
        listCalls++
        return HttpResponse.json([])
      }),
      http.post('/admin/two-person-approvals', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(approval({ id: 'aprv_new' }), { status: 201 })
      }),
    )
    render(<TwoPersonApprovalsPage />)
    await screen.findByText('No approval requests')

    fireEvent.click(screen.getByRole('button', { name: 'New request' }))

    const modal = screen.getByRole('dialog', { name: 'New approval request' })
    fireEvent.change(within(modal).getByLabelText('Action type'), { target: { value: 'change_commission' } })
    fireEvent.change(within(modal).getByLabelText('Target type'), { target: { value: 'merchant' } })
    fireEvent.change(within(modal).getByLabelText('Target ID'), { target: { value: 'mrc_55' } })
    fireEvent.change(within(modal).getByLabelText('Reason'), { target: { value: 'Commission cap exceeded' } })
    fireEvent.change(within(modal).getByLabelText('Payload (JSON)'), { target: { value: '{"rateBps": 300}' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Create request' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Approval request created')
    await waitFor(() => expect(posted?.actionType).toBe('change_commission'))
    await waitFor(() => expect(posted?.reason).toBe('Commission cap exceeded'))
    await waitFor(() => expect((posted?.payload as Record<string, unknown>).rateBps).toBe(300))
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2))
    expect(screen.queryByRole('dialog', { name: 'New approval request' })).not.toBeInTheDocument()
  })

  it('approves a pending request with a comment, shows a toast and refetches', async () => {
    let current: AdminTwoPersonApproval = approval()
    let listCalls = 0
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/admin/two-person-approvals', () => {
        listCalls++
        return HttpResponse.json([current])
      }),
      http.post('/admin/two-person-approvals/aprv_1/decision', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>
        current = {
          ...current,
          status: 'approved',
          decidedBy: 'admin_2',
          decisionComment: String(posted?.comment ?? ''),
          decidedAt: '2026-08-12T09:00:00.000Z',
        }
        return HttpResponse.json(current)
      }),
    )
    render(<TwoPersonApprovalsPage />)

    fireEvent.click(await screen.findByText(/ord_123/))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    const modal = screen.getByRole('dialog', { name: 'Approve request' })
    fireEvent.change(within(modal).getByLabelText('Comment'), { target: { value: 'Verified the charge twice' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Request approved')
    await waitFor(() => expect(posted?.decision).toBe('approve'))
    await waitFor(() => expect(posted?.comment).toBe('Verified the charge twice'))
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('surfaces APPROVAL_SAME_ACTOR inline in the decision prompt', async () => {
    server.use(
      http.get('/admin/two-person-approvals', () => HttpResponse.json([approval()])),
      http.post('/admin/two-person-approvals/aprv_1/decision', () =>
        HttpResponse.json(
          { code: 'APPROVAL_SAME_ACTOR', message: 'Cannot decide on own request', requestId: 'req_1' },
          { status: 409 },
        ),
      ),
    )
    render(<TwoPersonApprovalsPage />)

    fireEvent.click(await screen.findByText(/ord_123/))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    const modal = screen.getByRole('dialog', { name: 'Approve request' })
    fireEvent.change(within(modal).getByLabelText('Comment'), { target: { value: 'Approving' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Confirm' }))

    expect(
      await screen.findByText('You cannot decide on your own request (APPROVAL_SAME_ACTOR)'),
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Approve request' })).toBeInTheDocument()
  })

  it('treats APPROVAL_ALREADY_DECIDED as terminal: inline error, refetch, no reopen', async () => {
    let listCalls = 0
    server.use(
      http.get('/admin/two-person-approvals', () => {
        listCalls++
        return HttpResponse.json([approval()])
      }),
      http.post('/admin/two-person-approvals/aprv_1/decision', () =>
        HttpResponse.json(
          { code: 'APPROVAL_ALREADY_DECIDED', message: 'Already decided', requestId: 'req_2' },
          { status: 409 },
        ),
      ),
    )
    render(<TwoPersonApprovalsPage />)

    fireEvent.click(await screen.findByText(/ord_123/))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    const modal = screen.getByRole('dialog', { name: 'Approve request' })
    fireEvent.change(within(modal).getByLabelText('Comment'), { target: { value: 'Approving' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Confirm' }))

    expect(
      await screen.findByText('This request has already been decided (APPROVAL_ALREADY_DECIDED)'),
    ).toBeInTheDocument()
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2))
    expect(screen.queryByRole('dialog', { name: 'Approve request' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('rejects an invalid JSON payload with an inline error and makes no API call', async () => {
    let postCalls = 0
    server.use(
      http.get('/admin/two-person-approvals', () => HttpResponse.json([])),
      http.post('/admin/two-person-approvals', () => {
        postCalls++
        return HttpResponse.json(approval(), { status: 201 })
      }),
    )
    render(<TwoPersonApprovalsPage />)
    await screen.findByText('No approval requests')

    fireEvent.click(screen.getByRole('button', { name: 'New request' }))

    const modal = screen.getByRole('dialog', { name: 'New approval request' })
    fireEvent.change(within(modal).getByLabelText('Action type'), { target: { value: 'large_refund' } })
    fireEvent.change(within(modal).getByLabelText('Target type'), { target: { value: 'order' } })
    fireEvent.change(within(modal).getByLabelText('Target ID'), { target: { value: 'ord_1' } })
    fireEvent.change(within(modal).getByLabelText('Reason'), { target: { value: 'Refund' } })
    fireEvent.change(within(modal).getByLabelText('Payload (JSON)'), { target: { value: 'not json' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Create request' }))

    expect(await screen.findByText('Payload must be valid JSON')).toBeInTheDocument()
    expect(postCalls).toBe(0)
    expect(screen.getByRole('dialog', { name: 'New approval request' })).toBeInTheDocument()
  })

  it('hides New request and decision buttons when approval.decide is not granted', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    server.use(http.get('/admin/two-person-approvals', () => HttpResponse.json([approval()])))
    render(<TwoPersonApprovalsPage />)

    expect(await screen.findByText('large refund')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New request' })).not.toBeInTheDocument()
    expect(screen.getByText('Two-person decisions require approval.decide')).toBeInTheDocument()

    fireEvent.click(screen.getByText(/ord_123/))
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
  })
})
