import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { CommissionRulesPage } from './CommissionRulesPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const RULE: Record<string, unknown> = {
  id: 'cm_1',
  scopeType: 'category',
  scopeId: null,
  rateBps: 250,
  active: true,
  updatedAt: '2026-08-02T10:00:00.000Z',
}

function seedRules(rules: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/commission-rules', () => HttpResponse.json(rules)))
}

describe('CommissionRulesPage', () => {
  it('shows a loading skeleton, then renders commission rule rows', async () => {
    seedRules([
      RULE,
      { id: 'cm_2', scopeType: 'merchant', scopeId: 'mch_1', rateBps: 100, active: false, updatedAt: '2026-08-01T10:00:00.000Z' },
    ])
    render(<CommissionRulesPage />)

    expect(screen.getByLabelText('Loading')).toBeInTheDocument()

    expect(await screen.findByText('category')).toBeInTheDocument()
    expect(screen.getByText('merchant')).toBeInTheDocument()
    expect(screen.getByText('mch_1')).toBeInTheDocument()
    expect(screen.getByText('250 bps (2.5%)')).toBeInTheDocument()
    expect(screen.getByText('100 bps (1%)')).toBeInTheDocument()
    expect(screen.getAllByText('Active')).toHaveLength(2)
    expect(screen.getAllByText('Inactive')).toHaveLength(1)
    expect(screen.getByText(/two-person approval/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument()
  })

  it('shows the empty state when no rules exist', async () => {
    seedRules([])
    render(<CommissionRulesPage />)
    expect(await screen.findByText('No commission rules')).toBeInTheDocument()
  })

  it('shows an error state and recovers on retry', async () => {
    let calls = 0
    server.use(
      http.get('/admin/commission-rules', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'SERVICE_DOWN', message: 'down' }, { status: 500 })
        }
        return HttpResponse.json([RULE])
      }),
    )
    render(<CommissionRulesPage />)

    expect(await screen.findByText('Failed to load commission rules')).toBeInTheDocument()
    expect(screen.getByText('down')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('category')).toBeInTheDocument()
    expect(screen.queryByText('Failed to load commission rules')).not.toBeInTheDocument()
  })

  it('routes commission edits through two-person approval', async () => {
    const rules: Array<Record<string, unknown>> = [
      { ...RULE },
      { id: 'cm_2', scopeType: 'merchant', scopeId: 'mch_1', rateBps: 100, active: false, updatedAt: '2026-08-01T10:00:00.000Z' },
    ]
    let approvalBody: Record<string, unknown> | null = null
    server.use(
      http.get('/admin/commission-rules', () => HttpResponse.json(rules)),
      http.post('/admin/two-person-approvals', async ({ request }) => {
        approvalBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ id: 'apr_4' }, { status: 201 })
      }),
    )
    render(<CommissionRulesPage />)
    await screen.findByText('category')

    fireEvent.click(screen.getByText('category'))
    const drawer = await screen.findByRole('dialog', { name: 'category default' })
    expect(within(drawer).getByText('250 bps (2.5%)')).toBeInTheDocument()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit rule' }))

    const modal = await screen.findByRole('dialog', { name: 'Edit commission rule' })
    expect(within(modal).getByText(/Commission changes require two-person approval/)).toBeInTheDocument()
    fireEvent.change(within(modal).getByLabelText('Scope ID'), { target: { value: 'cat_food' } })
    fireEvent.change(within(modal).getByLabelText(/Rate/), { target: { value: '300' } })
    fireEvent.change(within(modal).getByLabelText('Active'), { target: { value: 'no' } })
    fireEvent.change(within(modal).getByLabelText(/Reason/), { target: { value: 'Align category rates' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Save changes' }))

    expect(
      await screen.findByText('Commission change approval requested — pending a second admin'),
    ).toBeInTheDocument()
    expect(approvalBody).toMatchObject({
      actionType: 'change_commission',
      targetType: 'commission-rule',
      targetId: 'cm_1',
      reason: 'Align category rates',
      payload: {
        rules: [
          { id: 'cm_1', scopeType: 'category', scopeId: 'cat_food', rateBps: 300, active: false },
          { id: 'cm_2', scopeType: 'merchant', scopeId: 'mch_1', rateBps: 100, active: false, updatedAt: '2026-08-01T10:00:00.000Z' },
        ],
      },
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows an inline error when requesting a commission change is forbidden', async () => {
    seedRules([{ ...RULE }])
    server.use(
      http.post('/admin/two-person-approvals', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<CommissionRulesPage />)
    await screen.findByText('category')

    fireEvent.click(screen.getByText('category'))
    const drawer = await screen.findByRole('dialog', { name: 'category default' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit rule' }))

    const modal = await screen.findByRole('dialog', { name: 'Edit commission rule' })
    fireEvent.change(within(modal).getByLabelText(/Rate/), { target: { value: '400' } })
    fireEvent.change(within(modal).getByLabelText(/Reason/), { target: { value: 'Rate review' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Edit commission rule' })).toBeInTheDocument()
    expect(screen.queryByText('Commission change approval requested — pending a second admin')).not.toBeInTheDocument()
    expect(screen.getAllByText('category').length).toBeGreaterThan(0)
  })

  it('hides the Edit rule button when configuration.edit is not granted', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seedRules([{ ...RULE }])
    render(<CommissionRulesPage />)
    await screen.findByText('category')

    fireEvent.click(screen.getByText('category'))
    const drawer = await screen.findByRole('dialog', { name: 'category default' })
    expect(within(drawer).queryByRole('button', { name: 'Edit rule' })).not.toBeInTheDocument()
  })
})
