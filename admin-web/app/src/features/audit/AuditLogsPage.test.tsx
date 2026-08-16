import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { AuditLogsPage } from './AuditLogsPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const LOG = {
  id: 'log_1',
  actorUserId: 'usr_1',
  actorRole: 'admin',
  action: 'order.status_update',
  entityType: 'order',
  entityId: 'ord_1',
  details: { changedFrom: 'paid', changedTo: 'preparing' },
  ipAddress: '10.0.0.1',
  at: '2026-08-10T09:30:00.000Z',
  requestId: 'req_1',
}

function seedLogs(logs: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/audit-logs', () => HttpResponse.json(logs)))
}

function entityTypeInput() {
  return screen.getByLabelText('Filter by entity type')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AuditLogsPage', () => {
  it('renders loading skeleton then rows after data loads', async () => {
    seedLogs([{ ...LOG }])
    render(<AuditLogsPage />)

    expect(await screen.findByText('order.status_update')).toBeInTheDocument()
    expect(screen.getByText('order')).toBeInTheDocument()
    expect(screen.getByText('usr_1')).toBeInTheDocument()
    expect(screen.getByText('10.0.0.1')).toBeInTheDocument()
    expect(screen.getByText('req_1')).toBeInTheDocument()
  })

  it('applies the entityType filter on submit and refetches with query params', async () => {
    seedLogs([{ ...LOG }])
    let lastUrl = ''
    server.use(
      http.get('/admin/audit-logs', ({ request }) => {
        lastUrl = request.url
        return HttpResponse.json([{ ...LOG, id: 'log_2', entityType: 'order', requestId: 'req_2' }])
      }),
    )
    render(<AuditLogsPage />)

    await screen.findByText('order.status_update')
    fireEvent.change(entityTypeInput(), { target: { value: 'order' } })
    fireEvent.submit(entityTypeInput().closest('form')!)

    await waitFor(() => {
      const url = new URL(lastUrl)
      expect(url.searchParams.get('entityType')).toBe('order')
    })
    expect(await screen.findByText('req_2')).toBeInTheDocument()
    expect(screen.queryByText('req_1')).not.toBeInTheDocument()
  })

  it('clear filters resets back to all entries', async () => {
    let entityTypeParam: string | null = null
    server.use(
      http.get('/admin/audit-logs', ({ request }) => {
        entityTypeParam = new URL(request.url).searchParams.get('entityType')
        return HttpResponse.json(entityTypeParam ? [{ ...LOG, id: 'log_2', requestId: 'req_2' }] : [{ ...LOG }])
      }),
    )
    render(<AuditLogsPage />)

    await screen.findByText('order.status_update')
    fireEvent.change(entityTypeInput(), { target: { value: 'order' } })
    fireEvent.submit(entityTypeInput().closest('form')!)

    await waitFor(() => expect(entityTypeParam).toBe('order'))
    await screen.findByText('req_2')

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))

    await waitFor(() => expect(entityTypeParam).toBeNull())
    expect(await screen.findByText('req_1')).toBeInTheDocument()
    expect(screen.queryByText('req_2')).not.toBeInTheDocument()
  })

  it('shows the empty state when there are no audit entries', async () => {
    seedLogs([])
    render(<AuditLogsPage />)

    expect(await screen.findByText('No audit entries')).toBeInTheDocument()
  })

  it('shows an error with request id and recovers via Retry', async () => {
    server.use(
      http.get('/admin/audit-logs', () =>
        HttpResponse.json({ code: 'INTERNAL', message: 'audit store down', requestId: 'err_req_1' }, { status: 500 }),
      ),
    )
    render(<AuditLogsPage />)

    expect(await screen.findByText('Failed to load audit logs')).toBeInTheDocument()
    expect(screen.getByText('audit store down')).toBeInTheDocument()
    expect(screen.getByText('err_req_1')).toBeInTheDocument()

    seedLogs([{ ...LOG }])
    fireEvent.click(screen.getByText('Retry'))

    expect(await screen.findByText('order.status_update')).toBeInTheDocument()
  })

  it('drawer shows the raw details JSON', async () => {
    seedLogs([{ ...LOG }])
    render(<AuditLogsPage />)

    await screen.findByText('order.status_update')
    fireEvent.click(screen.getByText('order.status_update'))
    await screen.findByRole('dialog')

    expect(screen.getByText(/"changedFrom": "paid"/)).toBeInTheDocument()
    expect(screen.getByText(/changedTo/)).toBeInTheDocument()
    expect(screen.getByText('Audit trail is immutable.')).toBeInTheDocument()
  })

  it('masks sensitive details values and reveals them with the unmask permission', async () => {
    seedStaffSession({ permissions: ['audit.unmask'] })
    seedLogs([{ ...LOG, details: { phone: '+255712345678', customerPhone: '0712 345 678' } }])
    render(<AuditLogsPage />)

    await screen.findByText('order.status_update')
    fireEvent.click(screen.getByText('order.status_update'))
    const drawer = await screen.findByRole('dialog')

    expect(within(drawer).getByText('+255 ••• 678')).toBeInTheDocument()
    expect(within(drawer).getByText('071 ••• 678')).toBeInTheDocument()

    fireEvent.click(within(drawer).getByRole('button', { name: 'Reveal details.phone' }))

    expect(within(drawer).getByText('+255712345678')).toBeInTheDocument()
    expect(within(drawer).queryByText('+255 ••• 678')).not.toBeInTheDocument()
    expect(within(drawer).getByText('071 ••• 678')).toBeInTheDocument()
  })

  it('masks the drawer ip address until revealed', async () => {
    seedLogs([{ ...LOG }])
    render(<AuditLogsPage />)

    await screen.findByText('order.status_update')
    fireEvent.click(screen.getByText('order.status_update'))
    const drawer = await screen.findByRole('dialog')

    expect(within(drawer).getByText('••••••••')).toBeInTheDocument()
    expect(within(drawer).queryByText('10.0.0.1')).not.toBeInTheDocument()

    fireEvent.click(within(drawer).getByRole('button', { name: 'Reveal IP address' }))
    expect(within(drawer).getByText('10.0.0.1')).toBeInTheDocument()
  })

  it('exports the visible rows as CSV via the DataTable and toasts the logged export', async () => {
    seedLogs([{ ...LOG }])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let downloadName = ''
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadName = this.download
      })
    render(<AuditLogsPage />)

    await screen.findByText('order.status_update')
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(screen.getByRole('status')).toHaveTextContent('Audit export downloaded — logged')
    expect(clickSpy).toHaveBeenCalled()
    expect(downloadName).toBe('audit-logs.csv')

    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('At,Action,Entity type,Entity ID,Actor,Role,IP address,Request ID')
    expect(csv).toContain(',,,,admin,,')
    expect(revokeObjectURL).toHaveBeenCalled()
  })

  it('sorts rows by timestamp via the At column header', async () => {
    seedLogs([
      { ...LOG, id: 'log_2', at: '2026-08-11T09:30:00.000Z', requestId: 'req_2' },
      { ...LOG, at: '2026-08-10T09:30:00.000Z' },
    ])
    render(<AuditLogsPage />)
    await screen.findByText('req_1')

    const header = screen.getByRole('button', { name: /At/ })
    fireEvent.click(header)

    const table = screen.getByRole('table', { name: 'Audit logs' })
    const ids = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('td')[7].textContent)
    expect(ids).toEqual(['req_1', 'req_2'])
  })

  it('hides the export button without export.request permission', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seedLogs([{ ...LOG }])
    render(<AuditLogsPage />)

    await screen.findByText('order.status_update')
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument()
  })

  it('filters to login activity via the preset chip with a count', async () => {
    seedLogs([
      { ...LOG, id: 'log_1', action: 'auth.login' },
      { ...LOG, id: 'log_2', action: 'order.status_update', requestId: 'req_2' },
    ])
    render(<AuditLogsPage />)

    await screen.findByText('auth.login')
    const loginChip = screen.getByRole('button', { name: /Login activity/ })
    expect(loginChip.querySelector('.chip-count')).toHaveTextContent('1')

    fireEvent.click(loginChip)

    expect(screen.getByText('auth.login')).toBeInTheDocument()
    expect(screen.queryByText('order.status_update')).not.toBeInTheDocument()
  })
})
