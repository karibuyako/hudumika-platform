import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { RidersPage } from './RidersPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const RIDER = {
  id: 'rdr_1',
  name: 'Asha Mwakalinga',
  city: 'Dar es Salaam',
  vehicle: 'Bike',
  licensePlate: 'TZA 1234',
  vehicleMake: 'Bajaj',
  vehicleYear: 2020,
  verification: 'approved',
  documents: [
    { type: 'national_id', status: 'approved' },
    { type: 'driving_licence', status: 'pending' },
  ],
  reliabilityScore: 91,
}

function seedRiders(riders: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/riders', () => HttpResponse.json(riders)))
}

describe('RidersPage', () => {
  it('shows a loading skeleton, then renders rider rows', async () => {
    seedRiders([RIDER])
    render(<RidersPage />)

    expect(screen.getByLabelText('Loading')).toBeInTheDocument()

    expect(await screen.findByText('Asha Mwakalinga')).toBeInTheDocument()
    expect(screen.getByText('Dar es Salaam')).toBeInTheDocument()
    expect(screen.getByText('Bike')).toBeInTheDocument()
    expect(screen.getByText('TZA 1234')).toBeInTheDocument()
    expect(screen.getByText('Bajaj · 2020')).toBeInTheDocument()
    expect(screen.getByText('91')).toBeInTheDocument()
    expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument()
  })

  it('filters rows by verification with counts', async () => {
    seedRiders([
      { ...RIDER },
      { ...RIDER, id: 'rdr_2', name: 'Baraka Mushi', verification: 'rejected' },
      { ...RIDER, id: 'rdr_3', name: 'Neema Joseph', verification: 'pending' },
      { ...RIDER, id: 'rdr_4', name: 'Daudi Kimaro', verification: 'approved' },
    ])
    render(<RidersPage />)
    await screen.findByText('Asha Mwakalinga')

    expect(screen.getByRole('button', { name: 'All 4' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approved 2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pending 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rejected 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Documents review 0' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Approved 2' }))
    expect(screen.getByText('Daudi Kimaro')).toBeInTheDocument()
    expect(screen.getByText('Asha Mwakalinga')).toBeInTheDocument()
    expect(screen.queryByText('Baraka Mushi')).not.toBeInTheDocument()
    expect(screen.queryByText('Neema Joseph')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Pending 1' }))
    expect(screen.getByText('Neema Joseph')).toBeInTheDocument()
    expect(screen.queryByText('Asha Mwakalinga')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'All 4' }))
    expect(screen.getByText('Baraka Mushi')).toBeInTheDocument()
  })

  it('shows the empty state when no riders exist', async () => {
    seedRiders([])
    render(<RidersPage />)
    expect(await screen.findByText('No riders found')).toBeInTheDocument()
  })

  it('shows an error state and recovers on retry', async () => {
    let calls = 0
    server.use(
      http.get('/admin/riders', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'SERVICE_DOWN', message: 'down', requestId: 'req_1' }, { status: 500 })
        }
        return HttpResponse.json([RIDER])
      }),
    )
    render(<RidersPage />)

    expect(await screen.findByText('Failed to load riders')).toBeInTheDocument()
    expect(screen.getByText('down')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Asha Mwakalinga')).toBeInTheDocument()
    expect(screen.queryByText('Failed to load riders')).not.toBeInTheDocument()
  })

  it('opens a detail drawer with vehicle and verification details on row click', async () => {
    seedRiders([{ ...RIDER, documents: [{ type: 'insurance', status: 'rejected' }] }])
    render(<RidersPage />)

    const name = await screen.findByText('Asha Mwakalinga')
    fireEvent.click(name)

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Asha Mwakalinga' })).toBeInTheDocument()
    expect(within(dialog).getByText('Bike')).toBeInTheDocument()
    expect(within(dialog).getByText('TZA 1234')).toBeInTheDocument()
    expect(within(dialog).getByText('Bajaj · 2020')).toBeInTheDocument()
    expect(within(dialog).getByText('approved')).toBeInTheDocument()
    expect(within(dialog).getByText('insurance')).toBeInTheDocument()
    expect(within(dialog).getByText('91')).toBeInTheDocument()
    expect(within(dialog).getByText(/audited \(rider\.\*\) and notify the rider/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Request changes' })).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows verification actions for pending and changes_requested riders', async () => {
    seedRiders([{ ...RIDER, id: 'rdr_9', verification: 'pending' }])
    render(<RidersPage />)

    fireEvent.click(await screen.findByText('Asha Mwakalinga'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Request changes' })).toBeInTheDocument()
  })

  it('hides verification actions without rider.verify', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seedRiders([{ ...RIDER, id: 'rdr_10', verification: 'changes_requested' }])
    render(<RidersPage />)

    fireEvent.click(await screen.findByText('Asha Mwakalinga'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Request changes' })).not.toBeInTheDocument()
  })

  it('shows the pending-endpoint notice after confirming a verification decision', async () => {
    seedRiders([{ ...RIDER, id: 'rdr_9', verification: 'changes_requested' }])
    render(<RidersPage />)

    fireEvent.click(await screen.findByText('Asha Mwakalinga'))
    const drawer = await screen.findByRole('dialog')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Approve' }))

    const prompt = await screen.findByRole('dialog', { name: 'Approve rider' })
    fireEvent.change(within(prompt).getByLabelText('Reason'), { target: { value: 'Documents verified' } })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }))

    expect(screen.queryByRole('dialog', { name: 'Approve rider' })).not.toBeInTheDocument()
    expect(within(drawer).getByText('PENDING_ENDPOINT')).toBeInTheDocument()
    expect(within(drawer).getByText(/POST \/admin\/riders\/\{riderId\}\/approval/)).toBeInTheDocument()
    expect(within(drawer).getByText(/nothing was sent/)).toBeInTheDocument()
  })

  it('shows the per-entity audit trail in the drawer', async () => {
    const AUDIT_ENTRIES = [
      {
        id: 'aud_1',
        actorUserId: 'usr_31',
        actorRole: 'admin',
        action: 'rider.approved',
        entityType: 'rider',
        entityId: 'rdr_1',
        details: { reason: 'Documents verified' },
        ipAddress: '10.0.0.3',
        at: '2026-08-13T08:00:00.000Z',
        requestId: 'req_r1',
      },
      {
        id: 'aud_2',
        actorUserId: 'usr_32',
        action: 'rider.documents_updated',
        entityType: 'rider',
        entityId: 'rdr_1',
        at: '2026-08-14T08:00:00.000Z',
        requestId: 'req_r2',
      },
    ]
    server.use(
      http.get('/admin/riders', () => HttpResponse.json([RIDER])),
      http.get('*/admin/audit-logs', () => HttpResponse.json(AUDIT_ENTRIES)),
    )
    render(<RidersPage />)

    fireEvent.click(await screen.findByText('Asha Mwakalinga'))
    const dialog = await screen.findByRole('dialog')

    expect(await within(dialog).findByText('rider.documents updated')).toBeInTheDocument()
    expect(within(dialog).getByText('rider.approved')).toBeInTheDocument()
    expect(within(dialog).getByText('usr_31')).toBeInTheDocument()
  })

  it('shows no audit entries when the trail is empty', async () => {
    server.use(
      http.get('/admin/riders', () => HttpResponse.json([RIDER])),
      http.get('*/admin/audit-logs', () => HttpResponse.json([])),
    )
    render(<RidersPage />)

    fireEvent.click(await screen.findByText('Asha Mwakalinga'))
    await screen.findByRole('dialog')

    expect(await screen.findByText('No audit entries for this entity')).toBeInTheDocument()
  })
})
