import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { DataExportsPage } from './DataExportsPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const JOB = {
  id: 'exp_1',
  scope: 'orders',
  format: 'csv',
  status: 'ready',
  downloadUrl: 'https://cdn.example.com/exports/exp_1.csv',
  expiresInSeconds: 3600,
  createdAt: '2026-08-10T09:30:00.000Z',
  completedAt: '2026-08-10T09:31:00.000Z',
}

const QUEUED_JOB = {
  id: 'exp_2',
  scope: 'customers',
  format: 'xlsx',
  status: 'queued',
  downloadUrl: null,
  expiresInSeconds: null,
  createdAt: '2026-08-10T09:32:00.000Z',
  completedAt: null,
}

function seedJobs(jobs: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/data-exports', () => HttpResponse.json(jobs)))
}

describe('DataExportsPage', () => {
  it('renders loading skeleton then rows after data loads', async () => {
    seedJobs([{ ...JOB }, { ...QUEUED_JOB }])
    render(<DataExportsPage />)

    expect(await screen.findByText('exp_1')).toBeInTheDocument()
    expect(screen.getByText('exp_2')).toBeInTheDocument()
    expect(screen.getByText('orders')).toBeInTheDocument()
    expect(screen.getByText('customers')).toBeInTheDocument()
  })

  it('filters rows by status chip', async () => {
    seedJobs([{ ...JOB }, { ...QUEUED_JOB }])
    render(<DataExportsPage />)

    await screen.findByText('exp_1')
    fireEvent.click(screen.getByRole('button', { name: /Ready/ }))

    expect(screen.getByText('exp_1')).toBeInTheDocument()
    expect(screen.queryByText('exp_2')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Queued/ }))

    expect(screen.getByText('exp_2')).toBeInTheDocument()
    expect(screen.queryByText('exp_1')).not.toBeInTheDocument()
  })

  it('shows the empty state when there are no export jobs', async () => {
    seedJobs([])
    render(<DataExportsPage />)

    expect(await screen.findByText('No export jobs')).toBeInTheDocument()
  })

  it('sorts jobs by created date via the column header', async () => {
    seedJobs([{ ...QUEUED_JOB }, { ...JOB }])
    render(<DataExportsPage />)
    await screen.findByText('exp_1')

    const header = screen.getByRole('button', { name: /Created/ })
    fireEvent.click(header)

    const table = screen.getByRole('table', { name: 'Data export jobs' })
    const ids = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(ids).toEqual(['exp_1', 'exp_2'])

    fireEvent.click(header)
    const idsDesc = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(idsDesc).toEqual(['exp_2', 'exp_1'])
  })

  it('shows an error and recovers via Retry', async () => {
    server.use(
      http.get('/admin/data-exports', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'export role required' }, { status: 403 }),
      ),
    )
    render(<DataExportsPage />)

    expect(await screen.findByText('Failed to load data exports')).toBeInTheDocument()
    expect(screen.getByText('export role required')).toBeInTheDocument()

    seedJobs([{ ...JOB }])
    fireEvent.click(screen.getByText('Retry'))

    expect(await screen.findByText('exp_1')).toBeInTheDocument()
  })

  it('queues a report through the modal and shows a toast', async () => {
    seedJobs([])
    render(<DataExportsPage />)
    await screen.findByText('No export jobs')

    let postedBody: unknown = null
    server.use(
      http.post('/admin/reports', async ({ request }) => {
        postedBody = await request.json()
        return HttpResponse.json({ reportId: 'rep_1', status: 'queued' }, { status: 202 })
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'New report' }))
    const modal = screen.getByRole('dialog', { name: 'New report' })
    fireEvent.change(within(modal).getByLabelText('Name'), { target: { value: 'Q3 growth' } })
    fireEvent.change(within(modal).getByLabelText(/Metrics/), { target: { value: 'orders, revenueTZS' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Queue report' }))

    await waitFor(() => {
      expect(postedBody).toEqual({
        name: 'Q3 growth',
        metrics: ['orders', 'revenueTZS'],
        format: 'csv',
        schedule: 'none',
      })
    })
    expect(await screen.findByText('Report Q3 growth queued')).toBeInTheDocument()
  })

  it('renders a download link for ready jobs with a download URL', async () => {
    seedJobs([{ ...JOB }, { ...QUEUED_JOB }])
    render(<DataExportsPage />)

    await screen.findByText('exp_1')
    const link = screen.getByRole('link', { name: 'Download' })
    expect(link).toHaveAttribute('href', 'https://cdn.example.com/exports/exp_1.csv')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('shows Approve/Reject for queued jobs and Re-run for failed jobs', async () => {
    seedJobs([
      { ...QUEUED_JOB },
      { ...JOB, id: 'exp_3', status: 'failed', downloadUrl: null, completedAt: '2026-08-10T10:00:00.000Z' },
    ])
    render(<DataExportsPage />)
    await screen.findByText('exp_2')

    fireEvent.click(screen.getByText('exp_2'))
    let drawer = await screen.findByRole('dialog', { name: 'Export job' })
    expect(within(drawer).getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: 'Reject' })).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Re-run' })).not.toBeInTheDocument()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }))

    fireEvent.click(screen.getByText('exp_3'))
    drawer = await screen.findByRole('dialog', { name: 'Export job' })
    expect(within(drawer).getByRole('button', { name: 'Re-run' })).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
  })

  it('hides approval actions without export.approve permission', async () => {
    seedStaffSession({ permissions: ['export.request'] })
    seedJobs([{ ...QUEUED_JOB }])
    render(<DataExportsPage />)
    fireEvent.click(await screen.findByText('exp_2'))
    const drawer = await screen.findByRole('dialog', { name: 'Export job' })
    expect(within(drawer).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
  })

  it('approving a queued job via the live endpoint and shows success', async () => {
    seedJobs([{ ...QUEUED_JOB }])
    render(<DataExportsPage />)
    fireEvent.click(await screen.findByText('exp_2'))
    const drawer = await screen.findByRole('dialog', { name: 'Export job' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Approve' }))

    const prompt = screen.getByRole('dialog', { name: 'Approve export' })
    fireEvent.change(prompt.querySelector('textarea')!, { target: { value: 'Compliance reviewed' } })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Export approved')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Approve export' })).not.toBeInTheDocument()
    expect(screen.queryByText('PENDING_ENDPOINT')).not.toBeInTheDocument()
  })

  it('shows an error when export approval fails', async () => {
    seedJobs([{ ...QUEUED_JOB }])
    server.use(http.post('/admin/data-exports/:jobId/approval', async () => HttpResponse.json({ code: 'DATA_EXPORT_ALREADY_DECIDED', message: 'already decided', requestId: 'req_exp' }, { status: 409 })))
    render(<DataExportsPage />)
    fireEvent.click(await screen.findByText('exp_2'))
    const drawer = await screen.findByRole('dialog', { name: 'Export job' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Approve' }))

    const prompt = screen.getByRole('dialog', { name: 'Approve export' })
    fireEvent.change(prompt.querySelector('textarea')!, { target: { value: 'Try again' } })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }))

    expect(await within(prompt).findByText(/already decided/i)).toBeInTheDocument()
    expect(within(prompt).getByText(/req_exp/)).toBeInTheDocument()
  })

  it('re-running a failed job via the live endpoint and shows success', async () => {
    seedJobs([{ ...JOB, id: 'exp_3', status: 'failed', downloadUrl: null, completedAt: null }])
    render(<DataExportsPage />)
    fireEvent.click(await screen.findByText('exp_3'))
    const drawer = await screen.findByRole('dialog', { name: 'Export job' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Re-run' }))

    const prompt = screen.getByRole('dialog', { name: 'Re-run export' })
    fireEvent.change(prompt.querySelector('textarea')!, { target: { value: 'Retry after outage' } })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Export re-queued')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Re-run export' })).not.toBeInTheDocument()
    expect(screen.queryByText('PENDING_ENDPOINT')).not.toBeInTheDocument()
  })
})
