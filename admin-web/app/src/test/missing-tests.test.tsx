import { describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import type { OrderDetail, RiderAdmin, Shipment } from '@hudumika/contract'
import { server } from './setup'
import { seedStaffSession } from '../lib/session'
import { RefundsPage } from '../features/finance/RefundsPage'
import { DispatchMonitorPage } from '../features/dispatch/DispatchMonitorPage'
import { ShipmentsPage } from '../features/shipments/ShipmentsPage'
import { CustomersPage } from '../features/customers/CustomersPage'
import { TwoPersonApprovalsPage } from '../features/approvals/TwoPersonApprovalsPage'

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
  status: 'in_transit',
  frozenReason: null,
  frozenAt: null,
  declaredValueTZS: 250000,
  createdAt: '2026-08-10T08:00:00.000Z',
  ...over,
})

describe('admin actions — inline ADMIN_REASON_REQUIRED', () => {
  it('surfaces ADMIN_REASON_REQUIRED inline in the refund decision prompt', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/refunds', () => HttpResponse.json([REFUND])),
      http.post('/admin/refunds/ref_1/decision', () =>
        HttpResponse.json(
          { code: 'ADMIN_REASON_REQUIRED', message: 'ADMIN_REASON_REQUIRED: A reason is required', requestId: 'req_1' },
          { status: 400 },
        ),
      ),
    )
    render(<RefundsPage />)

    await user.click(await screen.findByText('ref_1'))
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    const prompt = screen.getByRole('dialog', { name: 'Approve refund' })
    await user.type(within(prompt).getByLabelText('Reason'), 'Customer refund approved')
    await user.click(within(prompt).getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('ADMIN_REASON_REQUIRED: A reason is required')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Approve refund' })).toBeInTheDocument()
    expect(screen.queryByText(/Refund ref_1 approved/)).not.toBeInTheDocument()
  })
})

describe('network failure on the orders surface', () => {
  it('renders the error state when GET /admin/orders throws and recovers on Retry', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/admin/orders', () => {
        throw new Error('ECONNRESET')
      }),
      http.get('/admin/riders', () => HttpResponse.json([rider()])),
      http.get('/shipments', () => HttpResponse.json([])),
    )
    render(
      <MemoryRouter>
        <DispatchMonitorPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Dispatch monitor unavailable')).toBeInTheDocument()
    expect(screen.getByText('Failed to load dispatch monitor')).toBeInTheDocument()

    server.use(http.get('/admin/orders', () => HttpResponse.json([order({ riderId: 'rdr_1' })])))
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('ORD-1001')).toBeInTheDocument()
    expect(screen.queryByText('Dispatch monitor unavailable')).not.toBeInTheDocument()
  })
})

describe('audit-on-timeline gap — frozen shipment state after refetch', () => {
  it('shows the frozen status in the drawer after the freeze refetch (timeline data pending backend)', async () => {
    const user = userEvent.setup()
    let rows: Shipment[] = [shipment()]
    server.use(
      http.get('/shipments', () => HttpResponse.json(rows)),
      http.post('*/admin/shipments/shp_1/freeze', async ({ request }) => {
        const body = (await request.json()) as { reason: string }
        const updated = {
          ...rows[0],
          status: 'frozen' as const,
          frozenReason: body.reason,
          frozenAt: '2026-08-15T09:00:00.000Z',
        }
        rows = [updated]
        return HttpResponse.json(updated)
      }),
    )
    render(<ShipmentsPage />)

    await user.click(await screen.findByText('SHP-1001'))
    await user.click(screen.getByRole('button', { name: 'Freeze' }))

    const prompt = screen.getByRole('dialog', { name: 'Freeze shipment' })
    await user.type(within(prompt).getByLabelText('Reason'), 'Missing package investigation')
    await user.click(within(prompt).getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('SHP-1001 frozen')).toBeInTheDocument()
    await waitFor(() => {
      expect(
        screen.getByText((content, el) => el?.classList.contains('pill') === true && content === 'frozen'),
      ).toBeInTheDocument()
    })

    await user.click(screen.getByText('SHP-1001'))
    const drawer = screen.getByRole('dialog')
    expect(
      within(drawer).getByText((content, el) => el?.classList.contains('pill') === true && content === 'frozen'),
    ).toBeInTheDocument()
    expect(within(drawer).getByText('Missing package investigation')).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Freeze' })).not.toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: 'Initiate unfreeze approval' })).toBeInTheDocument()
  })
})

describe('pagination last page', () => {
  it('pages 25 customers at 20 per page and disables Next on the last page without an empty state', async () => {
    const user = userEvent.setup()
    const customers = Array.from({ length: 25 }, (_, i) => ({
      id: `cus_${i + 1}`,
      phone: `+255700000${String(i + 1).padStart(3, '0')}`,
      fullName: `Customer ${i + 1}`,
      role: 'customer',
      status: 'active',
      orderCount: 1,
      totalSpendTZS: 1000,
      lastOrderAt: '2026-08-01T09:30:00.000Z',
      joinedAt: '2025-01-15T08:00:00.000Z',
      lastActiveAt: '2026-08-10T17:45:00.000Z',
    }))
    server.use(http.get('/admin/customers', () => HttpResponse.json(customers)))
    render(<CustomersPage />)

    expect(await screen.findByText('Customer 1')).toBeInTheDocument()
    expect(screen.queryByText('Customer 21')).not.toBeInTheDocument()

    const table = screen.getByRole('table', { name: 'Customers' })
    expect(within(table).getAllByRole('row')).toHaveLength(21)
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByText('Customer 21')).toBeInTheDocument()
    expect(screen.queryByText('Customer 1')).not.toBeInTheDocument()
    expect(within(table).getAllByRole('row')).toHaveLength(6)
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument()
    expect(screen.queryByText('No customers found')).not.toBeInTheDocument()

    const next = screen.getByRole('button', { name: 'Next' })
    expect(next).toBeDisabled()
    await user.click(next)
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument()
  })
})

describe('module hidden without permission', () => {
  it('hides the New request action on TwoPersonApprovalsPage with only audit.read', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    server.use(http.get('/admin/two-person-approvals', () => HttpResponse.json([])))
    render(<TwoPersonApprovalsPage />)

    expect(await screen.findByText('No approval requests')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New request' })).not.toBeInTheDocument()
    expect(screen.getByText('Two-person decisions require approval.decide')).toBeInTheDocument()
  })
})
