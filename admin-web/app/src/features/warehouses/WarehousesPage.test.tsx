import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { WarehousesPage } from './WarehousesPage'
import { server } from '../../test/setup'
import { toLocal } from '../../lib/time'

const WH: Record<string, unknown> = {
  id: 'wh_1',
  name: 'Dar Hub',
  cityId: 'city_dar',
  address: 'Plot 12, Kariakoo',
  lat: -6.8,
  lon: 39.28,
  servingCities: ['city_dar', 'city_morogoro'],
  stock: [
    { catalogueItemId: 'item_a', quantity: 120 },
    { catalogueItemId: 'item_b', quantity: 30 },
  ],
  status: 'active',
  createdAt: '2026-07-20T10:00:00.000Z',
}

const WH_MAINTENANCE: Record<string, unknown> = {
  ...WH,
  id: 'wh_2',
  name: 'Arusha Depot',
  cityId: 'city_arusha',
  address: undefined,
  lat: null,
  lon: null,
  servingCities: undefined,
  stock: undefined,
  status: 'maintenance',
}

const WH_FULL: Record<string, unknown> = {
  ...WH,
  id: 'wh_3',
  name: 'Mwanza Store',
  cityId: 'city_mwanza',
  stock: [],
  servingCities: [],
  status: 'full',
}

function seedList(rows: Array<Record<string, unknown>>) {
  server.use(http.get('/warehouses', () => HttpResponse.json(rows)))
}

describe('WarehousesPage', () => {
  beforeEach(() => {
    server.use(
      http.get('/warehouses/:warehouseId', ({ params }) =>
        HttpResponse.json({
          ...WH,
          id: String(params.warehouseId),
          stock: [{ catalogueItemId: 'item_a', quantity: 100 }],
        }),
      ),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads and renders warehouse rows with stock sums and metadata', async () => {
    seedList([{ ...WH }, { ...WH_MAINTENANCE }])
    render(<WarehousesPage />)

    expect(await screen.findByText('Dar Hub')).toBeInTheDocument()
    expect(screen.getByText('Arusha Depot')).toBeInTheDocument()
    expect(screen.getAllByText('city_dar')).toHaveLength(2)
    expect(screen.getByText('Plot 12, Kariakoo')).toBeInTheDocument()
    expect(screen.getByText('150')).toBeInTheDocument()
    expect(screen.getByText('city_morogoro')).toBeInTheDocument()
    expect(screen.getAllByText('active')).toHaveLength(2)
    expect(screen.getAllByText('maintenance')).toHaveLength(2)
    expect(screen.getAllByText(toLocal(String(WH.createdAt)))).toHaveLength(2)
  })

  it('filters rows by status chip and free-text name search', async () => {
    seedList([{ ...WH }, { ...WH_MAINTENANCE }, { ...WH_FULL }])
    render(<WarehousesPage />)
    await screen.findByText('Dar Hub')

    fireEvent.click(screen.getByRole('button', { name: /full/i }))
    await waitFor(() => expect(screen.queryByText('Dar Hub')).not.toBeInTheDocument())
    expect(screen.getByText('Mwanza Store')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^all/i }))
    await waitFor(() => expect(screen.getByText('Dar Hub')).toBeInTheDocument())

    const input = screen.getByLabelText('Search warehouses')
    fireEvent.change(input, { target: { value: 'dar' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(screen.queryByText('Mwanza Store')).not.toBeInTheDocument())
    expect(screen.getByText('Dar Hub')).toBeInTheDocument()
  })

  it('shows an empty state when there are no warehouses', async () => {
    seedList([])
    render(<WarehousesPage />)
    expect(await screen.findByText('No warehouses')).toBeInTheDocument()
  })

  it('shows an error state and recovers via retry', async () => {
    server.use(http.get('/warehouses', () => HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 })))
    render(<WarehousesPage />)
    expect(await screen.findByText('Failed to load warehouses')).toBeInTheDocument()

    seedList([{ ...WH }])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Dar Hub')).toBeInTheDocument()
  })

  it('creates a warehouse, shows a toast and refetches the list', async () => {
    let postedName = ''
    const rows: Array<Record<string, unknown>> = [{ ...WH }]
    server.use(
      http.get('/warehouses', () => HttpResponse.json(rows)),
      http.post('/warehouses', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        postedName = String(body.name)
        const created = { ...WH, id: 'wh_9', name: postedName, cityId: String(body.cityId) }
        rows.push(created)
        return HttpResponse.json(created, { status: 201 })
      }),
    )
    render(<WarehousesPage />)
    await screen.findByText('Dar Hub')

    fireEvent.click(screen.getByRole('button', { name: 'New warehouse' }))
    const modal = await screen.findByRole('dialog', { name: 'New warehouse' })
    fireEvent.change(within(modal).getByLabelText('Name'), { target: { value: 'Kigoma Hub' } })
    fireEvent.change(within(modal).getByLabelText('City ID'), { target: { value: 'city_kigoma' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Create warehouse' }))

    await waitFor(() => expect(postedName).toBe('Kigoma Hub'))
    expect(await screen.findByText('Warehouse created')).toBeInTheDocument()
    expect(await screen.findByText('Kigoma Hub')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens the drawer, loads stock, and adjusts stock with a toast and refetch', async () => {
    const detail: Record<string, unknown> = {
      ...WH,
      stock: [{ catalogueItemId: 'item_a', quantity: 120 }],
    }
    const list: Array<Record<string, unknown>> = [{ ...WH }]
    server.use(
      http.get('/warehouses', () => HttpResponse.json(list)),
      http.get('/warehouses/wh_1', () => HttpResponse.json(detail)),
      http.put('/warehouses/wh_1/stock', async ({ request }) => {
        const body = (await request.json()) as { items: Array<{ catalogueItemId: string; delta: number }> }
        detail.stock = body.items.map((i) => ({ catalogueItemId: i.catalogueItemId, quantity: i.delta }))
        return HttpResponse.json(detail)
      }),
    )
    render(<WarehousesPage />)
    await screen.findByText('Dar Hub')

    fireEvent.click(screen.getByText('Dar Hub'))
    await screen.findByRole('dialog', { name: 'Dar Hub' })
    expect(await screen.findByText('item_a')).toBeInTheDocument()
    expect(screen.getByText('120')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Adjust stock' }))
    const modal = await screen.findByRole('dialog', { name: 'Adjust stock' })
    fireEvent.change(within(modal).getByLabelText('Catalogue item ID'), { target: { value: 'item_b' } })
    fireEvent.change(within(modal).getByLabelText('Quantity'), { target: { value: '25' } })
    fireEvent.change(within(modal).getByLabelText('Reason'), { target: { value: 'Replenished' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Apply adjustment' }))

    expect(await screen.findByText('Stock adjusted')).toBeInTheDocument()
    expect(await screen.findByText('item_b')).toBeInTheDocument()
    expect(screen.getByText('25')).toBeInTheDocument()
    expect(screen.queryByText('120')).not.toBeInTheDocument()
  })

  it('shows an inline error when creating a warehouse is forbidden', async () => {
    seedList([{ ...WH }])
    server.use(
      http.post('/warehouses', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<WarehousesPage />)
    await screen.findByText('Dar Hub')

    fireEvent.click(screen.getByRole('button', { name: 'New warehouse' }))
    const modal = await screen.findByRole('dialog', { name: 'New warehouse' })
    fireEvent.change(within(modal).getByLabelText('Name'), { target: { value: 'Kigoma Hub' } })
    fireEvent.change(within(modal).getByLabelText('City ID'), { target: { value: 'city_kigoma' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Create warehouse' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'New warehouse' })).toBeInTheDocument()
    expect(screen.queryByText('Warehouse created')).not.toBeInTheDocument()
  })

  it('shows the empty stock state when the warehouse detail is not found', async () => {
    seedList([{ ...WH }])
    server.use(
      http.get('/warehouses/wh_1', () =>
        HttpResponse.json({ code: 'WAREHOUSE_NOT_FOUND', message: 'gone' }, { status: 404 }),
      ),
    )
    render(<WarehousesPage />)
    await screen.findByText('Dar Hub')

    fireEvent.click(screen.getByText('Dar Hub'))
    expect(await screen.findByText('No stock recorded')).toBeInTheDocument()
  })

  it('sorts rows by stock units via the column header', async () => {
    seedList([
      { ...WH },
      { ...WH_MAINTENANCE },
      { ...WH, id: 'wh_4', name: 'Tanga Yard', stock: [{ catalogueItemId: 'item_a', quantity: 60 }] },
    ])
    render(<WarehousesPage />)
    await screen.findByText('Dar Hub')

    fireEvent.click(screen.getByRole('button', { name: /Stock units/ }))

    const table = screen.getByRole('table', { name: 'Warehouses' })
    const names = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(names).toEqual(['Tanga Yard', 'Dar Hub', 'Arusha Depot'])

    fireEvent.click(screen.getByRole('button', { name: /Stock units/ }))
    const desc = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(desc).toEqual(['Dar Hub', 'Tanga Yard', 'Arusha Depot'])
  })

  it('exports warehouses as CSV via the DataTable', async () => {
    seedList([{ ...WH }])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let downloadName = ''
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadName = this.download
      })
    render(<WarehousesPage />)
    await screen.findByText('Dar Hub')

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(downloadName).toBe('warehouses.csv')
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Name,City,Address,Status,Stock units,Serving cities,Created')
    expect(csv).toContain('Dar Hub')
    expect(csv).toContain('150')
    expect(revokeObjectURL).toHaveBeenCalled()
  })

  it('lists stock-low items in the monitor with tone tags by quantity', async () => {
    seedList([{ ...WH }])
    server.use(
      http.get('/warehouses/wh_1', () =>
        HttpResponse.json({
          ...WH,
          stock: [
            { catalogueItemId: 'item_x', quantity: 0 },
            { catalogueItemId: 'item_y', quantity: 3 },
            { catalogueItemId: 'item_z', quantity: 50 },
          ],
        }),
      ),
    )
    render(<WarehousesPage />)
    await screen.findByRole('table', { name: 'Warehouses' })

    const monitor = within(await screen.findByRole('table', { name: 'Stock-low monitor' }))
    expect(monitor.getByText('item_x')).toBeInTheDocument()
    expect(monitor.getAllByText('Dar Hub')).toHaveLength(2)
    expect(monitor.getByText('0').className).toContain('bad')
    expect(monitor.getByText('3').className).toContain('warn')
    expect(monitor.queryByText('item_z')).not.toBeInTheDocument()
  })

  it('shows the empty stock-low state when nothing is below threshold', async () => {
    seedList([{ ...WH }])
    render(<WarehousesPage />)
    await screen.findByText('Dar Hub')

    expect(await screen.findByText('No stock-low items')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Stock-low alerts trigger warehouse.stock_low; bulk inbound replenishes via the stock adjust flow.',
      ),
    ).toBeInTheDocument()
  })

  it('skips warehouses whose detail is not found instead of crashing', async () => {
    seedList([{ ...WH }, { ...WH_MAINTENANCE }])
    server.use(
      http.get('/warehouses/wh_1', () =>
        HttpResponse.json({ code: 'WAREHOUSE_NOT_FOUND', message: 'gone' }, { status: 404 }),
      ),
      http.get('/warehouses/wh_2', () =>
        HttpResponse.json({ ...WH_MAINTENANCE, stock: [{ catalogueItemId: 'item_y', quantity: 2 }] }),
      ),
    )
    render(<WarehousesPage />)
    await screen.findByText('Arusha Depot')

    const monitor = within(await screen.findByRole('table', { name: 'Stock-low monitor' }))
    expect(monitor.getByText('item_y')).toBeInTheDocument()
    expect(monitor.getByText('Arusha Depot')).toBeInTheDocument()
    expect(monitor.queryByText('Dar Hub')).not.toBeInTheDocument()
    expect(screen.queryByText('No stock-low items')).not.toBeInTheDocument()
  })
})
