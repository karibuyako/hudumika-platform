import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import type { City, Facility, HeatmapZone, Vehicle } from '@hudumika/contract'
import { server } from '../../test/setup'
import { fitViewBox, parseCoord, project, type XY, MapPage } from './MapPage'

const zone = (over: Partial<HeatmapZone> = {}): HeatmapZone => ({
  zoneId: 'zone_1',
  name: 'Kariakoo core',
  polygon: ['39.25,-6.81', '39.26,-6.81', '39.26,-6.82', '39.25,-6.82'],
  demandLevel: 'high',
  surgeMultiplier: 1.4,
  activeOrders: 12,
  activeRiders: 8,
  ...over,
})

const facility = (over: Partial<Facility> = {}): Facility => ({
  id: 'fac_1',
  name: 'Posta Central',
  address: 'Sokoine Drive, Dar es Salaam',
  geofence: ['39.285,-6.818', '39.29,-6.818', '39.29,-6.823', '39.285,-6.823'],
  whitelistRiderIds: ['rdr_1', 'rdr_2'],
  accessPolicy: 'whitelist_only',
  ...over,
})

const city = (over: Partial<City> = {}): City => ({
  id: 'city_1',
  name: 'Dar es Salaam',
  country: 'TZ',
  serviceAreas: [
    { id: 'sa_1', name: 'CBD', polygon: ['39.2,-6.8', '39.3,-6.8', '39.3,-6.9', '39.2,-6.9'] },
  ],
  ...over,
})

const vehicle = (over: Partial<Vehicle> = {}): Vehicle => ({
  id: 'veh_1',
  vehicleType: 'motorcycle',
  registration: 'T 123 ABC',
  status: 'on_trip',
  currentLocation: { lat: -6.812, lon: 39.27, updatedAt: new Date().toISOString() },
  ...over,
})

function seed(zones: HeatmapZone[], facilities: Facility[], cities: City[], vehicles: Vehicle[]) {
  server.use(
    http.get('/dispatch/heatmap', () => HttpResponse.json(zones)),
    http.get('/facilities', () => HttpResponse.json(facilities)),
    http.get('/cities', () => HttpResponse.json(cities)),
    http.get('/vehicles', () => HttpResponse.json(vehicles)),
  )
}

function renderPage() {
  return render(
    <MemoryRouter>
      <MapPage />
    </MemoryRouter>,
  )
}

function clickShape(name: string, tag: 'polygon' | 'circle') {
  fireEvent.click(screen.getByText(name).closest(tag) as SVGElement)
}

function panelFor(name: string) {
  return screen.getByRole('heading', { name }).closest('.state-card') as HTMLElement
}

describe('MapPage', () => {
  it('renders heatmap zones from dispatch geodata with titles', async () => {
    seed([zone()], [facility()], [city()], [vehicle()])
    renderPage()

    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
    expect(await screen.findByText('Kariakoo core')).toBeInTheDocument()
    expect(screen.getByText('Posta Central')).toBeInTheDocument()
    expect(screen.getByText('CBD')).toBeInTheDocument()
    expect(screen.getByText('veh_1')).toBeInTheDocument()
    expect(screen.getByLabelText('Coverage map').querySelectorAll('polygon').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByRole('button', { name: /Heatmap zones/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('hides and restores layers via the toggle chips', async () => {
    seed([zone()], [facility()], [city()], [vehicle()])
    renderPage()
    await screen.findByText('Kariakoo core')

    fireEvent.click(screen.getByRole('button', { name: /Heatmap zones/ }))
    expect(screen.queryByText('Kariakoo core')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Heatmap zones/ })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByRole('button', { name: /Facilities/ }))
    expect(screen.queryByText('Posta Central')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Heatmap zones/ }))
    expect(await screen.findByText('Kariakoo core')).toBeInTheDocument()
  })

  it('shows the zone detail panel with demand metrics on click', async () => {
    seed([zone()], [facility()], [city()], [vehicle()])
    renderPage()
    await screen.findByText('Kariakoo core')

    clickShape('Kariakoo core', 'polygon')

    const panel = panelFor('Kariakoo core')
    expect(within(panel).getByText('high')).toBeInTheDocument()
    expect(within(panel).getByText('1.4')).toBeInTheDocument()
    expect(within(panel).getByText('12')).toBeInTheDocument()
    expect(within(panel).getByText('8')).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'Open dispatch monitor' })).toHaveAttribute(
      'href',
      '/operations/dispatch-monitor',
    )
  })

  it('shows the facility detail panel with its deep link on click', async () => {
    seed([zone()], [facility()], [city()], [vehicle()])
    renderPage()
    await screen.findByText('Kariakoo core')

    clickShape('Posta Central', 'circle')

    const panel = panelFor('Posta Central')
    expect(within(panel).getByText('Sokoine Drive, Dar es Salaam')).toBeInTheDocument()
    expect(within(panel).getByText('whitelist_only')).toBeInTheDocument()
    expect(within(panel).getByText('2')).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'Open facility' })).toHaveAttribute('href', '/facilities')
  })

  it('shows the empty state when every endpoint returns no data', async () => {
    seed([], [], [], [])
    renderPage()
    expect(await screen.findByText('No map data')).toBeInTheDocument()
    expect(screen.getByText('Coverage Map')).toBeInTheDocument()
  })

  it('shows an error state and recovers on retry', async () => {
    let calls = 0
    server.use(
      http.get('/dispatch/heatmap', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'SERVICE_DOWN', message: 'heatmap down', requestId: 'req_1' }, { status: 500 })
        }
        return HttpResponse.json([zone()])
      }),
      http.get('/facilities', () => HttpResponse.json([facility()])),
      http.get('/cities', () => HttpResponse.json([city()])),
      http.get('/vehicles', () => HttpResponse.json([vehicle()])),
    )
    renderPage()

    expect(await screen.findByText('Coverage map unavailable')).toBeInTheDocument()
    expect(screen.getByText('heatmap down')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Kariakoo core')).toBeInTheDocument()
    expect(screen.queryByText('Coverage map unavailable')).not.toBeInTheDocument()
  })
})

describe('map helpers', () => {
  it('parses contract lon,lat strings as x then y', () => {
    expect(parseCoord('39.25,-6.81')).toEqual({ x: 39.25, y: -6.81 })
    expect(parseCoord('-6.81,39.25')).toEqual({ x: -6.81, y: 39.25 })
  })

  it('normalizes coordinates into the viewBox with 5% padding', () => {
    const coords: XY[] = [
      { x: 39.2, y: -6.9 },
      { x: 39.3, y: -6.8 },
      { x: 39.25, y: -6.85 },
    ]
    const fit = fitViewBox(coords, 1000, 700)
    for (const c of coords) {
      const p = project(c, fit)
      expect(p.x).toBeGreaterThanOrEqual(50)
      expect(p.x).toBeLessThanOrEqual(950)
      expect(p.y).toBeGreaterThanOrEqual(35)
      expect(p.y).toBeLessThanOrEqual(665)
    }
  })

  it('centers a single point in the viewBox', () => {
    const fit = fitViewBox([{ x: 39.25, y: -6.81 }], 1000, 700)
    expect(project({ x: 39.25, y: -6.81 }, fit)).toEqual({ x: 500, y: 350 })
  })

  it('returns a degenerate fit for no coordinates', () => {
    expect(fitViewBox([], 1000, 700)).toEqual({ scale: 1, offsetX: 0, offsetY: 0, minX: 0, minY: 0 })
  })
})
