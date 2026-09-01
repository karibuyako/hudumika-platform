import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { GeofencesPage } from './GeofencesPage'
import { server } from '../../test/setup'

const GEOFENCES = [
  { id: 'gf_1', name: 'Hub Zone Dar', type: 'hub_zone', active: true, createdAt: '2026-08-01T10:00:00.000Z' },
  { id: 'gf_2', name: 'Delivery Zone North', type: 'delivery_zone', active: true, createdAt: '2026-08-02T10:00:00.000Z' },
  { id: 'gf_3', name: 'Restricted Area', type: 'restricted_zone', active: false, createdAt: '2026-08-03T10:00:00.000Z' },
]

function seedGeofences(data: typeof GEOFENCES) {
  server.use(http.get('/admin/geofences', () => HttpResponse.json(data)))
}

describe('GeofencesPage', () => {
  it('renders geofences table', async () => {
    seedGeofences(GEOFENCES)
    render(<GeofencesPage />)

    expect(await screen.findByText('Hub Zone Dar')).toBeInTheDocument()
    expect(screen.getByText('Delivery Zone North')).toBeInTheDocument()
    expect(screen.getByText('Restricted Area')).toBeInTheDocument()
    expect(screen.getByText('hub_zone')).toBeInTheDocument()
    expect(screen.getByText('delivery_zone')).toBeInTheDocument()
    expect(screen.getByText('restricted_zone')).toBeInTheDocument()
  })

  it('opens the detail drawer on row click', async () => {
    seedGeofences(GEOFENCES)
    render(<GeofencesPage />)

    const row = await screen.findByText('Hub Zone Dar')
    fireEvent.click(row.closest('tr') as HTMLElement)

    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByText('gf_1')).toBeInTheDocument()
    expect(within(drawer).getByText('hub_zone')).toBeInTheDocument()
    expect(within(drawer).getByText('Yes')).toBeInTheDocument()
    expect(within(drawer).getByText('Close')).toBeInTheDocument()
  })

  it('deletes a geofence from the detail drawer', async () => {
    let deleteId = ''
    let listCalls = 0
    server.use(
      http.get('/admin/geofences', () => {
        listCalls += 1
        return HttpResponse.json(listCalls === 1 ? GEOFENCES : [GEOFENCES[0], GEOFENCES[1]])
      }),
      http.delete('/admin/geofences/:geofenceId', ({ params }) => {
        deleteId = String(params.geofenceId)
        return new HttpResponse(null, { status: 200 })
      }),
    )
    render(<GeofencesPage />)

    const row = await screen.findByText('Restricted Area')
    fireEvent.click(row.closest('tr') as HTMLElement)
    const drawer = await screen.findByRole('dialog')

    window.confirm = () => true
    fireEvent.click(within(drawer).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(deleteId).toBe('gf_3'))
    expect(screen.getByRole('status')).toHaveTextContent('Geofence Restricted Area deleted')
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2))
  })

  it('shows the empty state when there are no geofences', async () => {
    seedGeofences([])
    render(<GeofencesPage />)

    expect(await screen.findByText('No geofences')).toBeInTheDocument()
    expect(screen.getByText(/Create a geofence to define zones/)).toBeInTheDocument()
  })

  it('shows an error and recovers via Retry', async () => {
    server.use(
      http.get('/admin/geofences', () =>
        HttpResponse.json({ code: 'INTERNAL', message: 'geofence service down', requestId: 'req_err' }, { status: 500 }),
      ),
    )
    render(<GeofencesPage />)

    expect(await screen.findByText('Failed to load geofences')).toBeInTheDocument()
    expect(screen.getByText('geofence service down')).toBeInTheDocument()

    seedGeofences(GEOFENCES)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Hub Zone Dar')).toBeInTheDocument()
  })
})
