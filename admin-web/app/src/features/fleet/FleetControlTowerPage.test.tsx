import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { FleetControlTowerPage } from './FleetControlTowerPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'
import { toLocal } from '../../lib/time'

const OVERVIEW: Record<string, unknown> = {
  generatedAt: '2026-08-15T08:30:00.000Z',
  totals: {
    activeRiders: 142,
    onlineRiders: 97,
    activeOrders: 231,
    inTransit: 88,
    anomalies: 3,
    openSos: 1,
  },
  byFleetType: [
    { fleetType: 'captive', count: 60 },
    { fleetType: 'contracted', count: 45 },
    { fleetType: 'outsourced', count: 25 },
    { fleetType: 'hybrid', count: 12 },
  ],
  hubs: [
    { hubId: 'hub_1', name: 'Dar es Salaam Central', region: 'Dar es Salaam', activeRiders: 80, activeOrders: 120, anomalies: 2 },
    { hubId: 'hub_2', name: 'Mwanza North', region: 'Mwanza', activeRiders: 40, activeOrders: 60, anomalies: 0 },
  ],
}

function seedOverview(overview: Record<string, unknown> = OVERVIEW) {
  server.use(http.get('/admin/fleet/control-tower', () => HttpResponse.json(overview)))
}

function renderPage() {
  return render(
    <MemoryRouter>
      <FleetControlTowerPage />
    </MemoryRouter>,
  )
}

describe('FleetControlTowerPage', () => {
  it('renders loading skeleton then totals, fleet type, and hub tables', async () => {
    seedOverview()
    renderPage()

    expect(await screen.findByText('142')).toBeInTheDocument()
    expect(screen.getByText('97')).toBeInTheDocument()
    expect(screen.getByText('231')).toBeInTheDocument()
    expect(screen.getByText('88')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()

    const fleetTypeTable = screen.getAllByRole('table')[0]
    expect(within(fleetTypeTable).getByText('captive')).toBeInTheDocument()
    expect(within(fleetTypeTable).getByText('60')).toBeInTheDocument()
    expect(within(fleetTypeTable).getByText('hybrid')).toBeInTheDocument()

    expect(screen.getByText('Dar es Salaam Central')).toBeInTheDocument()
    expect(screen.getByText('Mwanza North')).toBeInTheDocument()
    expect(screen.getByText(/REST_ENFORCED/)).toBeInTheDocument()
  })

  it('shows the snapshot label with the local timestamp', async () => {
    seedOverview()
    renderPage()

    expect(await screen.findByText(`Snapshot ${toLocal(String(OVERVIEW.generatedAt))}`)).toBeInTheDocument()
  })

  it('refetches with fleetType=captive when the fleet type filter changes', async () => {
    let lastUrl = ''
    server.use(
      http.get('/admin/fleet/control-tower', ({ request }) => {
        lastUrl = request.url
        return HttpResponse.json(OVERVIEW)
      }),
    )
    renderPage()
    await screen.findByText('142')

    fireEvent.change(screen.getByLabelText('Filter by fleet type'), { target: { value: 'captive' } })

    await waitFor(() => {
      const url = new URL(lastUrl)
      expect(url.searchParams.get('fleetType')).toBe('captive')
    })
    expect(await screen.findByText('142')).toBeInTheDocument()
  })

  it('refetches with hubId=hub_1 when the hub filter changes', async () => {
    let lastUrl = ''
    server.use(
      http.get('/admin/fleet/control-tower', ({ request }) => {
        lastUrl = request.url
        return HttpResponse.json(OVERVIEW)
      }),
    )
    renderPage()
    await screen.findByText('142')

    fireEvent.change(screen.getByLabelText('Filter by hub'), { target: { value: 'hub_1' } })

    await waitFor(() => {
      const url = new URL(lastUrl)
      expect(url.searchParams.get('hubId')).toBe('hub_1')
    })
    expect(await screen.findByText('142')).toBeInTheDocument()
  })

  it('shows the error state on a 5xx and recovers via retry', async () => {
    server.use(
      http.get('/admin/fleet/control-tower', () =>
        HttpResponse.json({ code: 'INTERNAL', message: 'fleet tower down', requestId: 'err_1' }, { status: 500 }),
      ),
    )
    renderPage()

    expect(await screen.findByText('Control tower unavailable')).toBeInTheDocument()
    expect(screen.getByText('fleet tower down')).toBeInTheDocument()
    expect(screen.getByText('err_1')).toBeInTheDocument()

    seedOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('142')).toBeInTheDocument()
  })

  it('shows the empty state when the response lacks totals and recovers via retry', async () => {
    server.use(
      http.get('/admin/fleet/control-tower', () =>
        HttpResponse.json({ generatedAt: '2026-08-15T08:30:00.000Z', hubs: [] }),
      ),
    )
    renderPage()

    expect(await screen.findByText('Fleet tower unavailable')).toBeInTheDocument()

    seedOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('142')).toBeInTheDocument()
  })

  it('renders a danger tone on the anomalies stat card when anomalies > 0', async () => {
    seedOverview()
    renderPage()

    await screen.findByText('3')
    const card = screen.getByText('3').closest('.stat-card')!
    expect(card.className).toContain('danger')
  })

  it('opens a hub drawer with all fields and a deep link to hubs', async () => {
    seedOverview()
    renderPage()

    await screen.findByText('Dar es Salaam Central')
    fireEvent.click(screen.getByText('Dar es Salaam Central'))

    const drawer = await screen.findByRole('dialog', { name: 'Dar es Salaam Central' })
    expect(within(drawer).getByText('hub_1')).toBeInTheDocument()
    expect(within(drawer).getByText('Dar es Salaam')).toBeInTheDocument()
    expect(within(drawer).getByText('80')).toBeInTheDocument()
    expect(within(drawer).getByText('120')).toBeInTheDocument()
    expect(within(drawer).getByText('2')).toBeInTheDocument()
    const link = within(drawer).getByRole('link', { name: 'Open hub' })
    expect(link).toHaveAttribute('href', '/operations/hubs')
  })

  it('gives every hub row a Riders drill-in link to the riders page', async () => {
    seedOverview()
    renderPage()

    await screen.findByText('Dar es Salaam Central')
    const links = screen.getAllByRole('link', { name: 'Riders' })
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/logistics/riders')
    }
  })

  it('shows the safety actions panel when open SOS or anomalies exist', async () => {
    seedOverview()
    renderPage()

    await screen.findByText('Respond to crash')
    expect(screen.getByRole('button', { name: 'Enforce rest' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Relieve rest' })).toBeInTheDocument()
  })

  it('hides the safety panel and shows a muted note when no open safety events exist', async () => {
    seedOverview({
      ...OVERVIEW,
      totals: { ...(OVERVIEW.totals as Record<string, unknown>), anomalies: 0, openSos: 0 },
    })
    renderPage()

    expect(await screen.findByText('No open safety events.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Respond to crash' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Enforce rest' })).not.toBeInTheDocument()
  })

  it('hides the safety panel without safety.respond permission', async () => {
    seedStaffSession({ permissions: ['fleet.read'] })
    seedOverview()
    renderPage()

    await screen.findByText('Dar es Salaam Central')
    expect(screen.queryByRole('button', { name: 'Respond to crash' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Enforce rest' })).not.toBeInTheDocument()
  })

  it('completing a crash response shows the crash_respond pending notice', async () => {
    seedOverview()
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Respond to crash' }))
    const prompt = screen.getByRole('dialog', { name: 'Respond to crash' })
    fireEvent.change(prompt.querySelector('textarea')!, { target: { value: 'Rider confirmed safe' } })
    fireEvent.change(within(prompt).getByLabelText('Outcome'), { target: { value: 'unsafe' } })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('PENDING_ENDPOINT')).toBeInTheDocument()
    expect(screen.getByText(/POST \/admin\/riders\/\{riderId\}\/safety\/crash/)).toBeInTheDocument()
    expect(
      screen.getByText('This action is documented for backend implementation — nothing was sent.'),
    ).toBeInTheDocument()
  })

  it('completing a rest action shows the rest_override pending notice', async () => {
    seedOverview()
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Enforce rest' }))
    const prompt = screen.getByRole('dialog', { name: 'Enforce rest' })
    fireEvent.change(prompt.querySelector('textarea')!, { target: { value: 'Fatigue flagged by telemetry' } })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('PENDING_ENDPOINT')).toBeInTheDocument()
    expect(screen.getByText(/POST \/admin\/riders\/\{riderId\}\/rest/)).toBeInTheDocument()
  })
})
