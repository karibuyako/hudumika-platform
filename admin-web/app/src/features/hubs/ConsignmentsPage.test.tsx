import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'
import { ConsignmentsPage } from './ConsignmentsPage'
import { server } from '../../test/setup'

const CON: Record<string, unknown> = {
  id: 'con_1',
  consignmentNumber: 'CN-001',
  fromHubId: 'hub_a',
  toHubId: 'hub_b',
  transportMode: 'linehaul_truck',
  carrierId: 'car_7',
  orderCount: 42,
  status: 'in_transit',
  scheduledDeparture: '2026-08-16T06:00:00.000Z',
  departedAt: '2026-08-16T06:30:00.000Z',
  arrivedAt: null,
  createdAt: '2026-08-15T20:00:00.000Z',
}

function seed(consignments: Array<Record<string, unknown>>) {
  server.use(http.get('/linehaul/consignments', () => HttpResponse.json(consignments)))
}

describe('ConsignmentsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows a loading skeleton then renders consignment rows', async () => {
    seed([
      CON,
      { ...CON, id: 'con_2', fromHubId: 'hub_b', toHubId: 'hub_c', transportMode: 'van', carrierId: null, orderCount: 12, status: 'delivered', arrivedAt: '2026-08-16T12:00:00.000Z' },
    ])
    render(<ConsignmentsPage />)

    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
    expect(await screen.findByText('con_1')).toBeInTheDocument()
    expect(screen.getByText('con_2')).toBeInTheDocument()
    expect(screen.getByText('hub_a → hub_b')).toBeInTheDocument()
    expect(screen.getByText('linehaul_truck')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getAllByText('in transit')).toHaveLength(2)
    expect(screen.getAllByText('delivered')).toHaveLength(2)
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('filters rows by status chips with counts', async () => {
    seed([
      CON,
      { ...CON, id: 'con_2', status: 'delivered', arrivedAt: '2026-08-16T12:00:00.000Z' },
      { ...CON, id: 'con_3', status: 'manifesting' },
    ])
    render(<ConsignmentsPage />)
    await screen.findByText('con_1')

    expect(screen.getByRole('button', { name: 'All 3' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'in transit 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'delivered 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'at hub 0' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'cancelled 0' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'delivered 1' }))
    await waitFor(() => expect(screen.queryByText('con_1')).not.toBeInTheDocument())
    expect(screen.getByText('con_2')).toBeInTheDocument()
  })

  it('shows an empty state when there are no consignments', async () => {
    seed([])
    render(<ConsignmentsPage />)
    expect(await screen.findByText('No consignments found')).toBeInTheDocument()
  })

  it('shows an error state and recovers on retry', async () => {
    server.use(
      http.get('/linehaul/consignments', () => HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 })),
    )
    render(<ConsignmentsPage />)
    expect(await screen.findByText('Failed to load consignments')).toBeInTheDocument()

    seed([CON])
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('con_1')).toBeInTheDocument()
  })

  it('lists consignments with an unscanned waybill in the missing-order queue', async () => {
    seed([
      {
        ...CON,
        manifest: [
          { orderId: 'ord_1', waybillNumber: 'WB-001', section: 'standard', scannedIn: true, scannedOut: true },
          { orderId: 'ord_2', waybillNumber: 'WB-002', section: 'standard', scannedIn: false, scannedOut: false },
        ],
      },
    ])
    render(<ConsignmentsPage />)

    expect(await screen.findByText('Missing-order queue')).toBeInTheDocument()
    expect(screen.getByText('CN-001')).toBeInTheDocument()
    expect(screen.getByText('WB-002')).toBeInTheDocument()
    expect(screen.queryByText('WB-001')).not.toBeInTheDocument()
    expect(screen.getByText('Resolved via the consignment runbook (workflow 21)')).toBeInTheDocument()
  })

  it('shows the pending-endpoint notice when resolving a missing-order row', async () => {
    seed([
      {
        ...CON,
        manifest: [
          { orderId: 'ord_1', waybillNumber: 'WB-001', section: 'standard', scannedIn: true, scannedOut: true },
          { orderId: 'ord_2', waybillNumber: 'WB-002', section: 'standard', scannedIn: false, scannedOut: false },
        ],
      },
    ])
    render(<ConsignmentsPage />)
    await screen.findByText('CN-001')

    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    const prompt = screen.getByRole('dialog', { name: 'Resolve missing orders' })
    await userEvent.type(prompt.querySelector('textarea')!, 'Order could not be located at the hub')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('PENDING_ENDPOINT')).toBeInTheDocument()
    expect(screen.getByText(/POST \/admin\/consignments\/\{consignmentId\}\/missing/)).toBeInTheDocument()
    expect(
      screen.getByText('This action is documented for backend implementation — nothing was sent.'),
    ).toBeInTheDocument()
  })

  it('shows empty states for the missing-order and seal-broken queues when nothing needs attention', async () => {
    seed([
      {
        ...CON,
        manifest: [{ orderId: 'ord_1', waybillNumber: 'WB-001', section: 'standard', scannedIn: true, scannedOut: true }],
      },
    ])
    render(<ConsignmentsPage />)

    expect(await screen.findByText('No missing orders')).toBeInTheDocument()
    expect(screen.getByText('No seal-broken incidents')).toBeInTheDocument()
    expect(screen.getByText('Resolved via the consignment runbook (workflow 22).')).toBeInTheDocument()
  })

  it('opens a drawer with consignment details', async () => {
    seed([CON])
    render(<ConsignmentsPage />)
    await userEvent.click(await screen.findByText('con_1'))

    expect(await screen.findByText('Order count')).toBeInTheDocument()
    expect(screen.getAllByText('Scheduled departure')).toHaveLength(2)
    expect(screen.getAllByText('hub_a → hub_b')).toHaveLength(2)
    expect(screen.getAllByText('car_7')).toHaveLength(2)
    expect(
      screen.getByText(
        'Missing-order and seal-broken incidents are resolved through the consignment runbooks; resolutions are audited (consignment.*).',
      ),
    ).toBeInTheDocument()
  })

  it('sorts rows by order count via the column header', async () => {
    seed([
      CON,
      { ...CON, id: 'con_2', fromHubId: 'hub_b', toHubId: 'hub_c', orderCount: 12, status: 'delivered' },
      { ...CON, id: 'con_3', orderCount: null },
    ])
    render(<ConsignmentsPage />)
    await screen.findByText('con_1')

    await userEvent.click(screen.getByRole('button', { name: /Orders/ }))

    const table = screen.getByRole('table', { name: 'Consignments' })
    const ids = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(ids).toEqual(['con_2', 'con_1', 'con_3'])

    await userEvent.click(screen.getByRole('button', { name: /Orders/ }))
    const desc = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(desc).toEqual(['con_1', 'con_2', 'con_3'])
  })

  it('exports consignments as CSV via the DataTable', async () => {
    seed([CON])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let downloadName = ''
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadName = this.download
      })
    render(<ConsignmentsPage />)
    await screen.findByText('con_1')

    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(downloadName).toBe('consignments.csv')
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('ID,Corridor,Mode,Carrier,Orders,Status,Scheduled departure,Departed,Arrived')
    expect(csv).toContain('con_1')
    expect(csv).toContain('car_7')
    expect(csv).toContain('42')
    expect(revokeObjectURL).toHaveBeenCalled()
  })
})
