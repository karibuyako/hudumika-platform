import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { VehiclesPage } from './VehiclesPage'
import { server } from '../../test/setup'
import { toLocal } from '../../lib/time'

const VEHICLE: Record<string, unknown> = {
  id: 'veh_1',
  registration: 'T 123 DAR',
  vehicleType: 'motorcycle',
  operatorId: 'r_9',
  capacity: { totalUnits: 3, maxWeightKg: 120, maxVolumeL: 30 },
  temperatureCapable: false,
  securityCapability: 'lockbox',
  status: 'active',
  currentTripId: 'trip_5',
}

const VEHICLE_FULL: Record<string, unknown> = {
  id: 'veh_2',
  registration: 'T 456 MBA',
  vehicleType: 'van',
  operatorId: null,
  capacity: { totalUnits: 8, maxWeightKg: 1500, maxVolumeL: 12 },
  temperatureCapable: true,
  securityCapability: 'none',
  status: 'on_trip',
  currentTripId: null,
}

const VEHICLE_MIN: Record<string, unknown> = {
  id: 'veh_3',
  registration: 'T 789 ARA',
  vehicleType: 'refrigerated_truck',
  status: 'retired',
}

const MAINTENANCE: Record<string, unknown> = {
  id: 'mnt_1',
  riderId: 'r_9',
  type: 'oil_change',
  performedAt: '2026-08-01T08:00:00.000Z',
  mileageKm: 12500,
  costTZS: 45000,
  notes: 'Full synthetic',
  nextDueAt: '2026-09-01T08:00:00.000Z',
}

function seedList(rows: Array<Record<string, unknown>>) {
  server.use(http.get('/vehicles', () => HttpResponse.json(rows)))
}

describe('VehiclesPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads and renders vehicle rows with metadata', async () => {
    seedList([{ ...VEHICLE }, { ...VEHICLE_FULL }, { ...VEHICLE_MIN }])
    render(<VehiclesPage />)

    expect(await screen.findByText('T 123 DAR')).toBeInTheDocument()
    expect(screen.getByText('T 456 MBA')).toBeInTheDocument()
    expect(screen.getByText('T 789 ARA')).toBeInTheDocument()

    const row1 = screen.getByText('T 123 DAR').closest('tr')!
    expect(within(row1).getByText('motorcycle')).toBeInTheDocument()
    expect(within(row1).getByText('r_9')).toBeInTheDocument()
    expect(within(row1).getByText('active')).toBeInTheDocument()
    expect(within(row1).getByText('3')).toBeInTheDocument()
    expect(within(row1).getByText('lockbox')).toBeInTheDocument()
    expect(within(row1).getByText('trip_5')).toBeInTheDocument()

    const row2 = screen.getByText('T 456 MBA').closest('tr')!
    expect(within(row2).getByText('van')).toBeInTheDocument()
    expect(within(row2).getByText('on trip')).toBeInTheDocument()
    expect(within(row2).getByText('8')).toBeInTheDocument()
    expect(within(row2).getByText('cold')).toBeInTheDocument()

    const row3 = screen.getByText('T 789 ARA').closest('tr')!
    expect(within(row3).getByText('refrigerated_truck')).toBeInTheDocument()
    expect(within(row3).getByText('retired')).toBeInTheDocument()
    expect(within(row3).getAllByText('—').length).toBeGreaterThan(0)
  })

  it('filters rows by vehicle type and status chips', { timeout: 20000 }, async () => {
    seedList([{ ...VEHICLE }, { ...VEHICLE_FULL }, { ...VEHICLE_MIN }])
    render(<VehiclesPage />)
    await screen.findByText('T 123 DAR', undefined, { timeout: 15000 })

    const typeGroup = screen.getByRole('group', { name: 'Vehicle type' })
    fireEvent.click(within(typeGroup).getByRole('button', { name: /^van/ }))
    await waitFor(() => expect(screen.queryByText('T 123 DAR')).not.toBeInTheDocument())
    expect(screen.getByText('T 456 MBA')).toBeInTheDocument()
    expect(screen.queryByText('T 789 ARA')).not.toBeInTheDocument()

    const statusGroup = screen.getByRole('group', { name: 'Vehicle status' })
    fireEvent.click(within(statusGroup).getByRole('button', { name: /^on_trip/ }))
    await waitFor(() => expect(screen.getByText('T 456 MBA')).toBeInTheDocument())

    fireEvent.click(within(typeGroup).getByRole('button', { name: /^all/i }))
    fireEvent.click(within(statusGroup).getByRole('button', { name: /^all/i }))
    await waitFor(() => expect(screen.getByText('T 123 DAR')).toBeInTheDocument())
    expect(screen.getByText('T 789 ARA')).toBeInTheDocument()
  })

  it('shows an empty state when there are no vehicles', async () => {
    seedList([])
    render(<VehiclesPage />)
    expect(await screen.findByText('No vehicles')).toBeInTheDocument()
  })

  it('shows an error state and recovers via retry', async () => {
    server.use(http.get('/vehicles', () => HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 })))
    render(<VehiclesPage />)
    expect(await screen.findByText('Failed to load vehicles')).toBeInTheDocument()

    seedList([{ ...VEHICLE }])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('T 123 DAR')).toBeInTheDocument()
  })

  it('switches to the maintenance tab and loads maintenance records', async () => {
    seedList([{ ...VEHICLE }])
    server.use(
      http.get('/riders/me/vehicle/maintenance', () => HttpResponse.json([{ ...MAINTENANCE }])),
    )
    render(<VehiclesPage />)
    await screen.findByText('T 123 DAR')

    fireEvent.click(screen.getByRole('button', { name: 'Maintenance' }))
    expect(await screen.findByText('oil_change')).toBeInTheDocument()
    expect(screen.getByText(toLocal(String(MAINTENANCE.performedAt)))).toBeInTheDocument()
    expect(screen.getByText('TZS 45,000')).toBeInTheDocument()
    expect(screen.getByText('12500')).toBeInTheDocument()
    expect(screen.getByText('Full synthetic')).toBeInTheDocument()
    expect(screen.queryByText('T 123 DAR')).not.toBeInTheDocument()
  })

  it('opens the read-only vehicle drawer from a row', async () => {
    seedList([{ ...VEHICLE }])
    render(<VehiclesPage />)
    await screen.findByText('T 123 DAR')

    fireEvent.click(screen.getByText('T 123 DAR'))
    const drawer = await screen.findByRole('dialog', { name: 'T 123 DAR' })
    expect(within(drawer).getByText('veh_1')).toBeInTheDocument()
    expect(within(drawer).getByText(/120 kg max/)).toBeInTheDocument()
    expect(within(drawer).getByText(/30 L max/)).toBeInTheDocument()
    expect(within(drawer).getByText('trip_5')).toBeInTheDocument()
    expect(within(drawer).getByText(/view-only for vehicle state/)).toBeInTheDocument()
  })

  it('sorts the fleet table by status via the column header', async () => {
    seedList([{ ...VEHICLE }, { ...VEHICLE_FULL }, { ...VEHICLE_MIN }])
    render(<VehiclesPage />)
    await screen.findByText('T 123 DAR')

    fireEvent.click(screen.getByRole('button', { name: /Status/ }))

    const table = screen.getByRole('table', { name: 'Vehicles' })
    const regs = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(regs).toEqual(['T 123 DAR', 'T 456 MBA', 'T 789 ARA'])

    fireEvent.click(screen.getByRole('button', { name: /Status/ }))
    const desc = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(desc).toEqual(['T 789 ARA', 'T 456 MBA', 'T 123 DAR'])
  })

  it('exports the fleet table as CSV via the DataTable', async () => {
    seedList([{ ...VEHICLE }, { ...VEHICLE_FULL }])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let downloadName = ''
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadName = this.download
      })
    render(<VehiclesPage />)
    await screen.findByText('T 123 DAR')

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(downloadName).toBe('vehicles.csv')
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Registration,Type,Operator,Status,Capacity,Cold,Security,Trip')
    expect(csv).toContain('T 123 DAR')
    expect(csv).toContain('r_9')
    expect(csv).toContain('trip_5')
    expect(revokeObjectURL).toHaveBeenCalled()
  })
})
