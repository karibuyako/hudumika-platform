import { describe, expect, test } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import type { Consignment, DeliveryException, DeliveryExceptionKind } from '@hudumika/contract'
import { server } from '../../test/setup'
import { ReconciliationPage } from './ReconciliationPage'

const CON: Consignment = {
  id: 'cn_1',
  consignmentNumber: 'CN-001',
  fromHubId: 'hub_a',
  toHubId: 'hub_b',
  transportMode: 'linehaul_truck',
  carrierId: 'car_7',
  orderCount: 10,
  manifest: [
    { orderId: 'ord_1', waybillNumber: 'WB-1', section: 'standard', scannedIn: true, scannedOut: false },
    { orderId: 'ord_2', waybillNumber: 'WB-2', section: 'fragile', scannedIn: true, scannedOut: false },
    { orderId: 'ord_3', waybillNumber: 'WB-3', section: 'standard', scannedIn: true, scannedOut: false },
    { orderId: 'ord_4', waybillNumber: 'WB-4', section: 'documents', scannedIn: true, scannedOut: false },
    { orderId: 'ord_5', waybillNumber: 'WB-5', section: 'standard', scannedIn: false, scannedOut: false },
    { orderId: 'ord_6', waybillNumber: 'WB-6', section: 'cold_chain', scannedIn: false, scannedOut: false },
  ],
  status: 'in_transit',
  scheduledDeparture: '2026-08-16T06:00:00.000Z',
  departedAt: '2026-08-16T06:30:00.000Z',
  arrivedAt: null,
  createdBy: 'ops_1',
  createdAt: '2026-08-15T20:00:00.000Z',
}

function seedConsignments(consignments: Consignment[]) {
  server.use(http.get('*/linehaul/consignments', () => HttpResponse.json(consignments)))
}

function seedExceptions(exceptions: DeliveryException[]) {
  server.use(http.get('*/delivery-exceptions', () => HttpResponse.json(exceptions)))
}

const exception = (over: Partial<DeliveryException> = {}): DeliveryException => ({
  id: 'exc_1',
  kind: 'scan_gps_mismatch' as DeliveryExceptionKind,
  shipmentId: 'shp_1',
  orderId: 'ord_1',
  tripId: null,
  description: 'Scan GPS far from the claimed hub',
  reportedBy: 'system',
  status: 'open',
  outcome: null,
  autoReplanned: false,
  createdAt: '2026-08-12T10:00:00.000Z',
  resolvedAt: null,
  ...over,
})

describe('ReconciliationPage', () => {
  test('renders reconcile outcomes after loading', async () => {
    seedConsignments([CON])
    render(<ReconciliationPage />)

    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
    expect(await screen.findByText('CN-001')).toBeInTheDocument()
    expect(screen.getByText('hub_a → hub_b')).toBeInTheDocument()
  })

  test('shows status pill and expected/scanned/missing columns', async () => {
    seedConsignments([CON])
    render(<ReconciliationPage />)

    await screen.findByText('CN-001')
    expect(screen.getAllByText('in transit').length).toBeGreaterThan(0)
    expect(screen.getByText('10')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('6')).toBeInTheDocument()
  })

  test('shows empty state when there are no consignments', async () => {
    seedConsignments([])
    seedExceptions([])
    render(<ReconciliationPage />)
    expect(await screen.findByText('No consignments to reconcile')).toBeInTheDocument()
  })

  test('shows error state and recovers via retry', async () => {
    const user = userEvent.setup()
    server.use(http.get('*/linehaul/consignments', () => new HttpResponse(null, { status: 500 })))
    render(<ReconciliationPage />)
    expect(await screen.findByText('Failed to load reconciliation data')).toBeInTheDocument()

    server.resetHandlers()
    seedConsignments([CON])
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('CN-001')).toBeInTheDocument()
  })

  test('reconcile succeeds with toast, POST body and refetch', async () => {
    const user = userEvent.setup()
    const reconcileCalls: Array<{ scannedOrderIds: string[] }> = []
    let listCalls = 0
    server.use(
      http.get('*/linehaul/consignments', () => {
        listCalls += 1
        return HttpResponse.json([CON])
      }),
      http.post('*/linehaul/consignments/cn_1/reconcile', async ({ request }) => {
        reconcileCalls.push((await request.json()) as { scannedOrderIds: string[] })
        return HttpResponse.json({
          consignmentId: 'cn_1',
          expected: 10,
          scanned: 10,
          missingOrderIds: [],
          status: 'matched',
          tripClosed: true,
        })
      }),
    )
    render(<ReconciliationPage />)
    await user.click(await screen.findByText('CN-001'))
    await user.click(screen.getByRole('button', { name: 'Reconcile' }))

    const dialog = screen.getByRole('dialog', { name: 'Reconcile consignment' })
    await user.type(dialog.querySelector('textarea')!, 'Package re-scanned at destination hub')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Consignment reconciled')).toBeInTheDocument()
    expect(reconcileCalls).toEqual([{ scannedOrderIds: ['ord_1', 'ord_2', 'ord_3', 'ord_4'] }])
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2))
  })

  test('reconcile 403 surfaces parseApiError inline in the prompt', async () => {
    const user = userEvent.setup()
    seedConsignments([CON])
    server.use(
      http.post('*/linehaul/consignments/cn_1/reconcile', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'Not permitted to reconcile consignments', requestId: 'req-9' },
          { status: 403 },
        ),
      ),
    )
    render(<ReconciliationPage />)
    await user.click(await screen.findByText('CN-001'))
    await user.click(screen.getByRole('button', { name: 'Reconcile' }))

    const dialog = screen.getByRole('dialog', { name: 'Reconcile consignment' })
    await user.type(dialog.querySelector('textarea')!, 'Attempting close')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Not permitted to reconcile consignments')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Reconcile consignment' })).toBeInTheDocument()
  })

  test('anomalies tab filters to GPS kinds only', async () => {
    const user = userEvent.setup()
    seedConsignments([CON])
    seedExceptions([
      exception(),
      exception({ id: 'exc_2', kind: 'missing_package' as DeliveryExceptionKind, shipmentId: null, orderId: 'ord_9' }),
    ])
    render(
      <MemoryRouter>
        <ReconciliationPage />
      </MemoryRouter>,
    )
    await screen.findByText('CN-001')
    await user.click(screen.getByRole('button', { name: 'Anomalies' }))

    expect(await screen.findByText('exc_1')).toBeInTheDocument()
    expect(screen.queryByText('exc_2')).not.toBeInTheDocument()
    expect(screen.getByText('scan gps mismatch')).toBeInTheDocument()

    await user.click(screen.getByText('exc_1'))
    expect(screen.getByRole('link', { name: 'Open exception' })).toHaveAttribute('href', '/operations/exceptions')
  })

  test('anomalies sort unresolved first', async () => {
    const user = userEvent.setup()
    seedConsignments([CON])
    seedExceptions([
      exception({
        id: 'exc_1',
        status: 'resolved',
        resolvedAt: '2026-08-13T08:00:00.000Z',
        createdAt: '2026-08-12T10:00:00.000Z',
      }),
      exception({ id: 'exc_2', status: 'open', createdAt: '2026-08-13T10:00:00.000Z' }),
    ])
    render(<ReconciliationPage />)
    await screen.findByText('CN-001')
    await user.click(screen.getByRole('button', { name: 'Anomalies' }))

    await screen.findByText('exc_2')
    const rows = screen.getAllByRole('row').filter((r) => r.classList.contains('row-click'))
    expect(rows[0].textContent).toContain('exc_2')
    expect(rows[1].textContent).toContain('exc_1')
  })
})
