import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'
import { HubsPage } from './HubsPage'
import { server } from '../../test/setup'

const HUB: Record<string, unknown> = {
  id: 'hub_1',
  name: 'Kinondoni Hub',
  cityId: 'city_dar',
  address: '1 Old Bagamoyo Rd, Dar es Salaam',
  capacity: 800,
  active: true,
}

function seed(hubs: Array<Record<string, unknown>>) {
  server.use(http.get('/hubs', () => HttpResponse.json(hubs)))
}

async function openCreateModal() {
  await userEvent.click(await screen.findByRole('button', { name: 'New hub' }))
}

describe('HubsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows a loading skeleton then renders hub rows', async () => {
    seed([HUB, { ...HUB, id: 'hub_2', name: 'Mwanza Hub', cityId: null, address: null, capacity: null, active: false }])
    render(<HubsPage />)

    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
    expect(await screen.findByText('Kinondoni Hub')).toBeInTheDocument()
    expect(screen.getByText('Mwanza Hub')).toBeInTheDocument()
    expect(screen.getByText('1 Old Bagamoyo Rd, Dar es Salaam')).toBeInTheDocument()
    expect(screen.getByText('active')).toBeInTheDocument()
    expect(screen.getByText('inactive')).toBeInTheDocument()
  })

  it('shows an empty state when there are no hubs', async () => {
    seed([])
    render(<HubsPage />)
    expect(await screen.findByText('No hubs')).toBeInTheDocument()
  })

  it('shows an error state and recovers on retry', async () => {
    server.use(http.get('/hubs', () => HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 })))
    render(<HubsPage />)
    expect(await screen.findByText('Failed to load hubs')).toBeInTheDocument()

    seed([HUB])
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Kinondoni Hub')).toBeInTheDocument()
  })

  it('creates a hub, shows a toast, and refetches the list', async () => {
    const list: Array<Record<string, unknown>> = [{ ...HUB }]
    const posted: Array<Record<string, unknown>> = []
    server.use(
      http.get('/hubs', () => HttpResponse.json(list)),
      http.post('/hubs', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        posted.push(body)
        list.push(body)
        return HttpResponse.json(body, { status: 201 })
      }),
    )
    render(<HubsPage />)
    await screen.findByText('Kinondoni Hub')

    await openCreateModal()
    await userEvent.type(screen.getByLabelText('Name'), 'Arusha Hub')
    await userEvent.type(screen.getByLabelText('City'), 'city_ars')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText('Hub created')).toBeInTheDocument()
    expect(await screen.findByText('Arusha Hub')).toBeInTheDocument()
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ name: 'Arusha Hub', cityId: 'city_ars' })
    expect('active' in posted[0]).toBe(false)
    expect(String(posted[0].id)).toMatch(/^hub_/)
  })

  it('surfaces a 403 inline in the create modal', async () => {
    seed([HUB])
    server.use(
      http.post('/hubs', () =>
        HttpResponse.json({ code: 'HUB_FORBIDDEN', message: 'not authorized' }, { status: 403 }),
      ),
    )
    render(<HubsPage />)
    await screen.findByText('Kinondoni Hub')

    await openCreateModal()
    await userEvent.type(screen.getByLabelText('Name'), 'Arusha Hub')
    await userEvent.type(screen.getByLabelText('City'), 'city_ars')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText('not authorized')).toBeInTheDocument()
    expect(screen.getByText('HUB_FORBIDDEN')).toBeInTheDocument()
    expect(screen.queryByText('Hub created')).not.toBeInTheDocument()
  })

  it('loads the hub dashboard section inside the drawer', async () => {
    server.use(
      http.get('/hubs', () => HttpResponse.json([HUB])),
      http.get('/admin/hubs/hub_1/dashboard', () =>
        HttpResponse.json({
          hubId: 'hub_1',
          name: 'Kinondoni Hub',
          load: { incoming: 47, outgoing: 31, awaitingSort: 12, exceptions: 3, capacityPct: 95 },
          sortationQueues: [
            { zone: 'North', count: 8 },
            { zone: 'South', count: 4 },
          ],
          staffOnDuty: 9,
          vehiclesPresent: 5,
          updatedAt: '2026-08-15T10:00:00.000Z',
        }),
      ),
    )
    render(<HubsPage />)
    await userEvent.click(await screen.findByText('Kinondoni Hub'))

    expect(await screen.findByText('Incoming')).toBeInTheDocument()
    expect(screen.getByText('Outgoing')).toBeInTheDocument()
    expect(screen.getByText('Awaiting sort')).toBeInTheDocument()
    expect(screen.getByText('Exceptions')).toBeInTheDocument()
    expect(screen.getByText('95%')).toBeInTheDocument()
    expect(screen.getByText(/^Updated /)).toBeInTheDocument()
    expect(screen.getByText('North')).toBeInTheDocument()
    expect(screen.getByText('South')).toBeInTheDocument()
    expect(screen.getByText('Staff on duty')).toBeInTheDocument()
    expect(screen.getByText('Vehicles present')).toBeInTheDocument()

    const capacityBar = document.querySelector('.bar-fill')
    expect(capacityBar).toHaveClass('warn')
    expect(document.querySelector('.stat-card.warn')).toBeInTheDocument()
    expect(document.querySelector('.stat-card.danger')).toBeInTheDocument()
  })

  it('marks capacity over 100% as bad', async () => {
    server.use(
      http.get('/hubs', () => HttpResponse.json([HUB])),
      http.get('/admin/hubs/hub_1/dashboard', () =>
        HttpResponse.json({
          hubId: 'hub_1',
          name: 'Kinondoni Hub',
          load: { incoming: 10, outgoing: 10, awaitingSort: 0, exceptions: 0, capacityPct: 130 },
          updatedAt: '2026-08-15T10:00:00.000Z',
        }),
      ),
    )
    render(
      <MemoryRouter>
        <HubsPage />
      </MemoryRouter>,
    )
    await userEvent.click(await screen.findByText('Kinondoni Hub'))

    expect(await screen.findByText('130%')).toBeInTheDocument()
    expect(document.querySelector('.bar-fill')).toHaveClass('bad')
  })

  it('shows an empty state when the hub dashboard is not found', async () => {
    server.use(
      http.get('/hubs', () => HttpResponse.json([HUB])),
      http.get('/admin/hubs/hub_1/dashboard', () =>
        HttpResponse.json({ code: 'NOT_FOUND', message: 'missing' }, { status: 404 }),
      ),
    )
    render(<HubsPage />)
    await userEvent.click(await screen.findByText('Kinondoni Hub'))

    expect(await screen.findByText('Hub not found')).toBeInTheDocument()
  })

  it('sorts rows by capacity via the column header', async () => {
    seed([
      HUB,
      { ...HUB, id: 'hub_2', name: 'Mwanza Hub', cityId: null, address: null, capacity: null, active: false },
      { ...HUB, id: 'hub_3', name: 'Arusha Hub', cityId: null, address: null, capacity: 400, active: true },
    ])
    render(<HubsPage />)
    await screen.findByText('Kinondoni Hub')

    await userEvent.click(screen.getByRole('button', { name: /Capacity/ }))

    const table = screen.getByRole('table', { name: 'Hubs' })
    const names = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(names).toEqual(['Arusha Hub', 'Kinondoni Hub', 'Mwanza Hub'])
  })

  it('exports hubs as CSV via the DataTable', async () => {
    seed([HUB])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let downloadName = ''
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadName = this.download
      })
    render(<HubsPage />)
    await screen.findByText('Kinondoni Hub')

    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(downloadName).toBe('hubs.csv')
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Name,City,Address,Capacity,Status')
    expect(csv).toContain('Kinondoni Hub')
    expect(csv).toContain('city_dar')
    expect(csv).toContain(',800,')
    expect(revokeObjectURL).toHaveBeenCalled()
  })
})
