import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'
import { DispatchConsolePage } from './DispatchConsolePage'
import { server } from '../test/setup'
import { seedStaffSession } from '../lib/session'

const DISPATCHABLE = { id: 'ord_1', no: 'ORD-1', status: 'paid', priority: 'normal', merchantId: 'mrc_1', riderId: null, totals: { totalTZS: 9000 }, createdAt: '2026-08-13T10:00:00.000Z' }
const OTHER = { id: 'ord_2', no: 'ORD-2', status: 'delivered', priority: 'vip', merchantId: 'mrc_1', riderId: 'rdr_9', totals: { totalTZS: 2000 }, createdAt: '2026-08-13T09:00:00.000Z' }

const RIDER = { id: 'rdr_1', name: 'Anna M.', city: 'Dar es Salaam', vehicle: 'Bike', licensePlate: 'T 123 ABC', verification: 'approved', documents: [] }

function seed({ orders, riders }: { orders: Array<Record<string, unknown>>; riders: Array<Record<string, unknown>> }) {
  server.use(
    http.get('/admin/orders', () => HttpResponse.json(orders)),
    http.get('/admin/riders', () => HttpResponse.json(riders)),
  )
}

describe('DispatchConsolePage', () => {
  it('filters the queue to dispatchable unassigned orders', async () => {
    seed({ orders: [{ ...DISPATCHABLE }, { ...OTHER }], riders: [{ ...RIDER }] })
    render(<DispatchConsolePage />)

    expect(await screen.findByText('ORD-1')).toBeInTheDocument()
    expect(screen.queryByText('ORD-2')).not.toBeInTheDocument()
    expect(screen.getByText(/1 orders awaiting assignment/)).toBeInTheDocument()
  })

  it('filters by priority', async () => {
    seed({
      orders: [
        { ...DISPATCHABLE },
        { ...DISPATCHABLE, id: 'ord_3', no: 'ORD-3', priority: 'vip' },
      ],
      riders: [{ ...RIDER }],
    })
    render(<DispatchConsolePage />)
    expect(await screen.findByText('ORD-1')).toBeInTheDocument()

    screen.getByRole('button', { name: 'vip' }).click()
    await waitFor(() => expect(screen.queryByText('ORD-1')).not.toBeInTheDocument())
    expect(screen.getByText('ORD-3')).toBeInTheDocument()
  })

  it('sorts the assignment queue by total', async () => {
    seed({
      orders: [
        { ...DISPATCHABLE },
        { ...DISPATCHABLE, id: 'ord_5', no: 'ORD-5', totals: { totalTZS: 4000 } },
      ],
      riders: [{ ...RIDER }],
    })
    render(<DispatchConsolePage />)
    await screen.findByText('ORD-1')

    const table = screen.getByLabelText('Assignment queue')
    const firstOrder = () => within(table).getAllByRole('row')[1]?.textContent ?? ''
    expect(firstOrder()).toContain('ORD-1')

    fireEvent.click(within(table).getByRole('button', { name: /Total/ }))

    expect(firstOrder()).toContain('ORD-5')
    expect(within(table).getByText('Total ▲')).toBeInTheDocument()
  })

  it('assigns a selected order to a rider with the typed reason', async () => {
    seed({ orders: [{ ...DISPATCHABLE }], riders: [{ ...RIDER }] })
    let body: unknown = null
    server.use(
      http.post('/admin/orders/ord_1/assign-rider', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ ...DISPATCHABLE, status: 'rider_assigned', riderId: 'rdr_1' })
      }),
    )
    render(<DispatchConsolePage />)

    const assignBtn = await screen.findByText('Assign')
    await userEvent.click(assignBtn)
    const riderCard = await screen.findByText('Anna M.')
    await userEvent.click(riderCard)
    await userEvent.type(screen.getByLabelText('Reason'), 'Rider is closest to the merchant')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText(/assigned to Anna M/)).toBeInTheDocument()
    expect(body).toEqual({ riderId: 'rdr_1', reason: 'Rider is closest to the merchant' })
  })

  it('surfaces an error when assignment fails', async () => {
    seed({ orders: [{ ...DISPATCHABLE }], riders: [{ ...RIDER }] })
    server.use(
      http.post('/admin/orders/ord_1/assign-rider', () =>
        HttpResponse.json({ code: 'ORDER_NOT_ASSIGNABLE', message: 'too late' }, { status: 409 }),
      ),
    )
    render(<DispatchConsolePage />)

    const assignBtn = await screen.findByText('Assign')
    await userEvent.click(assignBtn)
    const riderCard = await screen.findByText('Anna M.')
    await userEvent.click(riderCard)
    await userEvent.type(screen.getByLabelText('Reason'), 'Rider is closest to the merchant')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText(/Assignment failed/)).toBeInTheDocument()
  })

  it('shows orders with a rider in the reassignment queue', async () => {
    const ASSIGNED = { ...DISPATCHABLE, id: 'ord_4', no: 'ORD-4', status: 'rider_assigned', riderId: 'rdr_1' }
    seed({ orders: [{ ...DISPATCHABLE }, { ...ASSIGNED }], riders: [{ ...RIDER }] })
    render(<DispatchConsolePage />)

    expect(await screen.findByText('ORD-4')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Reassignment queue' })).toBeInTheDocument()
    expect(screen.getByText(/1 awaiting reassignment/)).toBeInTheDocument()
  })

  it('reassigns a selected order to a rider with the typed reason and removes it from the queue', async () => {
    const ASSIGNED = { ...DISPATCHABLE, id: 'ord_4', no: 'ORD-4', status: 'rider_assigned', riderId: 'rdr_1' }
    seed({ orders: [{ ...ASSIGNED }], riders: [{ ...RIDER }] })
    let body: unknown = null
    server.use(
      http.post('/admin/orders/ord_4/assign-rider', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ ...ASSIGNED, riderId: 'rdr_1' })
      }),
    )
    render(<DispatchConsolePage />)

    const reassignBtn = await screen.findByText('Reassign')
    await userEvent.click(reassignBtn)
    const riderCard = await screen.findByRole('button', { name: /Anna M/ })
    await userEvent.click(riderCard)
    await userEvent.type(screen.getByLabelText('Reason'), 'Rider was unavailable at pickup')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText(/reassigned to Anna M/)).toBeInTheDocument()
    expect(body).toEqual({ riderId: 'rdr_1', reason: 'Rider was unavailable at pickup' })
    await waitFor(() => expect(screen.queryByText('Reassign')).not.toBeInTheDocument())
    expect(screen.queryByText('ORD-4')).not.toBeInTheDocument()
    expect(screen.getByText(/0 awaiting reassignment/)).toBeInTheDocument()
  })

  it('shows an inline error when reassignment fails and keeps the page intact', async () => {
    const ASSIGNED = { ...DISPATCHABLE, id: 'ord_4', no: 'ORD-4', status: 'rider_assigned', riderId: 'rdr_1' }
    seed({ orders: [{ ...ASSIGNED }], riders: [{ ...RIDER }] })
    server.use(
      http.post('/admin/orders/ord_4/assign-rider', () =>
        HttpResponse.json({ code: 'ORDER_NOT_ASSIGNABLE', message: 'too late' }, { status: 409 }),
      ),
    )
    render(<DispatchConsolePage />)

    const reassignBtn = await screen.findByText('Reassign')
    await userEvent.click(reassignBtn)
    const riderCard = await screen.findByRole('button', { name: /Anna M/ })
    await userEvent.click(riderCard)
    await userEvent.type(screen.getByLabelText('Reason'), 'Rider was unavailable at pickup')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText(/Reassignment failed/)).toBeInTheDocument()
    expect(screen.getAllByText('ORD-4').length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: 'Reassignment queue' })).toBeInTheDocument()
  })

  it('only offers approved riders', async () => {
    seed({
      orders: [{ ...DISPATCHABLE }],
      riders: [
        { ...RIDER },
        { ...RIDER, id: 'rdr_2', name: 'Bob K.', verification: 'pending' },
      ],
    })
    render(<DispatchConsolePage />)
    expect(await screen.findByText('Anna M.')).toBeInTheDocument()
    expect(screen.queryByText('Bob K.')).not.toBeInTheDocument()
  })

  it('shows checkboxes on dispatchable rows and selects all from the header', async () => {
    seed({
      orders: [{ ...DISPATCHABLE }, { ...DISPATCHABLE, id: 'ord_3', no: 'ORD-3' }],
      riders: [{ ...RIDER }],
    })
    render(<DispatchConsolePage />)

    const cb1 = await screen.findByLabelText('Select order ORD-1')
    const cb3 = screen.getByLabelText('Select order ORD-3')
    expect(cb1).not.toBeChecked()
    expect(cb3).not.toBeChecked()
    expect(screen.queryByRole('button', { name: /selected/ })).not.toBeInTheDocument()

    await userEvent.click(screen.getByLabelText('Select all dispatchable'))
    expect(cb1).toBeChecked()
    expect(cb3).toBeChecked()
    expect(screen.getByRole('button', { name: 'Assign 2 selected' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear selection' })).toBeInTheDocument()

    await userEvent.click(screen.getByLabelText('Select all dispatchable'))
    expect(cb1).not.toBeChecked()
    expect(cb3).not.toBeChecked()
    expect(screen.queryByRole('button', { name: /selected/ })).not.toBeInTheDocument()
  })

  it('bulk assigns every selected order sequentially and reports per-row outcomes', async () => {
    seed({
      orders: [{ ...DISPATCHABLE }, { ...DISPATCHABLE, id: 'ord_3', no: 'ORD-3' }],
      riders: [{ ...RIDER }],
    })
    const bodies: unknown[] = []
    server.use(
      http.post('/admin/orders/ord_1/assign-rider', async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ ...DISPATCHABLE, status: 'rider_assigned', riderId: 'rdr_1' })
      }),
      http.post('/admin/orders/ord_3/assign-rider', async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ ...DISPATCHABLE, id: 'ord_3', no: 'ORD-3', status: 'rider_assigned', riderId: 'rdr_1' })
      }),
    )
    render(<DispatchConsolePage />)

    await userEvent.click(await screen.findByLabelText('Select order ORD-1'))
    await userEvent.click(screen.getByLabelText('Select order ORD-3'))
    await userEvent.click(screen.getByRole('button', { name: 'Assign 2 selected' }))
    await userEvent.type(screen.getByLabelText('Reason'), 'Cluster pickup for peak hour')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await userEvent.click(await screen.findByRole('button', { name: /Anna M/ }))

    expect(await screen.findByText('2 assigned · 0 failed')).toBeInTheDocument()
    expect(screen.getByText('Bulk assignment complete — 2 assigned')).toBeInTheDocument()
    expect(bodies).toEqual([
      { riderId: 'rdr_1', reason: 'Cluster pickup for peak hour' },
      { riderId: 'rdr_1', reason: 'Cluster pickup for peak hour' },
    ])
    expect(screen.getAllByText('assigned')).toHaveLength(2)
    expect(screen.getAllByText('assigned to Anna M.')).toHaveLength(2)

    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByText('2 assigned · 0 failed')).not.toBeInTheDocument()
  })

  it('keeps going on partial failure and reports the error code per row', async () => {
    seed({
      orders: [{ ...DISPATCHABLE }, { ...DISPATCHABLE, id: 'ord_3', no: 'ORD-3' }],
      riders: [{ ...RIDER }],
    })
    server.use(
      http.post('/admin/orders/ord_1/assign-rider', () =>
        HttpResponse.json({ code: 'ORDER_NOT_ASSIGNABLE', message: 'too late' }, { status: 409 }),
      ),
      http.post('/admin/orders/ord_3/assign-rider', () =>
        HttpResponse.json({ ...DISPATCHABLE, id: 'ord_3', no: 'ORD-3', status: 'rider_assigned', riderId: 'rdr_1' }),
      ),
    )
    render(<DispatchConsolePage />)

    await userEvent.click(await screen.findByLabelText('Select order ORD-1'))
    await userEvent.click(screen.getByLabelText('Select order ORD-3'))
    await userEvent.click(screen.getByRole('button', { name: 'Assign 2 selected' }))
    await userEvent.type(screen.getByLabelText('Reason'), 'Rider on route')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await userEvent.click(await screen.findByRole('button', { name: /Anna M/ }))

    expect(await screen.findByText('1 assigned · 1 failed')).toBeInTheDocument()
    expect(screen.getByText('failed: ORDER_NOT_ASSIGNABLE')).toBeInTheDocument()
    expect(screen.getByText('too late')).toBeInTheDocument()
    expect(screen.getByText('assigned to Anna M.')).toBeInTheDocument()
    expect(screen.getByText('Bulk assignment complete — 1 assigned')).toBeInTheDocument()
  })

  it('never shows bulk selection without dispatch.assign permission', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seed({
      orders: [{ ...DISPATCHABLE }, { ...DISPATCHABLE, id: 'ord_3', no: 'ORD-3' }],
      riders: [{ ...RIDER }],
    })
    render(<DispatchConsolePage />)

    await screen.findByText('ORD-1')
    expect(screen.queryByLabelText('Select all dispatchable')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Select order ORD-1')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /selected/ })).not.toBeInTheDocument()
  })

  it('hides assign and reassign actions without dispatch permissions', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seed({ orders: [{ ...DISPATCHABLE }], riders: [{ ...RIDER }] })
    render(<DispatchConsolePage />)

    expect(await screen.findByText('ORD-1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Assign' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reassign' })).not.toBeInTheDocument()
    expect(screen.getByText("You don't have dispatch permissions")).toBeInTheDocument()
    expect(screen.queryByText('Anna M.')).not.toBeInTheDocument()
  })
})
