import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'
import { HubDashboardPage } from './HubDashboardPage'
import { server } from '../../test/setup'

const DASH = {
  hubId: 'hub_1',
  name: 'Kinondoni Hub',
  load: { incoming: 47, outgoing: 31, awaitingSort: 0, exceptions: 0, capacityPct: 64 },
  sortationQueues: [{ zone: 'North', count: 8 }],
  staffOnDuty: 9,
  vehiclesPresent: 5,
  updatedAt: '2026-08-15T10:00:00.000Z',
}

async function loadHub(hubId = 'hub_1') {
  await userEvent.type(screen.getByLabelText('Hub ID'), hubId)
  await userEvent.click(screen.getByRole('button', { name: 'Load dashboard' }))
}

describe('HubDashboardPage', () => {
  it('loads and renders the dashboard for the requested hub', async () => {
    server.use(http.get('/admin/hubs/hub_1/dashboard', () => HttpResponse.json(DASH)))
    render(<HubDashboardPage />)

    expect(screen.getByText('Enter a hub ID to load its dashboard.')).toBeInTheDocument()
    await loadHub()

    expect(await screen.findByText('Incoming')).toBeInTheDocument()
    expect(screen.getByText('Outgoing')).toBeInTheDocument()
    expect(screen.getByText('Awaiting sort')).toBeInTheDocument()
    expect(screen.getByText('Exceptions')).toBeInTheDocument()
    expect(screen.getByText('64%')).toBeInTheDocument()
    expect(screen.getByText(/^Updated /)).toBeInTheDocument()
    expect(screen.getByText('North')).toBeInTheDocument()
    expect(screen.getByText('9')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(document.querySelector('.bar-fill')).not.toHaveClass('warn')
    expect(document.querySelector('.bar-fill')).not.toHaveClass('bad')
  })

  it('links to the hubs page when capacity exceeds 100%', async () => {
    server.use(
      http.get('/admin/hubs/hub_1/dashboard', () =>
        HttpResponse.json({ ...DASH, load: { ...DASH.load, capacityPct: 112 } }),
      ),
    )
    render(
      <MemoryRouter>
        <HubDashboardPage />
      </MemoryRouter>,
    )
    await loadHub()

    const link = await screen.findByRole('link', { name: 'Capacity warning — open hubs' })
    expect(link).toHaveAttribute('href', '/operations/hubs')
  })

  it('shows an empty state for an unknown hub', async () => {
    server.use(
      http.get('/admin/hubs/hub_1/dashboard', () =>
        HttpResponse.json({ code: 'NOT_FOUND', message: 'missing' }, { status: 404 }),
      ),
    )
    render(<HubDashboardPage />)
    await loadHub()

    expect(await screen.findByText('Hub not found')).toBeInTheDocument()
  })

  it('shows an error state and recovers on retry', async () => {
    server.use(
      http.get('/admin/hubs/hub_1/dashboard', () =>
        HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 }),
      ),
    )
    render(<HubDashboardPage />)
    await loadHub()

    expect(await screen.findByText('Failed to load hub dashboard')).toBeInTheDocument()

    server.use(http.get('/admin/hubs/hub_1/dashboard', () => HttpResponse.json(DASH)))
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Incoming')).toBeInTheDocument()
  })
})
