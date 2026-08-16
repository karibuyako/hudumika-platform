import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { CustomersPage } from './CustomersPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const CUSTOMER = {
  id: 'cus_1',
  phone: '+255712345678',
  fullName: 'Aisha Mwamba',
  role: 'customer',
  status: 'active',
  orderCount: 12,
  totalSpendTZS: 150000,
  lastOrderAt: '2026-08-01T09:30:00.000Z',
  joinedAt: '2025-01-15T08:00:00.000Z',
  lastActiveAt: '2026-08-10T17:45:00.000Z',
}

function seedCustomers(customers: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/customers', () => HttpResponse.json(customers)))
}

describe('CustomersPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders rows with masked phone after data loads', async () => {
    seedCustomers([{ ...CUSTOMER }])
    render(<CustomersPage />)

    expect(await screen.findByText('Aisha Mwamba')).toBeInTheDocument()
    expect(screen.getByText('+255 ••• 678')).toBeInTheDocument()
    expect(screen.getByText('TZS 150,000')).toBeInTheDocument()
    expect(screen.getByText('customer')).toBeInTheDocument()
  })

  it('shows the empty state when there are no customers', async () => {
    seedCustomers([])
    render(<CustomersPage />)

    expect(await screen.findByText('No customers found')).toBeInTheDocument()
  })

  it('exports customers as CSV', async () => {
    seedCustomers([{ ...CUSTOMER }])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<CustomersPage />)

    await screen.findByText('Aisha Mwamba')
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Name')
    expect(csv).toContain('Total spend')
    expect(csv).toContain('Aisha Mwamba')
    expect(csv).toContain('150,000')
    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('shows an error state and recovers via Retry', async () => {
    server.use(
      http.get('/admin/customers', () =>
        HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 }),
      ),
    )
    render(<CustomersPage />)

    expect(await screen.findByText('Failed to load customers')).toBeInTheDocument()

    seedCustomers([{ ...CUSTOMER }])
    fireEvent.click(screen.getByText('Retry'))

    expect(await screen.findByText('Aisha Mwamba')).toBeInTheDocument()
  })

  it('status chip triggers a server-side refetch', async () => {
    seedCustomers([{ ...CUSTOMER }])
    let usersUrl = ''
    server.use(
      http.get('/admin/users', ({ request }) => {
        usersUrl = request.url
        return HttpResponse.json([
          { ...CUSTOMER, id: 'cus_2', phone: '+255713333444', fullName: 'Bakari Juma', status: 'suspended' },
        ])
      }),
    )
    render(<CustomersPage />)

    await screen.findByText('Aisha Mwamba')
    fireEvent.click(screen.getByText('Suspended'))

    expect(await screen.findByText('Bakari Juma')).toBeInTheDocument()
    expect(screen.getByText('+255 ••• 444')).toBeInTheDocument()
    expect(usersUrl).toContain('status=suspended')
    expect(screen.getByRole('button', { name: 'Suspended' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('Aisha Mwamba')).not.toBeInTheDocument()
  })

  it('suspends a customer with a reason, shows toast and refetches', async () => {
    let customerCalls = 0
    server.use(
      http.get('/admin/customers', () => {
        customerCalls++
        return HttpResponse.json([{ ...CUSTOMER }])
      }),
      http.post('/admin/users/cus_1/status', () =>
        HttpResponse.json({ id: 'cus_1', status: 'suspended' }),
      ),
    )
    render(<CustomersPage />)

    await screen.findByText('Aisha Mwamba')
    fireEvent.click(screen.getByText('Aisha Mwamba'))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }))
    expect(screen.getByText('Suspend customer')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Fraud report under review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Customer suspended')).toBeInTheDocument()
    await waitFor(() => expect(customerCalls).toBe(2))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows an inline error when the status mutation is forbidden', async () => {
    seedCustomers([{ ...CUSTOMER }])
    server.use(
      http.post('/admin/users/cus_1/status', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<CustomersPage />)

    await screen.findByText('Aisha Mwamba')
    fireEvent.click(screen.getByText('Aisha Mwamba'))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }))
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Fraud' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByText('Suspend customer')).toBeInTheDocument()
  })

  it('hides suspend and activate actions without customer suspend permission', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seedCustomers([{ ...CUSTOMER }])
    render(<CustomersPage />)

    await screen.findByText('Aisha Mwamba')
    fireEvent.click(screen.getByText('Aisha Mwamba'))
    await screen.findByRole('dialog')

    expect(screen.queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument()
  })

  it('shows the per-entity audit trail in the drawer', async () => {
    const AUDIT_ENTRIES = [
      {
        id: 'aud_1',
        actorUserId: 'usr_41',
        actorRole: 'compliance',
        action: 'customer.suspended',
        entityType: 'customer',
        entityId: 'cus_1',
        details: { reason: 'Fraud review' },
        ipAddress: '10.0.0.7',
        at: '2026-08-12T08:00:00.000Z',
        requestId: 'req_c1',
      },
      {
        id: 'aud_2',
        actorUserId: 'usr_42',
        action: 'customer.activated',
        entityType: 'customer',
        entityId: 'cus_1',
        at: '2026-08-13T08:00:00.000Z',
        requestId: 'req_c2',
      },
    ]
    server.use(
      http.get('/admin/customers', () => HttpResponse.json([CUSTOMER])),
      http.get('*/admin/audit-logs', () => HttpResponse.json(AUDIT_ENTRIES)),
    )
    render(<CustomersPage />)

    await screen.findByText('Aisha Mwamba')
    fireEvent.click(screen.getByText('Aisha Mwamba'))
    const dialog = await screen.findByRole('dialog')

    expect(await within(dialog).findByText('customer.activated')).toBeInTheDocument()
    expect(within(dialog).getByText('customer.suspended')).toBeInTheDocument()
    expect(within(dialog).getByText('usr_41')).toBeInTheDocument()
  })

  it('shows no audit entries when the trail is empty', async () => {
    server.use(
      http.get('/admin/customers', () => HttpResponse.json([CUSTOMER])),
      http.get('*/admin/audit-logs', () => HttpResponse.json([])),
    )
    render(<CustomersPage />)

    await screen.findByText('Aisha Mwamba')
    fireEvent.click(screen.getByText('Aisha Mwamba'))
    await screen.findByRole('dialog')

    expect(await screen.findByText('No audit entries for this entity')).toBeInTheDocument()
  })
})
