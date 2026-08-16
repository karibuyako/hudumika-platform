import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { OrdersPage } from './OrdersPage'
import { server } from '../test/setup'
import { seedStaffSession } from '../lib/session'

const ORDER = {
  id: 'ord_1',
  no: 'ORD-1001',
  status: 'paid',
  priority: 'vip',
  merchantId: 'mrc_1',
  riderId: null,
  totals: { totalTZS: 15000, subtotalTZS: 12000, deliveryFeeTZS: 2000, platformFeeTZS: 500, taxTZS: 500, discountTZS: 0 },
  createdAt: '2026-08-13T10:00:00.000Z',
  items: [{ name: 'Pizza', quantity: 1, unitPriceTZS: 12000 }],
  events: [{ status: 'paid', at: '2026-08-13T10:00:00.000Z', by: 'system' }],
  source: 'app',
  dispatchStrategy: 'auto',
  deliveryAddress: { label: 'Home', lines: '1 Main St', contactPhone: '+255' },
}

function seedOrders(orders: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/orders', () => HttpResponse.json(orders)))
}

describe('OrdersPage', () => {
  it('classifies orders into buckets with counts', async () => {
    seedOrders([
      { ...ORDER },
      { ...ORDER, id: 'ord_2', no: 'ORD-1002', status: 'delivered', riderId: 'rdr_1', totals: { totalTZS: 8000 } },
      { ...ORDER, id: 'ord_3', no: 'ORD-1003', status: 'cancelled', totals: { totalTZS: 0 } },
    ])
    render(<OrdersPage />)

    const all = await screen.findByText('All')
    expect(all).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('Needs rider')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.getByText('Cancelled')).toBeInTheDocument()

    screen.getByText('Cancelled').click()
    await waitFor(() => expect(screen.getByText('ORD-1003')).toBeInTheDocument())
    expect(screen.queryByText('ORD-1001')).not.toBeInTheDocument()
  })

  it('renders money via TZS formatting', async () => {
    seedOrders([{ ...ORDER }])
    render(<OrdersPage />)
    expect(await screen.findByText('TZS 15,000')).toBeInTheDocument()
  })

  it('shows an empty bucket state', async () => {
    seedOrders([{ ...ORDER, status: 'delivered', riderId: 'rdr_1' }])
    render(<OrdersPage />)
    const needsRider = await screen.findByText('Needs rider')
    needsRider.click()
    expect(await screen.findByText('No orders in this bucket')).toBeInTheDocument()
  })

  it('shows error state with retry when the API fails', async () => {
    server.use(http.get('/admin/orders', () => HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 })))
    render(<OrdersPage />)
    expect(await screen.findByText('Failed to load orders')).toBeInTheDocument()
  })

  it('shows the Cancel action for cancellable orders, gated by order.cancel', async () => {
    seedOrders([
      { ...ORDER },
      { ...ORDER, id: 'ord_4', no: 'ORD-1004', status: 'delivering', riderId: 'rdr_1' },
    ])
    render(<OrdersPage />)

    let drawer = await openDrawer('ORD-1001')
    expect(within(drawer).getByRole('button', { name: 'Cancel order' })).toBeInTheDocument()

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }))
    drawer = await openDrawer('ORD-1004')
    expect(within(drawer).queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument()
  })

  it('hides the Cancel action without order.cancel', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seedOrders([{ ...ORDER }])
    render(<OrdersPage />)

    const drawer = await openDrawer('ORD-1001')
    expect(within(drawer).queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument()
  })

  it('shows the pending-endpoint notice after confirming an order cancel', async () => {
    seedOrders([{ ...ORDER }])
    render(<OrdersPage />)

    const drawer = await openDrawer('ORD-1001')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel order' }))

    const prompt = await screen.findByRole('dialog', { name: 'Cancel order' })
    fireEvent.change(within(prompt).getByLabelText('Reason'), { target: { value: 'Stuck at merchant' } })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }))

    expect(screen.queryByRole('dialog', { name: 'Cancel order' })).not.toBeInTheDocument()
    expect(within(drawer).getByText('PENDING_ENDPOINT')).toBeInTheDocument()
    expect(within(drawer).getByText(/POST \/admin\/orders\/\{orderId\}\/cancel/)).toBeInTheDocument()
    expect(within(drawer).getByText(/nothing was sent/)).toBeInTheDocument()
  })

  it('lands dine-in orders in the Dine-in bucket', async () => {
    seedOrders([
      { ...ORDER },
      { ...ORDER, id: 'ord_5', no: 'ORD-1005', fulfillmentType: 'dine_in' },
    ])
    render(<OrdersPage />)

    await screen.findByText('ORD-1001')
    screen.getByText('Dine-in').click()
    await waitFor(() => expect(screen.getByText('ORD-1005')).toBeInTheDocument())
    expect(screen.queryByText('ORD-1001')).not.toBeInTheDocument()
  })
})

async function openDrawer(number: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByText(number))
  const heading = await screen.findByRole('heading', { name: number })
  return heading.closest('.drawer') as HTMLElement
}
