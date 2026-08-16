import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'
import { BookingsPage } from './BookingsPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const BOOKING: Record<string, unknown> = {
  id: 'bkg_1',
  status: 'matching',
  providerId: null,
  serviceId: 'svc_1',
  scheduledFor: '2026-08-16T09:00:00.000Z',
  technicianId: null,
  slaDeadlineAt: '2026-08-16T17:00:00.000Z',
  price: { subtotalTZS: 50000, deliveryFeeTZS: 0, platformFeeTZS: 2000, taxTZS: 0, discountTZS: 0, totalTZS: 52000 },
  createdAt: '2026-08-15T10:00:00.000Z',
  address: { label: 'Home', lines: '1 Main St, Dar es Salaam', landmark: 'Blue gate', contactPhone: '+255 712 000 000' },
  events: [
    { status: 'paid', at: '2026-08-15T10:00:00.000Z', by: 'customer' },
    { status: 'matching', at: '2026-08-15T10:05:00.000Z', by: 'system' },
  ],
}

function seed(bookings: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/bookings', () => HttpResponse.json(bookings)))
}

async function openDrawer() {
  await userEvent.click(await screen.findByText('bkg_1'))
  await userEvent.click(await screen.findByRole('button', { name: 'Assign provider' }))
}

async function fillAndConfirm(providerId = 'prv_9') {
  await userEvent.type(screen.getByLabelText('Provider ID'), providerId)
  await userEvent.type(screen.getByLabelText('Reason'), 'Manual dispatch override')
  await userEvent.click(screen.getByRole('button', { name: 'Assign' }))
}

describe('BookingsPage', () => {
  it('renders bookings after loading', async () => {
    seed([
      { ...BOOKING },
      { ...BOOKING, id: 'bkg_2', status: 'completed', providerId: 'prv_1', price: { subtotalTZS: 8000, totalTZS: 8000 } },
    ])
    render(<BookingsPage />)

    expect(await screen.findByText('bkg_1')).toBeInTheDocument()
    expect(screen.getByText('bkg_2')).toBeInTheDocument()
    expect(screen.getByText('TZS 52,000')).toBeInTheDocument()
  })

  it('filters rows by bucket', async () => {
    seed([{ ...BOOKING }, { ...BOOKING, id: 'bkg_2', status: 'completed', providerId: 'prv_1' }])
    render(<BookingsPage />)
    await screen.findByText('bkg_1')

    screen.getByText('Needs provider').click()
    await waitFor(() => expect(screen.queryByText('bkg_2')).not.toBeInTheDocument())
    expect(screen.getByText('bkg_1')).toBeInTheDocument()
  })

  it('sorts by price when the Price header is clicked', async () => {
    seed([
      { ...BOOKING, id: 'bkg_1', price: { subtotalTZS: 52000, totalTZS: 52000 } },
      { ...BOOKING, id: 'bkg_2', status: 'completed', providerId: 'prv_1', price: { subtotalTZS: 8000, totalTZS: 8000 } },
    ])
    const { container } = render(<BookingsPage />)
    await screen.findByText('bkg_1')

    fireEvent.click(screen.getByRole('button', { name: /Price/ }))

    const firstRow = container.querySelector('tbody tr td')!
    expect(firstRow.textContent).toBe('bkg_2')
  })

  it('shows an empty state when there are no bookings', async () => {
    seed([])
    render(<BookingsPage />)
    expect(await screen.findByText('No bookings found')).toBeInTheDocument()
  })

  it('shows an error state and recovers on retry', async () => {
    server.use(http.get('/admin/bookings', () => HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 })))
    render(<BookingsPage />)
    expect(await screen.findByText('Failed to load bookings')).toBeInTheDocument()

    seed([{ ...BOOKING }])
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('bkg_1')).toBeInTheDocument()
  })

  it('assigns a provider and refetches the list', async () => {
    const row = { ...BOOKING }
    server.use(
      http.get('/admin/bookings', () => HttpResponse.json([row])),
      http.post('/admin/bookings/bkg_1/assign-provider', () => {
        row.providerId = 'prv_9'
        row.status = 'provider_accepted'
        return HttpResponse.json({ ...row })
      }),
    )
    render(<BookingsPage />)

    await openDrawer()
    await fillAndConfirm()

    expect(await screen.findByText('Provider assigned to bkg_1')).toBeInTheDocument()
    expect(await screen.findByText('prv_9')).toBeInTheDocument()
  })

  it('surfaces a conflict inline when assignment fails', async () => {
    seed([{ ...BOOKING }])
    server.use(
      http.post('/admin/bookings/bkg_1/assign-provider', () =>
        HttpResponse.json({ code: 'BOOKING_NOT_ASSIGNABLE', message: 'state conflict' }, { status: 409 }),
      ),
    )
    render(<BookingsPage />)

    await openDrawer()
    await fillAndConfirm()

    expect(await screen.findByText('state conflict')).toBeInTheDocument()
    expect(screen.getByText('BOOKING_NOT_ASSIGNABLE')).toBeInTheDocument()
    expect(screen.queryByText('Provider assigned to bkg_1')).not.toBeInTheDocument()
  })

  it('hides the assign provider action without order override permission', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seed([{ ...BOOKING }])
    render(<BookingsPage />)

    await userEvent.click(await screen.findByText('bkg_1'))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('No provider assigned to this booking yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Assign provider' })).not.toBeInTheDocument()
  })
})
