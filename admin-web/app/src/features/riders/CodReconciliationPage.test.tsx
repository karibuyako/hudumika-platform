import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { CodReconciliationPage } from './CodReconciliationPage'
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
  documents: [],
  reliabilityScore: 91,
}

const RECONCILED_SHIFT = {
  shiftId: 'sh_1',
  date: '2026-08-10T00:00:00.000Z',
  expectedTZS: 50000,
  collectedTZS: 50000,
  status: 'reconciled',
  note: null,
}

const MISMATCH_SHIFT = {
  shiftId: 'sh_2',
  date: '2026-08-11T00:00:00.000Z',
  expectedTZS: 30000,
  collectedTZS: 45000,
  status: 'mismatch',
  note: 'Cash short',
}

const RECON = {
  riderId: 'rdr_1',
  from: '2026-08-10T00:00:00.000Z',
  to: '2026-08-11T23:59:59.000Z',
  shifts: [RECONCILED_SHIFT, MISMATCH_SHIFT],
  totals: { expectedTZS: 80000, collectedTZS: 95000, varianceTZS: -15000 },
}

function seedRiders(riders: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/riders', () => HttpResponse.json(riders)))
}

function seedCod(payload: Record<string, unknown>) {
  server.use(http.get('/admin/riders/rdr_1/cod', () => HttpResponse.json(payload)))
}

async function selectRider() {
  fireEvent.change(screen.getByLabelText('Rider'), { target: { value: 'rdr_1' } })
}

describe('CodReconciliationPage', () => {
  it('loads riders into the picker with name, city and id', async () => {
    seedRiders([RIDER])
    render(<CodReconciliationPage />)

    const select = await screen.findByLabelText('Rider')
    expect(select).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Asha Mwakalinga · Dar es Salaam · rdr_1' })).toBeInTheDocument()
  })

  it('selecting a rider loads shifts with TZS totals including negative variance', async () => {
    seedRiders([RIDER])
    seedCod(RECON)
    render(<CodReconciliationPage />)

    await screen.findByLabelText('Rider')
    await selectRider()

    expect(await screen.findByText('sh_1')).toBeInTheDocument()
    expect(screen.getByText('sh_2')).toBeInTheDocument()
    expect(screen.getByText('Cash short')).toBeInTheDocument()
    expect(screen.getAllByText('TZS 50,000')).toHaveLength(2)
    expect(screen.getByText('TZS 30,000')).toBeInTheDocument()
    expect(screen.getByText('TZS 45,000')).toBeInTheDocument()
    expect(screen.getAllByText('-TZS 15,000')).toHaveLength(2)
    expect(screen.getByText('TZS 80,000')).toBeInTheDocument()
    expect(screen.getByText('TZS 95,000')).toBeInTheDocument()
    expect(screen.getByText('variance = expected − collected')).toBeInTheDocument()
    expect(screen.getByText('1 mismatched shift(s) flagged for finance follow-up')).toBeInTheDocument()
  })

  it('shows the empty state when the rider has no shifts', async () => {
    seedRiders([RIDER])
    seedCod({ riderId: 'rdr_1', shifts: [] })
    render(<CodReconciliationPage />)

    await screen.findByLabelText('Rider')
    await selectRider()

    expect(await screen.findByText('No shifts in this range')).toBeInTheDocument()
    expect(
      screen.getByText('COD reconciliation data is unavailable for the selected rider and range'),
    ).toBeInTheDocument()
  })

  it('shows an error for the COD view and recovers via Retry', async () => {
    seedRiders([RIDER])
    let calls = 0
    server.use(
      http.get('/admin/riders/rdr_1/cod', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'INTERNAL', message: 'cod service down', requestId: 'req_cod_1' }, { status: 500 })
        }
        return HttpResponse.json(RECON)
      }),
    )
    render(<CodReconciliationPage />)

    await screen.findByLabelText('Rider')
    await selectRider()

    expect(await screen.findByText('Failed to load reconciliation')).toBeInTheDocument()
    expect(screen.getByText('cod service down')).toBeInTheDocument()
    expect(screen.getByText('req_cod_1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('sh_1')).toBeInTheDocument()
    expect(screen.queryByText('Failed to load reconciliation')).not.toBeInTheDocument()
  })

  it('applies the date range and refetches with from/to query params', async () => {
    seedRiders([RIDER])
    let lastUrl = ''
    server.use(
      http.get('/admin/riders/rdr_1/cod', ({ request }) => {
        lastUrl = request.url
        return HttpResponse.json(RECON)
      }),
    )
    render(<CodReconciliationPage />)

    await screen.findByLabelText('Rider')
    await selectRider()
    await screen.findByText('sh_1')

    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-08-01' } })
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-08-10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply range' }))

    const expectedFrom = new Date('2026-08-01T00:00:00').toISOString()
    const expectedTo = new Date('2026-08-10T23:59:59').toISOString()
    await waitFor(() => {
      const url = new URL(lastUrl)
      expect(url.searchParams.get('from')).toBe(expectedFrom)
      expect(url.searchParams.get('to')).toBe(expectedTo)
    })
    expect(screen.getByText(/^Showing /)).toBeInTheDocument()
  })

  it('flags mismatched shifts for finance follow-up', async () => {
    seedRiders([RIDER])
    seedCod({
      riderId: 'rdr_1',
      shifts: [
        { ...MISMATCH_SHIFT, shiftId: 'sh_1', note: null },
        { ...MISMATCH_SHIFT, shiftId: 'sh_2', status: 'mismatch', note: 'Short 2' },
      ],
      totals: { expectedTZS: 60000, collectedTZS: 90000, varianceTZS: -30000 },
    })
    render(<CodReconciliationPage />)

    await screen.findByLabelText('Rider')
    await selectRider()

    expect(await screen.findByText('2 mismatched shift(s) flagged for finance follow-up')).toBeInTheDocument()
    expect(screen.getByText(/decision endpoints ship with the backend milestone/)).toBeInTheDocument()
    expect(screen.getByText(/Decision endpoints are documented for backend implementation/)).toBeInTheDocument()
  })

  it('shows decision actions for pending and mismatch shifts, gated by cod.reconcile', async () => {
    seedRiders([RIDER])
    seedCod({
      riderId: 'rdr_1',
      shifts: [
        { ...RECONCILED_SHIFT, shiftId: 'sh_1' },
        { ...MISMATCH_SHIFT, shiftId: 'sh_2' },
        { ...MISMATCH_SHIFT, shiftId: 'sh_3', status: 'pending', note: null },
      ],
      totals: { expectedTZS: 100000, collectedTZS: 95000, varianceTZS: 5000 },
    })
    render(<CodReconciliationPage />)

    await screen.findByLabelText('Rider')
    await selectRider()

    const row2 = await screen.findByText('sh_2')
    const row2Buttons = within(row2.closest('tr')!)
    expect(row2Buttons.getByRole('button', { name: 'Mark reconciled' })).toBeInTheDocument()
    expect(row2Buttons.getByRole('button', { name: 'Flag mismatch' })).toBeInTheDocument()

    const row3 = within((await screen.findByText('sh_3')).closest('tr')!)
    expect(row3.getByRole('button', { name: 'Mark reconciled' })).toBeInTheDocument()

    const row1 = within((await screen.findByText('sh_1')).closest('tr')!)
    expect(row1.queryByRole('button', { name: 'Mark reconciled' })).not.toBeInTheDocument()
  })

  it('hides decision actions without cod.reconcile', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seedRiders([RIDER])
    seedCod({
      riderId: 'rdr_1',
      shifts: [MISMATCH_SHIFT],
      totals: { expectedTZS: 30000, collectedTZS: 45000, varianceTZS: -15000 },
    })
    render(<CodReconciliationPage />)

    await screen.findByLabelText('Rider')
    await selectRider()

    const row = within((await screen.findByText('sh_2')).closest('tr')!)
    expect(row.queryByRole('button', { name: 'Mark reconciled' })).not.toBeInTheDocument()
    expect(row.queryByRole('button', { name: 'Flag mismatch' })).not.toBeInTheDocument()
  })

  it('shows the pending-endpoint notice after confirming a shift decision', async () => {
    seedRiders([RIDER])
    seedCod(RECON)
    render(<CodReconciliationPage />)

    await screen.findByLabelText('Rider')
    await selectRider()

    const row = within((await screen.findByText('sh_2')).closest('tr')!)
    fireEvent.click(row.getByRole('button', { name: 'Flag mismatch' }))

    const prompt = await screen.findByRole('dialog', { name: 'Flag shift mismatch' })
    fireEvent.change(within(prompt).getByLabelText('Reason'), { target: { value: 'Cash short by 15000' } })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }))

    expect(screen.queryByRole('dialog', { name: 'Flag shift mismatch' })).not.toBeInTheDocument()
    expect(screen.getByText('PENDING_ENDPOINT')).toBeInTheDocument()
    expect(screen.getByText(/POST \/admin\/riders\/\{riderId\}\/cod\/\{shiftId\}\/decision/)).toBeInTheDocument()
    expect(screen.getByText(/nothing was sent/)).toBeInTheDocument()
  })

  it('shows the picker empty state when no approved riders exist', async () => {
    seedRiders([])
    render(<CodReconciliationPage />)

    expect(await screen.findByText('No riders available')).toBeInTheDocument()
  })
})
