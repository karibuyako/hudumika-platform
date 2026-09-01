import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { PaymentsPage } from './PaymentsPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const BATCH = {
  id: 'bat_1',
  cycle: '2026-W33',
  status: 'settled',
  totalTZS: 1250000,
  count: 42,
}

function seed(batches: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/payouts', () => HttpResponse.json(batches)))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PaymentsPage', () => {
  it('renders payout rows after loading', async () => {
    seed([
      { ...BATCH },
      {
        id: 'bat_2',
        cycle: '2026-W32',
        status: 'exception',
        totalTZS: 980000,
        count: 31,
        exceptions: 3,
      },
      { id: 'bat_3', cycle: '2026-W31', status: 'draft', totalTZS: 0, count: 0 },
    ])
    render(<PaymentsPage />)

    expect(await screen.findByText('bat_1')).toBeInTheDocument()
    expect(screen.getByText('bat_2')).toBeInTheDocument()
    expect(screen.getByText('TZS 1,250,000')).toBeInTheDocument()
    expect(screen.getByText('settled')).toBeInTheDocument()

    const row = within(screen.getByText('bat_1').closest('tr')!)
    expect(row.getByText('42')).toBeInTheDocument()
    expect(row.getByText('—')).toBeInTheDocument()

    const exceptionRow = within(screen.getByText('bat_2').closest('tr')!)
    expect(exceptionRow.getByText('3')).toBeInTheDocument()
  })

  it('opens a drawer with batch details and exception queue item', async () => {
    seed([
      { ...BATCH, id: 'bat_9', status: 'exception', exceptions: 2 },
      { ...BATCH, id: 'bat_0' },
    ])
    render(<PaymentsPage />)

    fireEvent.click(await screen.findByText('bat_9'))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('2026-W33')).toBeInTheDocument()
    expect(dialog.getByText('2 payout exception(s)')).toBeInTheDocument()
    expect(dialog.getByText('TZS 1,250,000')).toBeInTheDocument()
  })

  it('shows the empty state when there are no batches', async () => {
    seed([])
    render(<PaymentsPage />)

    expect(await screen.findByText('No payout batches in this bucket')).toBeInTheDocument()
  })

  it('shows an error state and recovers via Retry', async () => {
    server.use(
      http.get('/admin/payouts', () =>
        HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 }),
      ),
    )
    render(<PaymentsPage />)

    expect(await screen.findByText('Failed to load payment data')).toBeInTheDocument()

    seed([{ ...BATCH }])
    fireEvent.click(screen.getByText('Retry'))

    expect(await screen.findByText('bat_1')).toBeInTheDocument()
  })

  it('filters rows by status chip with counts', async () => {
    seed([{ ...BATCH }, { ...BATCH, id: 'bat_2', status: 'exception', exceptions: 3 }])
    render(<PaymentsPage />)

    await screen.findByText('bat_1')

    const chips = screen.getAllByRole('button')
    const all = chips.find((c) => c.textContent?.startsWith('All'))
    const exception = chips.find((c) => c.textContent?.startsWith('Exception'))
    expect(all?.textContent).toContain('2')
    expect(exception?.textContent).toContain('1')

    fireEvent.click(screen.getByText('Exception'))

    expect(screen.getByText('bat_2')).toBeInTheDocument()
    expect(screen.queryByText('bat_1')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Exception/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('exports the payout batches as CSV', async () => {
    seed([{ ...BATCH }, { ...BATCH, id: 'bat_2', totalTZS: 900000, count: 10 }])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    render(<PaymentsPage />)
    await screen.findByText('bat_1')
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Batch,Cycle,Status,Total,Count,Exceptions')
    expect(csv).toContain('bat_1')
    expect(csv).toContain('2026-W33')
    expect(csv).toContain('TZS 1,250,000')
    expect(csv).toContain('42')
    expect(csv).toContain('bat_2')
  })

  it('shows the Reconcile action for processing and exception batches, gated by finance.payout_adjust', async () => {
    seed([
      { ...BATCH, id: 'bat_9', status: 'exception', exceptions: 2 },
      { ...BATCH, id: 'bat_0' },
      { ...BATCH, id: 'bat_7', status: 'processing' },
    ])
    render(<PaymentsPage />)

    fireEvent.click(await screen.findByText('bat_9'))
    let dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument()

    fireEvent.click(dialog.getByRole('button', { name: 'Close' }))
    fireEvent.click(await screen.findByText('bat_7'))
    dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument()

    fireEvent.click(dialog.getByRole('button', { name: 'Close' }))
    fireEvent.click(await screen.findByText('bat_0'))
    dialog = within(await screen.findByRole('dialog'))
    expect(dialog.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument()
  })

  it('hides the Reconcile action without finance.payout_adjust', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seed([{ ...BATCH, id: 'bat_9', status: 'exception', exceptions: 2 }])
    render(<PaymentsPage />)

    fireEvent.click(await screen.findByText('bat_9'))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument()
  })

  it('reconciles a payout batch via the live endpoint and shows success', async () => {
    seed([{ ...BATCH, id: 'bat_9', status: 'exception', exceptions: 2 }])
    render(<PaymentsPage />)

    fireEvent.click(await screen.findByText('bat_9'))
    const drawer = await screen.findByRole('dialog')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Reconcile' }))

    const prompt = await screen.findByRole('dialog', { name: 'Reconcile payout batch' })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Payout paid')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Reconcile payout batch' })).not.toBeInTheDocument()
    expect(within(drawer).queryByText('PENDING_ENDPOINT')).not.toBeInTheDocument()
  })

  it('shows an error when payout reconcile fails', async () => {
    seed([{ ...BATCH, id: 'bat_9', status: 'exception', exceptions: 2 }])
    server.use(http.post('/admin/payouts/:batchId/reconcile', async () => HttpResponse.json({ code: 'PAYOUT_ALREADY_RECONCILED', message: 'already reconciled', requestId: 'req_pay' }, { status: 409 })))
    render(<PaymentsPage />)

    fireEvent.click(await screen.findByText('bat_9'))
    const drawer = await screen.findByRole('dialog')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Reconcile' }))

    const prompt = await screen.findByRole('dialog', { name: 'Reconcile payout batch' })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }))

    expect(await within(prompt).findByText(/already reconciled/i)).toBeInTheDocument()
    expect(within(prompt).getByText(/req_pay/)).toBeInTheDocument()
  })
})
