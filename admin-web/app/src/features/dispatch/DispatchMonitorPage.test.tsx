import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import type { OrderDetail, RiderAdmin, Shipment } from '@hudumika/contract'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'
import { DispatchMonitorPage } from './DispatchMonitorPage'

const minAgo = (min: number) => new Date(Date.now() - min * 60000).toISOString()

const order = (over: Partial<OrderDetail> = {}): OrderDetail => ({
  id: 'ord_1',
  no: 'ORD-1001',
  status: 'paid',
  merchantId: 'mch_1',
  totals: { subtotalTZS: 10000, deliveryFeeTZS: 3000, platformFeeTZS: 1000, taxTZS: 1000, discountTZS: 0, totalTZS: 15000 },
  createdAt: minAgo(45),
  deliveryAddress: { label: 'Home', lines: 'Street 1', contactPhone: '+255700000000' },
  events: [],
  ...over,
})

const rider = (over: Partial<RiderAdmin> = {}): RiderAdmin => ({
  id: 'rdr_1',
  name: 'Asha Mwakalinga',
  city: 'Dar es Salaam',
  vehicle: 'Bike',
  verification: 'approved',
  documents: [],
  reliabilityScore: 91,
  ...over,
})

const shipment = (over: Partial<Shipment> = {}): Shipment => ({
  id: 'shp_1',
  shipmentNumber: 'SHP-1001',
  orderId: 'ord_1',
  status: 'planned',
  createdAt: minAgo(90),
  ...over,
})

function seed(orders: OrderDetail[], riders: RiderAdmin[], shipments: Shipment[]) {
  server.use(
    http.get('/admin/orders', () => HttpResponse.json(orders)),
    http.get('/admin/riders', () => HttpResponse.json(riders)),
    http.get('/shipments', () => HttpResponse.json(shipments)),
  )
}

function section(name: string) {
  return within(screen.getByRole('heading', { name }).closest('section')!)
}

function renderPage() {
  return render(
    <MemoryRouter>
      <DispatchMonitorPage />
    </MemoryRouter>,
  )
}

describe('DispatchMonitorPage', () => {
  it('flags a 45-minute-old dispatchable order as stuck with its age', async () => {
    seed(
      [order({ id: 'ord_1', no: 'ORD-1001', status: 'paid', riderId: 'rdr_1' })],
      [rider()],
      [shipment({ status: 'in_transit' })],
    )
    renderPage()
    expect(screen.getByLabelText('Loading')).toBeInTheDocument()

    const stuck = await screen.findByText('ORD-1001')
    expect(stuck).toBeInTheDocument()
    expect(section('Stuck orders').getByText('45 min')).toBeInTheDocument()
    expect(section('Stuck orders').getByText(/Rider rdr_1/)).toBeInTheDocument()
    expect(section('Stuck orders').getByText('paid')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Open in console' })[0]).toHaveAttribute(
      'href',
      '/operations/dispatch',
    )
  })

  it('does not list a fresh order in the stuck queue', async () => {
    seed([order({ id: 'ord_2', no: 'ORD-1002', status: 'paid', createdAt: minAgo(5) })], [rider()], [shipment({ status: 'delivered' })])
    renderPage()

    expect(await screen.findByText('No stuck orders')).toBeInTheDocument()
    expect(screen.queryByText('ORD-1002')).not.toBeInTheDocument()
  })

  it('lists paid orders without a rider older than 10 minutes as acceptance timeouts', async () => {
    seed(
      [
        order({ id: 'ord_3', no: 'ORD-1003', status: 'merchant_accepted', createdAt: minAgo(15), merchantId: 'mch_7' }),
        order({ id: 'ord_4', no: 'ORD-1004', status: 'merchant_accepted', riderId: 'rdr_1', createdAt: minAgo(15) }),
      ],
      [rider()],
      [shipment({ status: 'delivered' })],
    )
    renderPage()

    const timeouts = await screen.findByText('ORD-1003')
    expect(timeouts).toBeInTheDocument()
    expect(section('Acceptance timeouts').getByText('15 min')).toBeInTheDocument()
    expect(section('Acceptance timeouts').getByText(/Merchant mch_7/)).toBeInTheDocument()
    expect(section('Acceptance timeouts').queryByText('ORD-1004')).not.toBeInTheDocument()
  })

  it('groups the rider pool by city and renders depth bars', async () => {
    seed(
      [],
      [
        rider({ id: 'rdr_1', city: 'Dar es Salaam' }),
        rider({ id: 'rdr_2', city: 'Dar es Salaam' }),
        rider({ id: 'rdr_3', city: 'Arusha' }),
        rider({ id: 'rdr_4', city: 'Mwanza', verification: 'rejected' }),
      ],
      [],
    )
    renderPage()

    expect(await screen.findByText('Dar es Salaam')).toBeInTheDocument()

    const dar = screen.getByText('Dar es Salaam').closest('tr')!
    const arusha = screen.getByText('Arusha').closest('tr')!
    expect(dar.querySelector('.bar-fill')).toHaveStyle({ width: '100%' })
    expect(arusha.querySelector('.bar-fill')).toHaveStyle({ width: '50%' })
    expect(within(dar).getByText('2')).toBeInTheDocument()
    expect(within(arusha).getByText('1')).toBeInTheDocument()
    expect(screen.queryByText('Mwanza')).not.toBeInTheDocument()
  })

  it('shows empty queues but keeps the rider pools visible', async () => {
    seed(
      [
        order({ id: 'ord_5', no: 'ORD-1005', status: 'paid', createdAt: minAgo(5) }),
        order({ id: 'ord_6', no: 'ORD-1006', status: 'delivered' }),
      ],
      [rider()],
      [shipment({ status: 'delivered' })],
    )
    renderPage()

    expect(await screen.findByText('No stuck orders')).toBeInTheDocument()
    expect(screen.getByText('No acceptance timeouts')).toBeInTheDocument()
    expect(screen.getByText('No stuck shipments')).toBeInTheDocument()
    expect(screen.getByText('Dar es Salaam')).toBeInTheDocument()
  })

  it('shows an error state and recovers on retry', async () => {
    let calls = 0
    server.use(
      http.get('/admin/orders', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'SERVICE_DOWN', message: 'down', requestId: 'req_1' }, { status: 500 })
        }
        return HttpResponse.json([order({ riderId: 'rdr_1' })])
      }),
      http.get('/admin/riders', () => HttpResponse.json([rider()])),
      http.get('/shipments', () => HttpResponse.json([])),
    )
    renderPage()

    expect(await screen.findByText('Dispatch monitor unavailable')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('ORD-1001')).toBeInTheDocument()
    expect(screen.queryByText('Dispatch monitor unavailable')).not.toBeInTheDocument()
  })

  it('escalates a stuck shipment with a reason and shows a toast', async () => {
    const user = userEvent.setup()
    let rows: Shipment[] = [shipment()]
    const escalateCalls: Array<{ reason: string }> = []
    server.use(
      http.get('/admin/orders', () => HttpResponse.json([])),
      http.get('/admin/riders', () => HttpResponse.json([rider()])),
      http.get('/shipments', () => HttpResponse.json(rows)),
      http.post('*/admin/shipments/shp_1/escalate', async ({ request }) => {
        escalateCalls.push((await request.json()) as { reason: string })
        rows = [{ ...rows[0], status: 'exception' }]
        return HttpResponse.json(rows[0])
      }),
    )
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Escalate' }))

    const dialog = screen.getByRole('dialog', { name: 'Escalate SHP-1001' })
    await user.type(dialog.querySelector('textarea')!, 'Rider unresponsive for 90 minutes')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Shipment SHP-1001 escalated')).toBeInTheDocument()
    expect(escalateCalls).toEqual([{ reason: 'Rider unresponsive for 90 minutes' }])
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Escalate' })).not.toBeInTheDocument())
  })

  it('surfaces a 403 denial inline in the escalation prompt', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/admin/orders', () => HttpResponse.json([])),
      http.get('/admin/riders', () => HttpResponse.json([rider()])),
      http.get('/shipments', () => HttpResponse.json([shipment()])),
      http.post('*/admin/shipments/shp_1/escalate', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'Not allowed', requestId: 'req-1' }, { status: 403 }),
      ),
    )
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Escalate' }))

    const dialog = screen.getByRole('dialog', { name: 'Escalate SHP-1001' })
    await user.type(dialog.querySelector('textarea')!, 'Rider unresponsive')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Not allowed')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Escalate SHP-1001' })).toBeInTheDocument()
  })

  it('hides the Escalate button when shipment.reassign is not granted', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seed([], [rider()], [shipment()])
    renderPage()

    expect(await screen.findByText('SHP-1001')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Escalate' })).not.toBeInTheDocument()
  })
})
