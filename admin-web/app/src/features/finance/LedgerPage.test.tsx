import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'
import { LedgerPage } from './LedgerPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

async function fillForm(userId = 'usr_1', delta = '15000', reason = 'Compensation for failed delivery') {
  await userEvent.type(screen.getByLabelText(/user id/i), userId)
  await userEvent.type(screen.getByLabelText(/delta/i), delta)
  await userEvent.type(screen.getByLabelText(/^reason$/i), reason)
}

describe('LedgerPage', () => {
  it('renders the form with the audit hint in idle state', () => {
    render(<LedgerPage />)

    expect(screen.getByText('Ledger adjustment')).toBeInTheDocument()
    expect(screen.getByText(/Ledger adjustments are audited/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Adjust wallet' })).toBeInTheDocument()
  })

  it('submits a positive adjustment and shows the resulting wallet totals', async () => {
    let body: Record<string, unknown> | null = null
    server.use(
      http.post('/admin/wallets/usr_1/adjust', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ withdrawableTZS: 115000, pendingTZS: 5000, totalTZS: 120000 })
      }),
    )
    render(<LedgerPage />)

    await fillForm()
    await userEvent.click(screen.getByRole('button', { name: 'Adjust wallet' }))

    expect(await screen.findByText(/Withdrawable TZS 115,000/)).toBeInTheDocument()
    expect(screen.getByText(/pending TZS 5,000/)).toBeInTheDocument()
    expect(screen.getByText(/total TZS 120,000/)).toBeInTheDocument()
    expect(body).toEqual({ deltaTZS: 15000, reason: 'Compensation for failed delivery' })
    expect(screen.getByLabelText(/user id/i)).toHaveValue('')
    expect(screen.getByLabelText(/delta/i)).toHaveValue(null)
    expect(screen.getByLabelText(/^reason$/i)).toHaveValue('')
  })

  it('submits a negative adjustment (debit)', async () => {
    server.use(
      http.post('/admin/wallets/usr_2/adjust', () =>
        HttpResponse.json({ withdrawableTZS: 45000, totalTZS: 45000 }),
      ),
    )
    render(<LedgerPage />)

    await fillForm('usr_2', '-5000', 'Chargeback recovery')
    await userEvent.click(screen.getByRole('button', { name: 'Adjust wallet' }))

    expect(await screen.findByText(/Withdrawable TZS 45,000/)).toBeInTheDocument()
  })

  it('shows an inline error when the adjustment is forbidden', async () => {
    server.use(
      http.post('/admin/wallets/usr_1/adjust', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<LedgerPage />)

    await fillForm()
    await userEvent.click(screen.getByRole('button', { name: 'Adjust wallet' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.queryByText(/Adjusted/)).not.toBeInTheDocument()
  })

  it('routes large adjustments through two-person approval', async () => {
    let approvalBody: Record<string, unknown> | null = null
    server.use(
      http.post('/admin/two-person-approvals', async ({ request }) => {
        approvalBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ id: 'apr_2' }, { status: 201 })
      }),
    )
    render(<LedgerPage />)

    await userEvent.type(screen.getByLabelText(/user id/i), 'usr_1')
    await userEvent.type(screen.getByLabelText(/delta/i), '2000000')
    await userEvent.type(screen.getByLabelText(/^reason$/i), 'Large credit needs a second admin')
    await userEvent.click(screen.getByRole('button', { name: 'Initiate approval' }))

    const modal = screen.getByRole('dialog', { name: 'Initiate ledger approval' })
    expect(within(modal).getByDisplayValue('TZS 2,000,000')).toBeInTheDocument()
    await userEvent.type(within(modal).getByLabelText('Reason'), 'Large credit needs a second admin')
    await userEvent.click(within(modal).getByRole('button', { name: 'Request approval' }))

    expect(await screen.findByText('Approval request created — pending a second admin')).toBeInTheDocument()
    expect(approvalBody).toMatchObject({
      actionType: 'modify_ledger',
      targetType: 'wallet',
      targetId: 'usr_1',
      reason: 'Large credit needs a second admin',
      payload: { deltaTZS: 2000000 },
    })
    expect(screen.getByLabelText(/user id/i)).toHaveValue('')
    expect(screen.getByLabelText(/delta/i)).toHaveValue(null)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps the direct adjustment path below the threshold', async () => {
    let approvalCalls = 0
    server.use(
      http.post('/admin/wallets/usr_1/adjust', () =>
        HttpResponse.json({ withdrawableTZS: 50000, totalTZS: 50000 }),
      ),
      http.post('/admin/two-person-approvals', () => {
        approvalCalls++
        return HttpResponse.json({}, { status: 201 })
      }),
    )
    render(<LedgerPage />)

    await fillForm('usr_1', '500000')
    await userEvent.click(screen.getByRole('button', { name: 'Adjust wallet' }))

    expect(await screen.findByText(/Withdrawable TZS 50,000/)).toBeInTheDocument()
    expect(approvalCalls).toBe(0)
  })

  it('does not submit an empty form', async () => {
    let calls = 0
    server.use(
      http.post('/admin/wallets/usr_1/adjust', () => {
        calls++
        return HttpResponse.json({ withdrawableTZS: 0, totalTZS: 0 })
      }),
    )
    render(<LedgerPage />)

    await userEvent.click(screen.getByRole('button', { name: 'Adjust wallet' }))

    expect(calls).toBe(0)
    expect(screen.queryByText(/Adjusted/)).not.toBeInTheDocument()
  })

  it('replaces the adjustment form with a muted note without finance.payout_adjust', () => {
    seedStaffSession({ permissions: ['audit.read'] })
    render(<LedgerPage />)

    expect(screen.queryByRole('button', { name: 'Adjust wallet' })).not.toBeInTheDocument()
    expect(
      screen.getByText('Wallet adjustments require the finance.payout_adjust permission'),
    ).toBeInTheDocument()
  })
})
