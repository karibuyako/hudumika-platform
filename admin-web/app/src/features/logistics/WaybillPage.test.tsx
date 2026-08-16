import { describe, expect, test } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import type { CustodyEntry, WaybillEvent } from '@hudumika/contract'
import { server } from '../../test/setup'
import { WaybillPage } from './WaybillPage'

const waybillEvent = (over: Partial<WaybillEvent> = {}): WaybillEvent => ({
  at: '2026-08-10T12:00:00.000Z',
  type: 'scanned',
  location: 'Dar hub',
  actor: 'rider_r1',
  note: null,
  ...over,
})

const custodyEntry = (over: Partial<CustodyEntry> = {}): CustodyEntry => ({
  id: 'ce_1',
  shipmentId: 'shp_1',
  eventType: 'handoff',
  actorId: 'r_1',
  actorType: 'rider',
  deviceId: null,
  previousState: 'at_hub',
  newState: 'in_transit',
  evidence: null,
  at: '2026-08-10T09:00:00.000Z',
  ...over,
})

describe('WaybillPage', () => {
  test('renders tabs and the waybill lookup form', () => {
    render(<WaybillPage />)
    expect(screen.getByRole('tablist', { name: 'Waybill and custody audit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Order waybill' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Shipment custody' })).toBeInTheDocument()
    expect(screen.getByLabelText('Order ID')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load waybill' })).toBeInTheDocument()
    expect(screen.getByText('Waybill trails are append-only and audited (waybill.*).')).toBeInTheDocument()
  })

  test('waybill load renders timeline rows sorted desc by at', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/orders/ord_1/waybill', () =>
        HttpResponse.json({
          waybillNumber: 'WB-1001',
          events: [
            waybillEvent({ at: '2026-08-09T08:00:00.000Z', type: 'handoff', location: 'Origin hub', note: 'Seal intact' }),
            waybillEvent({ at: '2026-08-10T12:00:00.000Z', type: 'delivered', location: 'Customer door', actor: 'rider_r2' }),
          ],
        }),
      ),
    )
    const { container } = render(<WaybillPage />)
    await user.type(screen.getByLabelText('Order ID'), 'ord_1')
    await user.click(screen.getByRole('button', { name: 'Load waybill' }))

    expect(await screen.findByText('delivered')).toBeInTheDocument()
    expect(screen.getByText('handoff')).toBeInTheDocument()
    expect(screen.getByText('Origin hub')).toBeInTheDocument()
    expect(screen.getByText('Customer door')).toBeInTheDocument()
    expect(screen.getByText('rider_r1')).toBeInTheDocument()
    expect(screen.getByText('Seal intact')).toBeInTheDocument()

    const items = container.querySelectorAll('.timeline-item')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('delivered')
    expect(items[1].textContent).toContain('handoff')
  })

  test('waybill empty renders "No waybill events recorded"', async () => {
    const user = userEvent.setup()
    server.use(http.get('*/orders/ord_1/waybill', () => HttpResponse.json({ waybillNumber: 'WB-1001', events: [] })))
    render(<WaybillPage />)
    await user.type(screen.getByLabelText('Order ID'), 'ord_1')
    await user.click(screen.getByRole('button', { name: 'Load waybill' }))

    expect(await screen.findByText('No waybill events recorded')).toBeInTheDocument()
  })

  test('waybill 404 renders "Waybill not found"', async () => {
    const user = userEvent.setup()
    server.use(http.get('*/orders/ord_404/waybill', () => new HttpResponse(null, { status: 404 })))
    render(<WaybillPage />)
    await user.type(screen.getByLabelText('Order ID'), 'ord_404')
    await user.click(screen.getByRole('button', { name: 'Load waybill' }))

    expect(await screen.findByText('Waybill not found')).toBeInTheDocument()
  })

  test('waybill error shows ErrorState and retry refetches the same orderId', async () => {
    const user = userEvent.setup()
    let calls = 0
    server.use(
      http.get('*/orders/ord_1/waybill', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'INTERNAL', message: 'boom', requestId: 'req-1' }, { status: 500 })
        }
        return HttpResponse.json({ waybillNumber: 'WB-1001', events: [waybillEvent()] })
      }),
    )
    render(<WaybillPage />)
    await user.type(screen.getByLabelText('Order ID'), 'ord_1')
    await user.click(screen.getByRole('button', { name: 'Load waybill' }))

    expect(await screen.findByText('Failed to load waybill (500)')).toBeInTheDocument()
    expect(screen.queryByText('scanned')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('scanned')).toBeInTheDocument()
    expect(calls).toBe(2)
  })

  test('waybill with an exception event shows the damage-claim hint', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/orders/ord_1/waybill', () =>
        HttpResponse.json({
          waybillNumber: 'WB-1001',
          events: [waybillEvent({ type: 'exception', note: 'Seal broken' })],
        }),
      ),
    )
    render(<WaybillPage />)
    await user.type(screen.getByLabelText('Order ID'), 'ord_1')
    await user.click(screen.getByRole('button', { name: 'Load waybill' }))

    expect(await screen.findByText('exception')).toBeInTheDocument()
    expect(screen.getByText('Seal broken')).toBeInTheDocument()
    expect(
      screen.getByText('Exception on this trail — open the shipment for damage-claim review'),
    ).toBeInTheDocument()
  })

  test('custody tab loads entries and renders previousState → newState', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/shipments/shp_1/custody', () =>
        HttpResponse.json([
          custodyEntry({ id: 'ce_1', eventType: 'handoff', deviceId: 'dev-7', evidence: 'photo-id' }),
          custodyEntry({ id: 'ce_2', eventType: 'delivered', actorId: 'r_2', previousState: 'in_transit', newState: 'delivered' }),
        ]),
      ),
    )
    render(<WaybillPage />)
    await user.click(screen.getByRole('button', { name: 'Shipment custody' }))
    expect(screen.getByLabelText('Shipment ID')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Shipment ID'), 'shp_1')
    await user.click(screen.getByRole('button', { name: 'Load custody' }))

    expect(await screen.findByText('at_hub → in_transit')).toBeInTheDocument()
    expect(screen.getByText('in_transit → delivered')).toBeInTheDocument()
    expect(screen.getByText('rider · r_1')).toBeInTheDocument()
    expect(screen.getByText('device dev-7')).toBeInTheDocument()
    expect(screen.getByText('photo-id')).toBeInTheDocument()
  })

  test('custody 404 renders "Custody not found"', async () => {
    const user = userEvent.setup()
    server.use(http.get('*/shipments/shp_404/custody', () => new HttpResponse(null, { status: 404 })))
    render(<WaybillPage />)
    await user.click(screen.getByRole('button', { name: 'Shipment custody' }))
    await user.type(screen.getByLabelText('Shipment ID'), 'shp_404')
    await user.click(screen.getByRole('button', { name: 'Load custody' }))

    expect(await screen.findByText('Custody not found')).toBeInTheDocument()
  })

  test('empty orderId shows inline error and does not fetch', async () => {
    let calls = 0
    server.use(
      http.get('*/orders/:orderId/waybill', () => {
        calls += 1
        return HttpResponse.json({ waybillNumber: 'WB-1001', events: [] })
      }),
    )
    render(<WaybillPage />)
    fireEvent.submit(screen.getByRole('button', { name: 'Load waybill' }).closest('form')!)

    expect(await screen.findByText('Order ID is required')).toBeInTheDocument()
    expect(calls).toBe(0)
  })

  test('custody with a handoff evidence mentioning seal shows the seal-broken callout', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/shipments/shp_1/custody', () =>
        HttpResponse.json([
          custodyEntry({ id: 'ce_1', eventType: 'handoff', evidence: 'Seal broken during transfer' }),
        ]),
      ),
    )
    render(<WaybillPage />)
    await user.click(screen.getByRole('button', { name: 'Shipment custody' }))
    await user.type(screen.getByLabelText('Shipment ID'), 'shp_1')
    await user.click(screen.getByRole('button', { name: 'Load custody' }))

    expect(await screen.findByText('Seal-broken handoff')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Re-seal' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Damage claim' })).toBeInTheDocument()
  })

  test('custody without seal evidence shows no seal-broken callout', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/shipments/shp_1/custody', () =>
        HttpResponse.json([
          custodyEntry({ id: 'ce_1', eventType: 'handoff', evidence: 'photo-id' }),
          custodyEntry({ id: 'ce_2', eventType: 'delivered', evidence: 'delivery photo' }),
        ]),
      ),
    )
    render(<WaybillPage />)
    await user.click(screen.getByRole('button', { name: 'Shipment custody' }))
    await user.type(screen.getByLabelText('Shipment ID'), 'shp_1')
    await user.click(screen.getByRole('button', { name: 'Load custody' }))

    await screen.findByText('photo-id')
    expect(screen.queryByText('Seal-broken handoff')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Re-seal' })).not.toBeInTheDocument()
  })

  test('seal-broken actions complete to the seal_broken_resolve pending notice', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/shipments/shp_1/custody', () =>
        HttpResponse.json([custodyEntry({ id: 'ce_1', eventType: 'handoff', evidence: 'Seal broken' })]),
      ),
    )
    render(<WaybillPage />)
    await user.click(screen.getByRole('button', { name: 'Shipment custody' }))
    await user.type(screen.getByLabelText('Shipment ID'), 'shp_1')
    await user.click(screen.getByRole('button', { name: 'Load custody' }))
    await screen.findByRole('button', { name: 'Re-seal' })

    await user.click(screen.getByRole('button', { name: 'Damage claim' }))
    const prompt = screen.getByRole('dialog', { name: 'Damage claim' })
    await user.type(prompt.querySelector('textarea')!, 'Package contents damaged')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('PENDING_ENDPOINT')).toBeInTheDocument()
    expect(screen.getByText(/POST \/admin\/handoffs\/\{handoffId\}\/seal/)).toBeInTheDocument()
    expect(
      screen.getByText('This action is documented for backend implementation — nothing was sent.'),
    ).toBeInTheDocument()
  })
})
