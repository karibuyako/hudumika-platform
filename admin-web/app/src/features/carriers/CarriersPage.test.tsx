import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { CarriersPage } from './CarriersPage'
import { server } from '../../test/setup'
import { toLocal } from '../../lib/time'

const CARRIER: Record<string, unknown> = {
  id: 'car_1',
  name: 'Tanzania Haulage',
  modes: ['van', 'linehaul_truck'],
  regions: ['dar', 'mwanza'],
  apiIntegration: 'sf_token_a',
  status: 'active',
  createdAt: '2026-07-20T10:00:00.000Z',
}

const CARRIER_PAUSED: Record<string, unknown> = {
  ...CARRIER,
  id: 'car_2',
  name: 'Kilimanjaro Express',
  modes: ['train'],
  regions: undefined,
  apiIntegration: null,
  status: 'paused',
}

const CARRIER_SUSPENDED: Record<string, unknown> = {
  ...CARRIER,
  id: 'car_3',
  name: 'Coastal Freight',
  modes: ['air'],
  regions: [],
  status: 'suspended',
}

function seedList(rows: Array<Record<string, unknown>>) {
  server.use(http.get('/carriers', () => HttpResponse.json(rows)))
}

describe('CarriersPage', () => {
  beforeEach(() => {
    server.use(http.get('/linehaul/consignments', () => HttpResponse.json([])))
  })

  it('loads and renders carrier rows with modes, regions, integration, status and dates', async () => {
    seedList([{ ...CARRIER }, { ...CARRIER_PAUSED }])
    render(<CarriersPage />)

    expect(await screen.findByText('Tanzania Haulage')).toBeInTheDocument()
    expect(screen.getByText('Kilimanjaro Express')).toBeInTheDocument()
    expect(screen.getByText('van')).toBeInTheDocument()
    expect(screen.getByText('linehaul_truck')).toBeInTheDocument()
    expect(screen.getByText('train')).toBeInTheDocument()
    expect(screen.getByText('dar')).toBeInTheDocument()
    expect(screen.getByText('mwanza')).toBeInTheDocument()
    expect(screen.getByText('sf_token_a')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(2)
    expect(screen.getAllByText('active')).toHaveLength(2)
    expect(screen.getAllByText('paused')).toHaveLength(2)
    expect(screen.getAllByText(toLocal(String(CARRIER.createdAt)))).toHaveLength(2)
  })

  it('filters rows by status chip with counts', async () => {
    seedList([{ ...CARRIER }, { ...CARRIER_PAUSED }, { ...CARRIER_SUSPENDED }])
    render(<CarriersPage />)
    await screen.findByText('Tanzania Haulage')

    fireEvent.click(screen.getByRole('button', { name: /paused/i }))
    await waitFor(() => expect(screen.queryByText('Tanzania Haulage')).not.toBeInTheDocument())
    expect(screen.getByText('Kilimanjaro Express')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /suspended/i }))
    await waitFor(() => expect(screen.queryByText('Kilimanjaro Express')).not.toBeInTheDocument())
    expect(screen.getByText('Coastal Freight')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^all/i }))
    await waitFor(() => expect(screen.getByText('Tanzania Haulage')).toBeInTheDocument())
  })

  it('shows an empty state when there are no carriers', async () => {
    seedList([])
    render(<CarriersPage />)
    expect(await screen.findByText('No carriers')).toBeInTheDocument()
  })

  it('exports the visible carriers as CSV', async () => {
    seedList([{ ...CARRIER }])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<CarriersPage />)
    await screen.findByText('Tanzania Haulage')

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(anchorClick).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Name,Modes,Regions,API integration,Status,Created')
    expect(csv).toContain('Tanzania Haulage')
    expect(csv).toContain('sf_token_a')
    expect(revokeObjectURL).toHaveBeenCalled()
  })

  it('shows an error state and recovers via retry', async () => {
    server.use(http.get('/carriers', () => HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 })))
    render(<CarriersPage />)
    expect(await screen.findByText('Failed to load carriers')).toBeInTheDocument()

    seedList([{ ...CARRIER }])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Tanzania Haulage')).toBeInTheDocument()
  })

  it('creates a carrier, shows a toast and refetches the list', async () => {
    let posted: Record<string, unknown> | null = null
    const rows: Array<Record<string, unknown>> = [{ ...CARRIER }]
    server.use(
      http.get('/carriers', () => HttpResponse.json(rows)),
      http.post('/carriers', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>
        const created = { ...CARRIER, id: 'car_9', name: String(posted.name), modes: posted.modes }
        rows.push(created)
        return HttpResponse.json(created, { status: 201 })
      }),
    )
    render(<CarriersPage />)
    await screen.findByText('Tanzania Haulage')

    fireEvent.click(screen.getByRole('button', { name: 'New carrier' }))
    const modal = await screen.findByRole('dialog', { name: 'New carrier' })
    fireEvent.change(within(modal).getByLabelText('Name'), { target: { value: 'Lake Zone Logistics' } })
    fireEvent.change(within(modal).getByLabelText('Modes'), { target: { value: 'van, train' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Create carrier' }))

    await waitFor(() => expect(posted).not.toBeNull())
    expect((posted as unknown as Record<string, unknown>)?.name).toBe('Lake Zone Logistics')
    expect((posted as unknown as Record<string, unknown>)?.modes).toEqual(['van', 'train'])
    expect(await screen.findByText('Carrier created')).toBeInTheDocument()
    expect(await screen.findByText('Lake Zone Logistics')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('updates a carrier from the drawer with a toast and refetch', async () => {
    let patched: Record<string, unknown> | null = null
    const rows: Array<Record<string, unknown>> = [{ ...CARRIER }]
    server.use(
      http.get('/carriers', () => HttpResponse.json(rows)),
      http.patch('/carriers/car_1', async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>
        const updated = { ...CARRIER, name: String(patched.name), status: String(patched.status) }
        rows.splice(0, 1, updated)
        return HttpResponse.json(updated)
      }),
    )
    render(<CarriersPage />)
    await screen.findByText('Tanzania Haulage')

    fireEvent.click(screen.getByText('Tanzania Haulage'))
    const drawer = await screen.findByRole('dialog', { name: 'Tanzania Haulage' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit' }))

    const modal = await screen.findByRole('dialog', { name: 'Edit carrier' })
    fireEvent.change(within(modal).getByLabelText('Name'), { target: { value: 'Tanzania Haulage Group' } })
    fireEvent.change(within(modal).getByLabelText('Status'), { target: { value: 'paused' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(patched).not.toBeNull())
    expect((patched as unknown as Record<string, unknown>)?.name).toBe('Tanzania Haulage Group')
    expect((patched as unknown as Record<string, unknown>)?.status).toBe('paused')
    expect(await screen.findByText('Carrier updated')).toBeInTheDocument()
    expect((await screen.findAllByText('Tanzania Haulage Group')).length).toBe(3)
    expect(screen.getByRole('dialog', { name: 'Tanzania Haulage Group' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Edit carrier' })).not.toBeInTheDocument()
  })

  it('shows an inline error when creating a carrier is forbidden', async () => {
    seedList([{ ...CARRIER }])
    server.use(
      http.post('/carriers', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<CarriersPage />)
    await screen.findByText('Tanzania Haulage')

    fireEvent.click(screen.getByRole('button', { name: 'New carrier' }))
    const modal = await screen.findByRole('dialog', { name: 'New carrier' })
    fireEvent.change(within(modal).getByLabelText('Name'), { target: { value: 'Lake Zone Logistics' } })
    fireEvent.change(within(modal).getByLabelText('Modes'), { target: { value: 'van, train' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Create carrier' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'New carrier' })).toBeInTheDocument()
    expect(screen.queryByText('Carrier created')).not.toBeInTheDocument()
  })

  it('renders handoffs in the monitor filtered by the selected carrier', async () => {
    seedList([{ ...CARRIER }, { ...CARRIER_PAUSED }])
    server.use(
      http.get('/linehaul/consignments', () =>
        HttpResponse.json([
          {
            id: 'con_1',
            consignmentNumber: 'CN-001',
            fromHubId: 'hub_a',
            toHubId: 'hub_b',
            transportMode: 'van',
            carrierId: 'car_1',
            status: 'in_transit',
            scheduledDeparture: '2026-08-16T06:00:00.000Z',
            arrivedAt: null,
          },
          {
            id: 'con_2',
            consignmentNumber: 'CN-002',
            fromHubId: 'hub_b',
            toHubId: 'hub_c',
            transportMode: 'linehaul_truck',
            carrierId: 'car_2',
            status: 'at_hub',
            scheduledDeparture: null,
            arrivedAt: '2026-08-16T12:00:00.000Z',
          },
          {
            id: 'con_3',
            consignmentNumber: 'CN-003',
            fromHubId: 'hub_a',
            toHubId: 'hub_b',
            transportMode: 'van',
            carrierId: null,
            status: 'delivered',
            scheduledDeparture: null,
            arrivedAt: null,
          },
        ]),
      ),
    )
    render(<CarriersPage />)
    await screen.findByRole('table', { name: 'Carriers' })

    const monitor = within(await screen.findByRole('table', { name: 'Handoffs' }))
    expect(await monitor.findByText('CN-001')).toBeInTheDocument()
    expect(monitor.getByText('CN-002')).toBeInTheDocument()
    expect(monitor.getByText('in transit')).toBeInTheDocument()
    expect(monitor.getByText('at hub')).toBeInTheDocument()
    expect(monitor.getByText('hub_a → hub_b')).toBeInTheDocument()
    expect(monitor.queryByText('CN-003')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Filter carrier'), { target: { value: 'car_1' } })
    expect(monitor.getByText('CN-001')).toBeInTheDocument()
    expect(monitor.queryByText('CN-002')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Filter carrier'), { target: { value: '' } })
    expect(monitor.getByText('CN-002')).toBeInTheDocument()
  })

  it('shows the empty handoff state when no consignments are assigned', async () => {
    seedList([{ ...CARRIER }])
    render(<CarriersPage />)
    await screen.findByText('Tanzania Haulage')

    expect(await screen.findByText('No handoffs for this carrier')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Pickup/drop-off scans are recorded by the carrier (carrier.*); missing scans past SLA surface in the exception queue.',
      ),
    ).toBeInTheDocument()
  })

  it('shows an inline error with retry when handoffs fail to load', async () => {
    seedList([{ ...CARRIER }])
    server.use(
      http.get('/linehaul/consignments', () => HttpResponse.json({ code: 'X' }, { status: 500 })),
    )
    render(<CarriersPage />)
    await screen.findByText('Tanzania Haulage')

    expect(await screen.findByText('Failed to load handoffs')).toBeInTheDocument()

    server.use(http.get('/linehaul/consignments', () => HttpResponse.json([])))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No handoffs for this carrier')).toBeInTheDocument()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
