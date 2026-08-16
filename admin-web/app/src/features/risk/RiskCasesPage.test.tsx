import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'
import { toLocal } from '../../lib/time'
import type { RiskCase } from '@hudumika/contract'
import { RiskCasesPage } from './RiskCasesPage'

const CASES: RiskCase[] = [
  {
    id: 'case-1',
    severity: 'critical',
    signals: ['velocity_spike', 'new_device', 'geo_mismatch', 'chargeback'],
    related: { customerUserId: 'cus-123456789', riderId: 'rid-1', orderIds: ['ord-1', 'ord-2'] },
    status: 'open',
    createdAt: '2026-08-01T10:00:00Z',
  },
  {
    id: 'case-2',
    severity: 'low',
    signals: ['unusual_hour'],
    status: 'resolved',
    decidedAction: 'dismiss',
    reason: 'Benign pattern',
    createdAt: '2026-08-02T10:00:00Z',
  },
]

describe('RiskCasesPage', () => {
  it('sorts by severity ranking via the column header', async () => {
    server.use(http.get('*/admin/risk/cases', () => HttpResponse.json([CASES[0], CASES[1]])))
    render(<RiskCasesPage />)
    await screen.findByText('case-1')

    const header = screen.getByRole('button', { name: /Severity/ })
    await userEvent.click(header)

    const table = screen.getByRole('table', { name: 'Risk cases' })
    const ids = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(ids).toEqual(['case-2', 'case-1'])

    await userEvent.click(header)
    const idsDesc = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(idsDesc).toEqual(['case-1', 'case-2'])
  })

  it('exports the visible risk cases as CSV', async () => {
    server.use(http.get('*/admin/risk/cases', () => HttpResponse.json(CASES)))
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<RiskCasesPage />)
    await screen.findByText('case-1')

    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(anchorClick).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('ID,Severity,Status,Signals,Related,Created')
    expect(csv).toContain('case-1')
    expect(csv).toContain('2 orders')
    expect(revokeObjectURL).toHaveBeenCalled()
  })

  it('shows rows after loading', async () => {
    server.use(http.get('*/admin/risk/cases', () => HttpResponse.json(CASES)))
    render(<RiskCasesPage />)

    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
    expect(await screen.findByText('case-1')).toBeInTheDocument()
    expect(screen.getByText('case-2')).toBeInTheDocument()
    expect(screen.getByText('velocity_spike')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText(/2 orders/)).toBeInTheDocument()
    expect(screen.getByText(toLocal('2026-08-01T10:00:00Z'))).toBeInTheDocument()
  })

  it('refetches with both status and severity params when chips change', async () => {
    const urls: string[] = []
    server.use(
      http.get('*/admin/risk/cases', ({ request }) => {
        urls.push(request.url)
        return HttpResponse.json(CASES)
      }),
    )
    render(<RiskCasesPage />)
    await screen.findByText('case-1')

    const statusGroup = screen.getByRole('group', { name: 'Risk status filters' })
    const severityGroup = screen.getByRole('group', { name: 'Risk severity filters' })

    await userEvent.click(within(statusGroup).getByRole('button', { name: /investigating/ }))
    await userEvent.click(within(severityGroup).getByRole('button', { name: /high/ }))

    await waitFor(() => {
      const last = urls[urls.length - 1]
      expect(last).toContain('status=investigating')
      expect(last).toContain('severity=high')
    })
    expect(urls.length).toBeGreaterThanOrEqual(3)
  })

  it('shows the empty state when no cases exist', async () => {
    server.use(http.get('*/admin/risk/cases', () => HttpResponse.json([])))
    render(<RiskCasesPage />)

    expect(await screen.findByText('No risk cases')).toBeInTheDocument()
  })

  it('shows an error state and retries', async () => {
    let calls = 0
    server.use(
      http.get('*/admin/risk/cases', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'FORBIDDEN', message: 'nope', requestId: 'r-1' }, { status: 403 })
        }
        return HttpResponse.json(CASES)
      }),
    )
    render(<RiskCasesPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load risk cases')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('case-1')).toBeInTheDocument()
  })

  it('escalates a case, posts the action, shows a toast and refetches', async () => {
    let getCalls = 0
    let postedBody: unknown = null
    server.use(
      http.get('*/admin/risk/cases', () => {
        getCalls += 1
        return HttpResponse.json(CASES)
      }),
      http.post('*/admin/risk/cases/:caseId/review', async ({ request }) => {
        postedBody = await request.json()
        return HttpResponse.json({ ...CASES[0], decidedAction: 'escalate' })
      }),
    )
    render(<RiskCasesPage />)

    await userEvent.click(await screen.findByText('case-1'))
    await userEvent.click(screen.getByRole('button', { name: 'Escalate' }))
    await userEvent.type(screen.getByRole('textbox'), 'Escalating for senior review')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(postedBody).toEqual({ action: 'escalate', reason: 'Escalating for senior review' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/escalated/)
    await waitFor(() => expect(getCalls).toBeGreaterThanOrEqual(2))
  })

  it('shows a 403 denial inline in the prompt', async () => {
    server.use(
      http.get('*/admin/risk/cases', () => HttpResponse.json([CASES[0]])),
      http.post('*/admin/risk/cases/:caseId/review', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'Blocks require the risk.block permission', requestId: 'r-9' },
          { status: 403 },
        ),
      ),
    )
    render(<RiskCasesPage />)

    await userEvent.click(await screen.findByText('case-1'))
    await userEvent.click(screen.getByRole('button', { name: 'Block user' }))
    await userEvent.type(screen.getByRole('textbox'), 'fraud patterns')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Blocks require the risk.block permission')
  })

  it('shows no action buttons for a terminal case', async () => {
    server.use(http.get('*/admin/risk/cases', () => HttpResponse.json([CASES[1]])))
    render(<RiskCasesPage />)

    await userEvent.click(await screen.findByText('case-2'))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('dismiss')).toBeInTheDocument()
    expect(within(dialog).getByText('Benign pattern')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Block user' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Block provider' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Escalate' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Hold' })).not.toBeInTheDocument()
  })

  it('gates drawer actions behind risk.investigate and block actions behind risk.block', async () => {
    server.use(http.get('*/admin/risk/cases', () => HttpResponse.json([CASES[0]])))

    seedStaffSession({ permissions: ['audit.read'] })
    render(<RiskCasesPage />)
    await userEvent.click(await screen.findByText('case-1'))

    let dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Case review requires risk.investigate')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Block user' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Block provider' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Escalate' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Hold' })).not.toBeInTheDocument()

    cleanup()
    seedStaffSession({ permissions: ['risk.investigate'] })
    render(<RiskCasesPage />)
    await userEvent.click(await screen.findByText('case-1'))

    dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Block user' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Block provider' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Escalate' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Hold' })).toBeInTheDocument()
  })

  it('renders the severity by status matrix with correct counts', async () => {
    server.use(http.get('*/admin/risk/cases', () => HttpResponse.json(CASES)))
    render(<RiskCasesPage />)
    await screen.findByText('case-1')

    const table = screen.getByRole('table', { name: 'Risk cases by severity and status' })
    const criticalRow = within(table).getByRole('row', { name: /critical/ })
    const lowRow = within(table).getByRole('row', { name: /low/ })

    expect(within(criticalRow).getByRole('button', { name: 'critical open cases' })).toHaveTextContent('1')
    expect(within(criticalRow).getByRole('button', { name: 'critical investigating cases' })).toHaveTextContent('0')
    expect(within(criticalRow).getByRole('button', { name: 'critical resolved cases' })).toHaveTextContent('0')
    expect(within(criticalRow).getByRole('button', { name: 'critical dismissed cases' })).toHaveTextContent('0')
    expect(within(criticalRow).getByRole('cell', { name: 'critical total cases' })).toHaveTextContent('1')

    expect(within(lowRow).getByRole('button', { name: 'low open cases' })).toHaveTextContent('0')
    expect(within(lowRow).getByRole('button', { name: 'low resolved cases' })).toHaveTextContent('1')
    expect(within(lowRow).getByRole('cell', { name: 'low total cases' })).toHaveTextContent('1')

    const highRow = within(table).getByRole('row', { name: /high/ })
    const mediumRow = within(table).getByRole('row', { name: /medium/ })
    expect(within(highRow).getByRole('button', { name: 'high open cases' })).toHaveTextContent('0')
    expect(within(mediumRow).getByRole('button', { name: 'medium investigating cases' })).toHaveTextContent('0')
  })

  it('highlights the critical open and high open matrix cells', async () => {
    server.use(http.get('*/admin/risk/cases', () => HttpResponse.json(CASES)))
    render(<RiskCasesPage />)
    await screen.findByText('case-1')

    const table = screen.getByRole('table', { name: 'Risk cases by severity and status' })
    const criticalOpen = within(table).getByRole('button', { name: 'critical open cases' })
    const highOpen = within(table).getByRole('button', { name: 'high open cases' })
    const lowResolved = within(table).getByRole('button', { name: 'low resolved cases' })

    expect(criticalOpen).toHaveClass('tag bad')
    expect(highOpen).toHaveClass('tag warn')
    expect(lowResolved).toHaveClass('tag')
  })

  it('filters the table when a matrix cell is clicked', async () => {
    server.use(
      http.get('*/admin/risk/cases', ({ request }) => {
        const url = new URL(request.url)
        const status = url.searchParams.get('status')
        const severity = url.searchParams.get('severity')
        return HttpResponse.json(
          CASES.filter(
            (c) => (status === null || c.status === status) && (severity === null || c.severity === severity),
          ),
        )
      }),
    )
    render(<RiskCasesPage />)
    await screen.findByText('case-1')

    const table = screen.getByRole('table', { name: 'Risk cases by severity and status' })
    await userEvent.click(within(table).getByRole('button', { name: 'critical open cases' }))

    await waitFor(() => expect(screen.queryByText('case-2')).not.toBeInTheDocument())
    expect(screen.getByText('case-1')).toBeInTheDocument()

    const statusGroup = screen.getByRole('group', { name: 'Risk status filters' })
    const severityGroup = screen.getByRole('group', { name: 'Risk severity filters' })
    expect(within(statusGroup).getByRole('button', { name: /^open/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(severityGroup).getByRole('button', { name: /^critical/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows the per-entity audit trail in the drawer', async () => {
    const AUDIT_ENTRIES = [
      {
        id: 'aud_1',
        actorUserId: 'usr_81',
        actorRole: 'admin',
        action: 'risk_case.escalated',
        entityType: 'risk_case',
        entityId: 'case-1',
        details: { reason: 'Senior review' },
        ipAddress: '10.0.0.19',
        at: '2026-08-08T08:00:00.000Z',
        requestId: 'req_k1',
      },
      {
        id: 'aud_2',
        actorUserId: 'usr_82',
        action: 'risk_case.resolved',
        entityType: 'risk_case',
        entityId: 'case-1',
        at: '2026-08-09T08:00:00.000Z',
        requestId: 'req_k2',
      },
    ]
    server.use(
      http.get('*/admin/risk/cases', () => HttpResponse.json([CASES[0]])),
      http.get('*/admin/audit-logs', () => HttpResponse.json(AUDIT_ENTRIES)),
    )
    render(<RiskCasesPage />)

    await userEvent.click(await screen.findByText('case-1'))
    const dialog = await screen.findByRole('dialog')

    expect(await within(dialog).findByText('risk case.resolved')).toBeInTheDocument()
    expect(within(dialog).getByText('risk case.escalated')).toBeInTheDocument()
    expect(within(dialog).getByText('usr_81')).toBeInTheDocument()
  })

  it('shows no audit entries when the trail is empty', async () => {
    server.use(
      http.get('*/admin/risk/cases', () => HttpResponse.json([CASES[0]])),
      http.get('*/admin/audit-logs', () => HttpResponse.json([])),
    )
    render(<RiskCasesPage />)

    await userEvent.click(await screen.findByText('case-1'))
    await screen.findByRole('dialog')

    expect(await screen.findByText('No audit entries for this entity')).toBeInTheDocument()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
