import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { FleetAccountsPage } from './FleetAccountsPage'
import { server } from '../../test/setup'
import { toLocal } from '../../lib/time'

const ACCOUNT: Record<string, unknown> = {
  id: 'fa_1',
  name: 'Dar Express',
  ownerUserId: 'user_42',
  driverSubAccountIds: ['r_1', 'r_2'],
  vehicles: ['v_1'],
  regions: ['dar', 'coast'],
  permissions: { dispatch: true, finance: false },
  status: 'active',
  createdAt: '2026-07-20T10:00:00.000Z',
}

const ACCOUNT_MIN: Record<string, unknown> = {
  id: 'fa_2',
  name: 'Arusha Cargo',
  status: 'suspended',
}

function seedList(rows: Array<Record<string, unknown>>) {
  server.use(http.get('/fleet/accounts', () => HttpResponse.json(rows)))
}

describe('FleetAccountsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads and renders fleet account rows with metadata', async () => {
    seedList([{ ...ACCOUNT }, { ...ACCOUNT_MIN }])
    render(<FleetAccountsPage />)

    expect(await screen.findByText('Dar Express')).toBeInTheDocument()
    expect(screen.getByText('Arusha Cargo')).toBeInTheDocument()

    const row = screen.getByText('Dar Express').closest('tr')!
    expect(within(row).getByText('user_42')).toBeInTheDocument()
    expect(within(row).getByText('2')).toBeInTheDocument()
    expect(within(row).getByText('1')).toBeInTheDocument()
    expect(within(row).getByText('dar')).toBeInTheDocument()
    expect(within(row).getByText('coast')).toBeInTheDocument()
    expect(within(row).getByText('active')).toBeInTheDocument()
    expect(within(row).getByText(toLocal(String(ACCOUNT.createdAt)))).toBeInTheDocument()

    const minRow = screen.getByText('Arusha Cargo').closest('tr')!
    expect(within(minRow).getByText('suspended')).toBeInTheDocument()
    expect(within(minRow).getAllByText('—').length).toBeGreaterThan(0)
  })

  it('filters rows by status chip with counts', async () => {
    seedList([{ ...ACCOUNT }, { ...ACCOUNT_MIN }])
    render(<FleetAccountsPage />)
    await screen.findByText('Dar Express')

    fireEvent.click(screen.getByRole('button', { name: /suspended/i }))
    await waitFor(() => expect(screen.queryByText('Dar Express')).not.toBeInTheDocument())
    expect(screen.getByText('Arusha Cargo')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^all/i }))
    await waitFor(() => expect(screen.getByText('Dar Express')).toBeInTheDocument())
    expect(screen.getByText('Arusha Cargo')).toBeInTheDocument()
  })

  it('shows an empty state when there are no fleet accounts', async () => {
    seedList([])
    render(<FleetAccountsPage />)
    expect(await screen.findByText('No fleet accounts')).toBeInTheDocument()
  })

  it('shows an error state and recovers via retry', async () => {
    server.use(
      http.get('/fleet/accounts', () => HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 })),
    )
    render(<FleetAccountsPage />)
    expect(await screen.findByText('Failed to load fleet accounts')).toBeInTheDocument()

    seedList([{ ...ACCOUNT }])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Dar Express')).toBeInTheDocument()
  })

  it('creates a fleet account, shows a toast and refetches the list', async () => {
    let posted: Record<string, unknown> = {}
    const rows: Array<Record<string, unknown>> = [{ ...ACCOUNT }]
    server.use(
      http.get('/fleet/accounts', () => HttpResponse.json(rows)),
      http.post('/fleet/accounts', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>
        const created = { ...ACCOUNT, id: 'fa_9', name: String(posted.name), status: 'active' }
        rows.push(created)
        return HttpResponse.json(created, { status: 201 })
      }),
    )
    render(<FleetAccountsPage />)
    await screen.findByText('Dar Express')

    fireEvent.click(screen.getByRole('button', { name: 'New account' }))
    const modal = await screen.findByRole('dialog', { name: 'New fleet account' })
    fireEvent.change(within(modal).getByLabelText('Name'), { target: { value: 'Dodoma Haul' } })
    fireEvent.change(within(modal).getByLabelText('Owner user ID'), { target: { value: 'user_7' } })
    fireEvent.change(within(modal).getByLabelText(/regions/i), { target: { value: 'dodoma, singida' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Create account' }))

    await waitFor(() => expect(String(posted.name)).toBe('Dodoma Haul'))
    expect(await screen.findByText('Fleet account created')).toBeInTheDocument()
    expect(await screen.findByText('Dodoma Haul')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens the drawer and updates an account with a toast and refetch', async () => {
    const rows: Array<Record<string, unknown>> = [{ ...ACCOUNT }]
    server.use(
      http.get('/fleet/accounts', () => HttpResponse.json(rows)),
      http.patch('/fleet/accounts/fa_1', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        const updated = { ...ACCOUNT, name: String(body.name), status: String(body.status) }
        rows[0] = updated
        return HttpResponse.json(updated)
      }),
    )
    render(<FleetAccountsPage />)
    await screen.findByText('Dar Express')

    fireEvent.click(screen.getByText('Dar Express'))
    const drawer = await screen.findByRole('dialog', { name: 'Dar Express' })
    expect(within(drawer).getByText('dispatch')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const modal = await screen.findByRole('dialog', { name: 'Edit fleet account' })
    fireEvent.change(within(modal).getByLabelText('Name'), { target: { value: 'Dar Express HQ' } })
    fireEvent.change(within(modal).getByLabelText('Status'), { target: { value: 'suspended' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Fleet account updated')).toBeInTheDocument()
    expect(await screen.findByRole('dialog', { name: 'Dar Express HQ' })).toBeInTheDocument()
    expect(await screen.findAllByText('Dar Express HQ')).toHaveLength(3)
    expect(screen.getAllByText('suspended').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByRole('dialog', { name: 'Edit fleet account' })).not.toBeInTheDocument()
  })

  it('shows an inline error when updating is forbidden', async () => {
    seedList([{ ...ACCOUNT }])
    server.use(
      http.patch('/fleet/accounts/fa_1', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<FleetAccountsPage />)
    await screen.findByText('Dar Express')

    fireEvent.click(screen.getByText('Dar Express'))
    await screen.findByRole('dialog', { name: 'Dar Express' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const modal = await screen.findByRole('dialog', { name: 'Edit fleet account' })
    fireEvent.click(within(modal).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Edit fleet account' })).toBeInTheDocument()
    expect(screen.queryByText('Fleet account updated')).not.toBeInTheDocument()
  })

  it('sorts rows by name via the column header', async () => {
    seedList([{ ...ACCOUNT }, { ...ACCOUNT_MIN }])
    render(<FleetAccountsPage />)
    await screen.findByText('Dar Express')

    fireEvent.click(screen.getByRole('button', { name: /Name/ }))

    const table = screen.getByRole('table', { name: 'Fleet accounts' })
    const names = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(names).toEqual(['Arusha Cargo', 'Dar Express'])

    fireEvent.click(screen.getByRole('button', { name: /Name/ }))
    const desc = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(desc).toEqual(['Dar Express', 'Arusha Cargo'])
  })

  it('exports fleet accounts as CSV via the DataTable', async () => {
    seedList([{ ...ACCOUNT }, { ...ACCOUNT_MIN }])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let downloadName = ''
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadName = this.download
      })
    render(<FleetAccountsPage />)
    await screen.findByText('Dar Express')

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(downloadName).toBe('fleet-accounts.csv')
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Name,Owner,Driver sub-accounts,Vehicles,Regions,Status,Created')
    expect(csv).toContain('Dar Express')
    expect(csv).toContain('user_42')
    expect(csv).toContain(',2,1,')
    expect(revokeObjectURL).toHaveBeenCalled()
  })
})
