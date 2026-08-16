import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'
import { RefundsPage } from './RefundsPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const REFUND = {
  id: 'ref_1',
  orderId: 'ord_1',
  customerName: 'Aisha Mwamba',
  amountTZS: 25000,
  reason: 'Order never arrived',
  status: 'pending',
  decisionReason: null,
  createdAt: '2026-08-14T10:00:00.000Z',
}

function seed(refunds: Array<Record<string, unknown>>) {
  server.use(http.get('/refunds', () => HttpResponse.json(refunds)))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RefundsPage', () => {
  it('renders refund rows after loading', async () => {
    seed([{ ...REFUND }])
    render(<RefundsPage />)

    expect(await screen.findByText('ref_1')).toBeInTheDocument()
    expect(screen.getByText('ord_1')).toBeInTheDocument()
    expect(screen.getByText('Aisha Mwamba')).toBeInTheDocument()
    expect(screen.getByText('TZS 25,000')).toBeInTheDocument()
    expect(screen.getByText('Order never arrived')).toBeInTheDocument()
    expect(screen.getByText('pending')).toBeInTheDocument()
  })

  it('shows the empty state when there are no refunds', async () => {
    seed([])
    render(<RefundsPage />)

    expect(await screen.findByText('No refund requests in this bucket')).toBeInTheDocument()
  })

  it('shows an error state and recovers via Retry', async () => {
    server.use(
      http.get('/refunds', () => HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 })),
    )
    render(<RefundsPage />)

    expect(await screen.findByText('Failed to load refund requests')).toBeInTheDocument()

    seed([{ ...REFUND }])
    fireEvent.click(screen.getByText('Retry'))

    expect(await screen.findByText('ref_1')).toBeInTheDocument()
  })

  it('filters rows by status chip with counts', async () => {
    seed([
      { ...REFUND },
      { ...REFUND, id: 'ref_2', orderId: 'ord_2', status: 'approved' },
      { ...REFUND, id: 'ref_3', orderId: 'ord_3', status: 'rejected' },
    ])
    render(<RefundsPage />)

    await screen.findByText('ref_1')

    const chips = screen.getAllByRole('button')
    const pending = chips.find((c) => c.textContent?.startsWith('Pending'))
    expect(pending?.textContent).toContain('1')

    fireEvent.click(screen.getByText('Approved'))

    expect(screen.getByText('ref_2')).toBeInTheDocument()
    expect(screen.queryByText('ref_1')).not.toBeInTheDocument()
    expect(screen.queryByText('ref_3')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Approved/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('exports the refund requests as CSV', async () => {
    seed([{ ...REFUND }, { ...REFUND, id: 'ref_2', orderId: 'ord_2', customerName: 'Juma Salim', status: 'approved' }])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    render(<RefundsPage />)
    await screen.findByText('ref_1')
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Refund,Order,Customer,Amount,Reason,Status,Created')
    expect(csv).toContain('ref_1')
    expect(csv).toContain('ord_1')
    expect(csv).toContain('Aisha Mwamba')
    expect(csv).toContain('TZS 25,000')
    expect(csv).toContain('Order never arrived')
    expect(csv).toContain('Juma Salim')
  })

  it('approves a pending refund with a reason, shows toast and refetches', async () => {
    let listCalls = 0
    const row: Record<string, unknown> = { ...REFUND }
    server.use(
      http.get('/refunds', () => {
        listCalls++
        return HttpResponse.json([row])
      }),
      http.post('/admin/refunds/ref_1/decision', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        expect(body.decision).toBe('approve')
        expect(body.reason).toBe('Customer refund approved')
        expect(body.amountTZS).toBe(25000)
        row.status = 'approved'
        ;(row as Record<string, unknown>).decisionReason = (body.reason as string) ?? null
        return HttpResponse.json({ ...row })
      }),
    )
    render(<RefundsPage />)

    fireEvent.click(await screen.findByText('ref_1'))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(screen.getByText('Approve refund')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Customer refund approved' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText(/Refund ref_1 approved/)).toBeInTheDocument()
    await waitFor(() => expect(listCalls).toBe(2))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows an inline error when the decision is forbidden', async () => {
    seed([{ ...REFUND }])
    server.use(
      http.post('/admin/refunds/ref_1/decision', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<RefundsPage />)

    fireEvent.click(await screen.findByText('ref_1'))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(screen.getByText('Reject refund')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'No refund for this order' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByText('Reject refund')).toBeInTheDocument()
    expect(screen.queryByText(/Refund ref_1 rejected/)).not.toBeInTheDocument()
  })

  it('routes large refunds through two-person approval', async () => {
    const large = { ...REFUND, id: 'ref_9', amountTZS: 600000 }
    let approvalBody: Record<string, unknown> | null = null
    server.use(
      http.get('/refunds', () => HttpResponse.json([large])),
      http.post('/admin/two-person-approvals', async ({ request }) => {
        approvalBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ id: 'apr_1' }, { status: 201 })
      }),
    )
    render(<RefundsPage />)

    fireEvent.click(await screen.findByText('ref_9'))
    await screen.findByRole('dialog')

    expect(screen.getByText(/Refunds above TZS 500,000 require two-person approval/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Initiate approval' }))
    expect(screen.getByRole('dialog', { name: 'Initiate approval' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Large refund needs a second admin' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request approval' }))

    expect(await screen.findByText('Approval request created — pending a second admin')).toBeInTheDocument()
    expect(approvalBody).toMatchObject({
      actionType: 'large_refund',
      targetType: 'refund',
      targetId: 'ref_9',
      reason: 'Large refund needs a second admin',
      payload: { decision: 'approve', amountTZS: 600000 },
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows an inline error when the approval request is forbidden', async () => {
    const large = { ...REFUND, id: 'ref_9', amountTZS: 600000 }
    server.use(
      http.get('/refunds', () => HttpResponse.json([large])),
      http.post('/admin/two-person-approvals', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<RefundsPage />)

    fireEvent.click(await screen.findByText('ref_9'))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: 'Initiate approval' }))
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Large refund needs approval' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request approval' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Initiate approval' })).toBeInTheDocument()
    expect(screen.queryByText('Approval request created — pending a second admin')).not.toBeInTheDocument()
  })

  it('renders drawer meta fields for an approved refund', async () => {
    seed([{ ...REFUND, status: 'approved', decisionReason: 'Verified merchant error' }])
    render(<RefundsPage />)

    fireEvent.click(await screen.findByText('ref_1'))
    await screen.findByRole('dialog')

    expect(screen.getByText('Verified merchant error')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
  })

  it('hides the decision actions without refund.approve permission', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seed([{ ...REFUND }])
    render(<RefundsPage />)

    fireEvent.click(await screen.findByText('ref_1'))
    await screen.findByRole('dialog')

    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
  })
})
