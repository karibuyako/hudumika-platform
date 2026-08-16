import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { getGetShipmentCustodyUrl } from '@hudumika/contract'
import { SearchPage } from './SearchPage'
import { server } from '../../test/setup'

const ORDER_ITEM = {
  entityType: 'order',
  id: 'ORD-1',
  label: 'Order ORD-1',
  status: 'paid',
  region: 'Dar es Salaam',
  updatedAt: '2026-08-15T10:00:00Z',
}

const SHIPMENT_ITEM = {
  entityType: 'shipment',
  id: 'SHP-1',
  label: 'Shipment SHP-1',
  status: null,
  region: null,
  updatedAt: null,
}

function renderSearch(initialEntry = '/search?q=ORD-1') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SearchPage />
    </MemoryRouter>,
  )
}

describe('SearchPage', () => {
  it('renders results for a seeded query', async () => {
    server.use(
      http.get('/admin/search', () => HttpResponse.json([ORDER_ITEM, SHIPMENT_ITEM])),
    )
    renderSearch()

    expect(await screen.findByText('Order ORD-1')).toBeInTheDocument()
    expect(screen.getByText('Shipment SHP-1')).toBeInTheDocument()
    expect(screen.getByText('ORD-1')).toBeInTheDocument()
    expect(screen.getByText('SHP-1')).toBeInTheDocument()
    expect(screen.getByText('paid')).toBeInTheDocument()
  })

  it('shows the empty state when nothing matches', async () => {
    server.use(http.get('/admin/search', () => HttpResponse.json([])))
    renderSearch()

    expect(await screen.findByText('No matches')).toBeInTheDocument()
    expect(screen.getByText(/ORD- for orders/)).toBeInTheDocument()
  })

  it('shows a full error state and recovers on retry', async () => {
    let fail = true
    server.use(
      http.get('/admin/search', () => {
        if (fail) return HttpResponse.json({ code: 'INTERNAL', message: 'search backend down' }, { status: 500 })
        return HttpResponse.json([ORDER_ITEM])
      }),
    )
    renderSearch()

    expect(await screen.findByRole('alert')).toHaveTextContent('INTERNAL: search backend down')
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Order ORD-1')).toBeInTheDocument()
  })

  it('renders ADMIN_SEARCH_INVALID inline while the search form stays', async () => {
    server.use(
      http.get('/admin/search', () =>
        HttpResponse.json({ code: 'ADMIN_SEARCH_INVALID', message: 'Query too short' }, { status: 422 }),
      ),
    )
    renderSearch()

    expect(await screen.findByText('ADMIN_SEARCH_INVALID: Query too short')).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument()
    expect(screen.queryByText(/Failed to search/)).not.toBeInTheDocument()
  })

  it('refetches with the exploded entityTypes param when a type chip is selected', async () => {
    const urls: string[] = []
    server.use(
      http.get('/admin/search', ({ request }) => {
        urls.push(request.url)
        return HttpResponse.json([])
      }),
    )
    renderSearch()
    await screen.findByText('No matches')

    fireEvent.click(screen.getByRole('button', { name: 'order' }))

    await waitFor(() =>
      expect(urls.some((u) => new URL(u).searchParams.getAll('entityTypes').includes('order'))).toBe(true),
    )
    expect(screen.getByRole('button', { name: 'order' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('opens the entity drawer on row click with a deep link to the owning module', async () => {
    server.use(http.get('/admin/search', () => HttpResponse.json([ORDER_ITEM])))
    renderSearch()

    fireEvent.click(await screen.findByText('Order ORD-1'))

    const drawer = await screen.findByRole('dialog', { name: 'Order ORD-1' })
    expect(within(drawer).getByText('ORD-1')).toBeInTheDocument()
    expect(within(drawer).getByRole('link', { name: 'Open in Orders' })).toHaveAttribute('href', '/commerce/orders')
  })

  it('submits a new query and round-trips it through the URL', async () => {
    const urls: string[] = []
    server.use(
      http.get('/admin/search', ({ request }) => {
        urls.push(request.url)
        return HttpResponse.json([])
      }),
    )
    function LocationProbe() {
      const location = useLocation()
      return <div data-testid="location">{location.pathname + location.search}</div>
    }
    render(
      <MemoryRouter initialEntries={['/search?q=ORD-1']}>
        <SearchPage />
        <LocationProbe />
      </MemoryRouter>,
    )
    await screen.findByText('No matches')

    fireEvent.change(screen.getByRole('searchbox', { name: /search/i }), { target: { value: 'CUS-42' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => expect(urls.some((u) => u.includes('q=CUS-42'))).toBe(true))
    expect(screen.getByTestId('location')).toHaveTextContent('q=CUS-42')
  })

  it('loads the order detail section into the drawer when an order row is clicked', async () => {
    const order = {
      id: 'ORD-1',
      no: 'ORD-1001',
      status: 'paid',
      merchantId: 'mrc_9',
      riderId: 'rdr_3',
      deliveryAddress: {
        label: 'Sanaa House',
        lines: 'Samora Ave, Dar es Salaam',
        landmark: 'Near the clock tower',
        contactPhone: '+255 700 000 000',
      },
      totals: { subtotalTZS: 8000, deliveryFeeTZS: 2000, platformFeeTZS: 500, taxTZS: 500, discountTZS: 0, totalTZS: 11000 },
      items: [{ catalogueItemId: 'cat_1', name: 'Mangoes', quantity: 2, unitPriceTZS: 4000 }],
      events: [
        { status: 'paid', at: '2026-08-15T09:00:00Z', by: 'system' },
        { status: 'delivered', at: '2026-08-15T12:00:00Z', by: 'rider' },
      ],
      createdAt: '2026-08-15T08:00:00Z',
    }
    server.use(
      http.get('/admin/search', () => HttpResponse.json([ORDER_ITEM])),
      http.get('/admin/orders', () => HttpResponse.json([order])),
    )
    renderSearch()

    fireEvent.click(await screen.findByText('Order ORD-1'))

    expect(await screen.findByText('delivered')).toBeInTheDocument()
    expect(screen.getByText('Sanaa House')).toBeInTheDocument()
    expect(screen.getByText('TZS 11,000')).toBeInTheDocument()
    expect(screen.getByText('1 item')).toBeInTheDocument()
  })

  it('loads the custody scans into the drawer when a shipment row is clicked', async () => {
    const shipment = {
      id: 'shp-1',
      shipmentNumber: 'SHP-1001',
      orderId: 'ord_1',
      status: 'in_transit',
      createdAt: '2026-08-10T10:00:00.000Z',
    }
    const custody = [
      {
        id: 'cust_1',
        shipmentId: 'shp-1',
        packageId: null,
        eventType: 'handoff',
        actorId: 'usr_1',
        actorType: 'hub_worker',
        deviceId: 'dev_7',
        previousState: 'picked_up',
        newState: 'at_hub',
        evidence: 'seal intact',
        at: '2026-08-10T12:00:00.000Z',
        lat: null,
        lon: null,
        locationId: null,
        vehicleId: null,
        hubId: null,
      },
    ]
    server.use(
      http.get('/admin/search', () => HttpResponse.json([SHIPMENT_ITEM])),
      http.get('*/shipments', () => HttpResponse.json([shipment])),
      http.get('*' + getGetShipmentCustodyUrl('shp-1'), () => HttpResponse.json(custody)),
    )
    renderSearch('/search?q=SHP-1')

    fireEvent.click(await screen.findByText('Shipment SHP-1'))

    expect(await screen.findByText('handoff')).toBeInTheDocument()
    expect(screen.getByText(/hub_worker · usr_1 · device dev_7/)).toBeInTheDocument()
    expect(screen.getByText('picked_up → at_hub')).toBeInTheDocument()
    expect(screen.getByText('seal intact')).toBeInTheDocument()
  })

  it('shows the muted note for entity types without a details adapter', async () => {
    server.use(
      http.get('/admin/search', () =>
        HttpResponse.json([
          { entityType: 'hub', id: 'HUB-1', label: 'Hub HUB-1', status: 'live', region: 'Dar es Salaam', updatedAt: '2026-08-15T10:00:00Z' },
        ]),
      ),
    )
    renderSearch('/search?q=HUB-1')

    fireEvent.click(await screen.findByText('Hub HUB-1'))

    expect(await screen.findByText('Full timelines, scans, and audit history live in the owning module.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open audit trail' })).toHaveAttribute('href', '/audit/logs')
  })

  it('shows a muted detail error for the entity section and recovers on retry', async () => {
    const order = {
      id: 'ORD-1',
      no: 'ORD-1001',
      status: 'paid',
      merchantId: 'mrc_9',
      deliveryAddress: {
        label: 'Sanaa House',
        lines: 'Samora Ave, Dar es Salaam',
        contactPhone: '+255 700 000 000',
      },
      totals: { subtotalTZS: 8000, deliveryFeeTZS: 2000, platformFeeTZS: 500, taxTZS: 500, discountTZS: 0, totalTZS: 11000 },
      events: [{ status: 'paid', at: '2026-08-15T09:00:00Z', by: 'system' }],
      createdAt: '2026-08-15T08:00:00Z',
    }
    let fail = true
    server.use(
      http.get('/admin/search', () => HttpResponse.json([ORDER_ITEM])),
      http.get('/admin/orders', () => {
        if (fail) return HttpResponse.json({ code: 'INTERNAL', message: 'orders backend down' }, { status: 500 })
        return HttpResponse.json([order])
      }),
    )
    renderSearch()

    fireEvent.click(await screen.findByText('Order ORD-1'))

    expect(await screen.findByText('Detail unavailable')).toBeInTheDocument()
    expect(screen.queryByText('Sanaa House')).not.toBeInTheDocument()

    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Sanaa House')).toBeInTheDocument()
  })
})
