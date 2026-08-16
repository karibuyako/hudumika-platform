import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import type { ControlTower, ControlTowerCriticalExceptionsItem, Route } from '@hudumika/contract'
import { server } from '../../test/setup'
import { LogisticsTowerPage } from './LogisticsTowerPage'

const GENERATED_AT = '2026-08-15T10:00:00.000Z'

const exception = (
  over: Partial<ControlTowerCriticalExceptionsItem> = {},
): ControlTowerCriticalExceptionsItem => ({
  shipmentId: 'shp_1',
  type: 'wrong_hub_scan',
  detail: 'Scanned at Arusha hub, expected Dar es Salaam',
  ...over,
})

function seed(over: Partial<ControlTower> = {}) {
  server.use(
    http.get('/admin/logistics/control-tower', () =>
      HttpResponse.json<ControlTower>({
        generatedAt: GENERATED_AT,
        totals: {
          activeShipments: 42,
          delayed: 3,
          exceptions: 2,
          atRisk: 5,
          activeTrips: 12,
          tripsByHub: [
            { hubName: 'Dar es Salaam', trips: 8 },
            { hubName: 'Arusha', trips: 4 },
          ],
        },
        criticalExceptions: [exception()],
        ...over,
      }),
    ),
    http.get('/routes', () => HttpResponse.json<Route[]>([])),
  )
}

function renderPage() {
  return render(
    <MemoryRouter>
      <LogisticsTowerPage />
    </MemoryRouter>,
  )
}

function section(name: string) {
  return within(screen.getByRole('heading', { name }).closest('section')!)
}

describe('LogisticsTowerPage', () => {
  it('loads and renders totals, trips table, and exception queue', async () => {
    seed()
    renderPage()
    expect(screen.getByLabelText('Loading')).toBeInTheDocument()

    expect(await screen.findByRole('heading', { name: 'Logistics Control Tower' })).toBeInTheDocument()
    expect(screen.getByText('Active shipments')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('Delayed')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('Exceptions')).toBeInTheDocument()
    expect(screen.getByText('At risk')).toBeInTheDocument()
    expect(screen.getByText('Active trips')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(section('Trips by hub').getByText('Dar es Salaam')).toBeInTheDocument()
    expect(section('Critical exceptions').getByText('wrong hub scan')).toBeInTheDocument()
  })

  it('renders a snapshot label with the local generated-at time', async () => {
    seed()
    renderPage()
    expect(await screen.findByText(/^Snapshot /)).toBeInTheDocument()
  })

  it('renders critical exception rows with type, detail, and an open-shipment link', async () => {
    seed({
      criticalExceptions: [
        exception({ shipmentId: 'shp_1001', type: 'seal_broken', detail: 'Seal tampered at hub' }),
        exception({ shipmentId: 'shp_1002', type: 'rider_no_show', detail: null }),
      ],
    })
    renderPage()

    const sealed = (await screen.findByText('shp_1001')).closest('a') as HTMLElement
    expect(sealed).toHaveAttribute('href', '/logistics/shipments')
    expect(within(sealed).getByText('seal broken')).toBeInTheDocument()
    expect(within(sealed).getByText('Seal tampered at hub')).toBeInTheDocument()
    expect(within(sealed).getByText('Open shipment →')).toBeInTheDocument()

    const noShow = screen.getByText('shp_1002').closest('a') as HTMLElement
    expect(within(noShow).getByText('rider no show')).toBeInTheDocument()
    expect(within(noShow).getByText('—')).toBeInTheDocument()
  })

  it('renders the trips-by-hub table with depth bars scaled to the busiest hub', async () => {
    seed({ totals: { activeTrips: 6, tripsByHub: [{ hubName: 'Dodoma', trips: 4 }, { hubName: 'Tanga', trips: 2 }] } })
    renderPage()

    expect(await screen.findByText('Dodoma')).toBeInTheDocument()
    const dodoma = screen.getByText('Dodoma').closest('tr') as HTMLElement
    const tanga = screen.getByText('Tanga').closest('tr') as HTMLElement
    expect(dodoma.querySelector('.bar-fill')).toHaveStyle({ width: '100%' })
    expect(tanga.querySelector('.bar-fill')).toHaveStyle({ width: '50%' })
    expect(within(dodoma).getByText('4')).toBeInTheDocument()
    expect(within(tanga).getByText('2')).toBeInTheDocument()
  })

  it('shows an empty state when totals are missing', async () => {
    seed({ totals: undefined })
    renderPage()

    expect(await screen.findByText('Logistics tower unavailable')).toBeInTheDocument()
  })

  it('renders the corridors table with route details', async () => {
    server.use(
      http.get('/routes', () =>
        HttpResponse.json<Route[]>([
          {
            id: 'r_1',
            name: 'Dar es Salaam → Arusha',
            fromHubId: 'hub_dar',
            toHubId: 'hub_ar',
            estimatedHours: 8,
            scheduledDepartures: ['06:00', '14:00'],
            permittedVehicles: ['van', 'linehaul_truck'],
            active: true,
          },
          {
            id: 'r_2',
            name: 'Arusha → Dodoma',
            fromHubId: 'hub_ar',
            toHubId: 'hub_dod',
            active: false,
          },
        ]),
      ),
    )
    renderPage()

    const first = (await screen.findByText('Dar es Salaam → Arusha')).closest('tr') as HTMLElement
    expect(within(first).getByText('hub_dar → hub_ar')).toBeInTheDocument()
    expect(within(first).getByText('8')).toBeInTheDocument()
    expect(within(first).getByText('2')).toBeInTheDocument()
    expect(within(first).getByText('van')).toBeInTheDocument()
    expect(within(first).getByText('linehaul_truck')).toBeInTheDocument()
    expect(within(first).getByText('active')).toBeInTheDocument()

    const second = screen.getByText('Arusha → Dodoma').closest('tr') as HTMLElement
    expect(within(second).getByText('hub_ar → hub_dod')).toBeInTheDocument()
    expect(within(second).getAllByText('—')).toHaveLength(3)
    expect(within(second).getByText('inactive')).toBeInTheDocument()
  })

  it('shows an empty state for the corridors section when no routes exist', async () => {
    seed()
    renderPage()

    expect(await screen.findByText('No routes')).toBeInTheDocument()
    expect(screen.getByText('Corridor map view ships with the backend map milestone.')).toBeInTheDocument()
  })

  it('shows an error state and recovers on retry', async () => {
    let calls = 0
    server.use(
      http.get('/admin/logistics/control-tower', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json(
            { code: 'SERVICE_DOWN', message: 'tower down', requestId: 'req_1' },
            { status: 500 },
          )
        }
        return HttpResponse.json<ControlTower>({
          generatedAt: GENERATED_AT,
          totals: { activeShipments: 7 },
          criticalExceptions: [],
        })
      }),
    )
    renderPage()

    expect(await screen.findByText('Logistics tower unavailable')).toBeInTheDocument()
    expect(screen.getByText('tower down')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('heading', { name: 'Logistics Control Tower' })).toBeInTheDocument()
    expect(screen.queryByText('Logistics tower unavailable')).not.toBeInTheDocument()
  })
})
