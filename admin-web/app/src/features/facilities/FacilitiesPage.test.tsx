import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { FacilitiesPage } from './FacilitiesPage'
import { server } from '../../test/setup'
import { toLocal } from '../../lib/time'

const FACILITY: Record<string, unknown> = {
  id: 'fac_1',
  name: 'Msasani Peninsula Estate',
  address: 'Plot 4, Msasani Road, Dar es Salaam',
  geofence: ['39.28,-6.81', '39.29,-6.82'],
  whitelistRiderIds: ['rider_1', 'rider_2'],
  accessPolicy: 'whitelist_only',
  createdAt: '2026-07-20T10:00:00.000Z',
}

const FACILITY_OTP: Record<string, unknown> = {
  ...FACILITY,
  id: 'fac_2',
  name: 'Kariakoo Business Park',
  address: 'Plot 9, Nyerere Road',
  geofence: undefined,
  whitelistRiderIds: undefined,
  accessPolicy: 'whitelist_or_otp',
}

const FACILITY_OPEN: Record<string, unknown> = {
  ...FACILITY,
  id: 'fac_3',
  name: 'Open Air Market',
  address: 'City Centre',
  geofence: [],
  whitelistRiderIds: [],
  accessPolicy: 'open',
}

function seedList(rows: Array<Record<string, unknown>>) {
  server.use(http.get('/facilities', () => HttpResponse.json(rows)))
}

describe('FacilitiesPage', () => {
  it('loads and renders facility rows with policy, whitelist count, geofence and dates', async () => {
    seedList([{ ...FACILITY }, { ...FACILITY_OTP }, { ...FACILITY_OPEN }])
    render(<FacilitiesPage />)

    expect(await screen.findByText('Msasani Peninsula Estate')).toBeInTheDocument()
    expect(screen.getByText('Kariakoo Business Park')).toBeInTheDocument()
    expect(screen.getByText('Plot 4, Msasani Road, Dar es Salaam')).toBeInTheDocument()
    expect(screen.getAllByText('whitelist_only')).toHaveLength(2)
    expect(screen.getAllByText('whitelist_or_otp')).toHaveLength(2)
    expect(screen.getAllByText('open')).toHaveLength(2)
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('2 vertices')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(4)
    expect(screen.getAllByText(toLocal(String(FACILITY.createdAt)))).toHaveLength(3)
  })

  it('filters rows by access policy chip', async () => {
    seedList([{ ...FACILITY }, { ...FACILITY_OTP }, { ...FACILITY_OPEN }])
    render(<FacilitiesPage />)
    await screen.findByText('Msasani Peninsula Estate')

    fireEvent.click(screen.getByRole('button', { name: /whitelist_or_otp/i }))
    await waitFor(() => expect(screen.queryByText('Msasani Peninsula Estate')).not.toBeInTheDocument())
    expect(screen.getByText('Kariakoo Business Park')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^open/i }))
    await waitFor(() => expect(screen.queryByText('Kariakoo Business Park')).not.toBeInTheDocument())
    expect(screen.getByText('Open Air Market')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^all/i }))
    await waitFor(() => expect(screen.getByText('Msasani Peninsula Estate')).toBeInTheDocument())
  })

  it('shows an empty state when there are no facilities', async () => {
    seedList([])
    render(<FacilitiesPage />)
    expect(await screen.findByText('No facilities')).toBeInTheDocument()
  })

  it('exports the visible facilities as CSV', async () => {
    seedList([{ ...FACILITY }])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<FacilitiesPage />)
    await screen.findByText('Msasani Peninsula Estate')

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(anchorClick).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Name,Address,Access policy,Whitelisted riders,Geofence,Created')
    expect(csv).toContain('Msasani Peninsula Estate')
    expect(csv).toContain('2 vertices')
    expect(revokeObjectURL).toHaveBeenCalled()
  })

  it('shows an error state and recovers via retry', async () => {
    server.use(http.get('/facilities', () => HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 })))
    render(<FacilitiesPage />)
    expect(await screen.findByText('Failed to load facilities')).toBeInTheDocument()

    seedList([{ ...FACILITY }])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Msasani Peninsula Estate')).toBeInTheDocument()
  })

  it('creates a facility, shows a toast and refetches the list', async () => {
    let posted: Record<string, unknown> | null = null
    const rows: Array<Record<string, unknown>> = [{ ...FACILITY }]
    server.use(
      http.get('/facilities', () => HttpResponse.json(rows)),
      http.post('/facilities', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>
        const created = {
          ...FACILITY,
          id: 'fac_9',
          name: String(posted.name),
          address: String(posted.address),
          accessPolicy: String(posted.accessPolicy),
          geofence: posted.geofence,
        }
        rows.push(created)
        return HttpResponse.json(created, { status: 201 })
      }),
    )
    render(<FacilitiesPage />)
    await screen.findByText('Msasani Peninsula Estate')

    fireEvent.click(screen.getByRole('button', { name: 'New facility' }))
    const modal = await screen.findByRole('dialog', { name: 'New facility' })
    fireEvent.change(within(modal).getByLabelText('Name'), { target: { value: 'Ubungo Gate Estate' } })
    fireEvent.change(within(modal).getByLabelText('Address'), { target: { value: 'Plot 2, Morogoro Road' } })
    fireEvent.change(within(modal).getByLabelText('Geofence (lon,lat pairs)'), {
      target: { value: '39.1,-6.8, 39.2,-6.9' },
    })
    fireEvent.click(within(modal).getByRole('button', { name: 'Create facility' }))

    await waitFor(() => expect(posted).not.toBeNull())
    expect((posted as unknown as Record<string, unknown>)?.name).toBe('Ubungo Gate Estate')
    expect((posted as unknown as Record<string, unknown>)?.address).toBe('Plot 2, Morogoro Road')
    expect((posted as unknown as Record<string, unknown>)?.accessPolicy).toBe('whitelist_only')
    expect((posted as unknown as Record<string, unknown>)?.geofence).toEqual(['39.1,-6.8', '39.2,-6.9'])
    expect(await screen.findByText('Facility created')).toBeInTheDocument()
    expect(await screen.findByText('Ubungo Gate Estate')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('updates the whitelist from the drawer with a toast and refetch', async () => {
    let put: Record<string, unknown> | null = null
    const rows: Array<Record<string, unknown>> = [{ ...FACILITY }]
    server.use(
      http.get('/facilities', () => HttpResponse.json(rows)),
      http.put('/facilities/fac_1/whitelist', async ({ request }) => {
        put = (await request.json()) as Record<string, unknown>
        const updated = { ...FACILITY, whitelistRiderIds: put?.riderIds }
        rows.splice(0, 1, updated)
        return HttpResponse.json(updated)
      }),
    )
    render(<FacilitiesPage />)
    await screen.findByText('Msasani Peninsula Estate')

    fireEvent.click(screen.getByText('Msasani Peninsula Estate'))
    const drawer = await screen.findByRole('dialog', { name: 'Msasani Peninsula Estate' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Manage whitelist' }))

    const modal = await screen.findByRole('dialog', { name: 'Manage whitelist' })
    const textarea = within(modal).getByLabelText('Rider IDs')
    expect(textarea).toHaveValue('rider_1, rider_2')
    fireEvent.change(textarea, { target: { value: 'rider_1, rider_2, rider_3' } })
    fireEvent.change(within(modal).getByLabelText('Reason'), { target: { value: 'Gate staff approved new resident' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Save whitelist' }))

    await waitFor(() => expect(put).not.toBeNull())
    expect((put as unknown as Record<string, unknown>)?.riderIds).toEqual(['rider_1', 'rider_2', 'rider_3'])
    expect(await screen.findByText('Whitelist updated')).toBeInTheDocument()
    expect(await screen.findByText('3')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Msasani Peninsula Estate' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Manage whitelist' })).not.toBeInTheDocument()
  })

  it('shows an inline error when updating the whitelist is forbidden', async () => {
    seedList([{ ...FACILITY }])
    server.use(
      http.put('/facilities/fac_1/whitelist', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<FacilitiesPage />)
    await screen.findByText('Msasani Peninsula Estate')

    fireEvent.click(screen.getByText('Msasani Peninsula Estate'))
    const drawer = await screen.findByRole('dialog', { name: 'Msasani Peninsula Estate' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Manage whitelist' }))

    const modal = await screen.findByRole('dialog', { name: 'Manage whitelist' })
    fireEvent.change(within(modal).getByLabelText('Rider IDs'), { target: { value: 'rider_9' } })
    fireEvent.change(within(modal).getByLabelText('Reason'), { target: { value: 'Testing denial' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Save whitelist' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Manage whitelist' })).toBeInTheDocument()
    expect(screen.queryByText('Whitelist updated')).not.toBeInTheDocument()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
