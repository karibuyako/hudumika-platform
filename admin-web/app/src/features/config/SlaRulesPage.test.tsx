import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { SlaRulesPage } from './SlaRulesPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const RULE: Record<string, unknown> = {
  id: 'sla_1',
  scope: 'support_ticket',
  responseMinutes: 60,
  resolutionMinutes: 1440,
  alertBeforeMinutes: 15,
  active: true,
}

function seedRules(rules: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/sla-rules', () => HttpResponse.json(rules)))
}

describe('SlaRulesPage', () => {
  it('shows a loading skeleton, then renders SLA rule rows', async () => {
    seedRules([
      RULE,
      { id: 'sla_2', scope: 'refund', responseMinutes: 30, resolutionMinutes: 720, active: false },
    ])
    render(<SlaRulesPage />)

    expect(screen.getByLabelText('Loading')).toBeInTheDocument()

    expect(await screen.findByText('support_ticket')).toBeInTheDocument()
    expect(screen.getByText('refund')).toBeInTheDocument()
    expect(screen.getByText('60')).toBeInTheDocument()
    expect(screen.getByText('1440')).toBeInTheDocument()
    expect(screen.getByText('15')).toBeInTheDocument()
    expect(screen.getAllByText('Active')).toHaveLength(2)
    expect(screen.getAllByText('Inactive')).toHaveLength(1)
    expect(screen.getAllByText('—')).toHaveLength(1)
    expect(screen.getByText(/control tower/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument()
  })

  it('shows the empty state when no rules exist', async () => {
    seedRules([])
    render(<SlaRulesPage />)
    expect(await screen.findByText('No SLA rules')).toBeInTheDocument()
  })

  it('shows an error state and recovers on retry', async () => {
    let calls = 0
    server.use(
      http.get('/admin/sla-rules', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'SERVICE_DOWN', message: 'down' }, { status: 500 })
        }
        return HttpResponse.json([RULE])
      }),
    )
    render(<SlaRulesPage />)

    expect(await screen.findByText('Failed to load SLA rules')).toBeInTheDocument()
    expect(screen.getByText('down')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('support_ticket')).toBeInTheDocument()
    expect(screen.queryByText('Failed to load SLA rules')).not.toBeInTheDocument()
  })

  it('edits a rule, PUTs the full rules array and refetches', async () => {
    const rules: Array<Record<string, unknown>> = [
      { ...RULE },
      { id: 'sla_2', scope: 'refund', responseMinutes: 30, resolutionMinutes: 720, active: false },
    ]
    let putBody: Record<string, unknown> | null = null
    server.use(
      http.get('/admin/sla-rules', () => HttpResponse.json(rules)),
      http.put('/admin/sla-rules', async ({ request }) => {
        putBody = (await request.json()) as Record<string, unknown>
        rules[0] = { ...RULE, responseMinutes: 90, resolutionMinutes: 2880, alertBeforeMinutes: undefined, active: false }
        return HttpResponse.json(rules)
      }),
    )
    render(<SlaRulesPage />)
    await screen.findByText('support_ticket')

    fireEvent.click(screen.getByText('support_ticket'))
    const drawer = await screen.findByRole('dialog', { name: 'support_ticket' })
    expect(within(drawer).getByText('1440')).toBeInTheDocument()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit rule' }))

    const modal = await screen.findByRole('dialog', { name: 'Edit SLA rule' })
    fireEvent.change(within(modal).getByLabelText('Response minutes'), { target: { value: '90' } })
    fireEvent.change(within(modal).getByLabelText('Resolution minutes'), { target: { value: '2880' } })
    fireEvent.change(within(modal).getByLabelText('Alert before minutes'), { target: { value: '' } })
    fireEvent.change(within(modal).getByLabelText('Active'), { target: { value: 'no' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('SLA rules saved')).toBeInTheDocument()
    expect(putBody).toEqual({
      rules: [
        { id: 'sla_1', scope: 'support_ticket', responseMinutes: 90, resolutionMinutes: 2880, active: false },
        { id: 'sla_2', scope: 'refund', responseMinutes: 30, resolutionMinutes: 720, active: false },
      ],
    })
    expect(await screen.findByText('90')).toBeInTheDocument()
    expect(screen.queryByText('15')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows an inline error when saving is forbidden', async () => {
    seedRules([{ ...RULE }])
    server.use(
      http.put('/admin/sla-rules', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<SlaRulesPage />)
    await screen.findByText('support_ticket')

    fireEvent.click(screen.getByText('support_ticket'))
    const drawer = await screen.findByRole('dialog', { name: 'support_ticket' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit rule' }))

    const modal = await screen.findByRole('dialog', { name: 'Edit SLA rule' })
    fireEvent.change(within(modal).getByLabelText('Response minutes'), { target: { value: '120' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Edit SLA rule' })).toBeInTheDocument()
    expect(screen.queryByText('SLA rules saved')).not.toBeInTheDocument()
    expect(screen.getAllByText('support_ticket').length).toBeGreaterThan(0)
  })

  it('hides the Edit rule button when configuration.edit is not granted', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seedRules([{ ...RULE }])
    render(<SlaRulesPage />)
    await screen.findByText('support_ticket')

    fireEvent.click(screen.getByText('support_ticket'))
    const drawer = await screen.findByRole('dialog', { name: 'support_ticket' })
    expect(within(drawer).queryByRole('button', { name: 'Edit rule' })).not.toBeInTheDocument()
  })
})
