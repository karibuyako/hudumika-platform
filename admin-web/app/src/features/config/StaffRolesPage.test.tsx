import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { StaffRolesPage } from './StaffRolesPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const ROLE: Record<string, unknown> = {
  id: 'role_1',
  name: 'support_manager',
  description: 'Manages support tickets',
  permissions: ['tickets.read', 'tickets.manage', 'refunds.manage', 'audit.read'],
  system: true,
  createdAt: '2026-07-01T08:00:00.000Z',
}

function seedRoles(roles: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/staff-roles', () => HttpResponse.json(roles)))
}

describe('StaffRolesPage', () => {
  it('shows a loading skeleton, then renders role rows and a permissions drawer', async () => {
    seedRoles([ROLE, { id: 'role_2', name: 'rider_ops', permissions: ['orders.read'], system: false }])
    render(<StaffRolesPage />)

    expect(screen.getByLabelText('Loading')).toBeInTheDocument()

    expect(await screen.findByText('support_manager')).toBeInTheDocument()
    expect(screen.getByText('rider_ops')).toBeInTheDocument()
    expect(screen.getByText('Manages support tickets')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('tickets.read')).toBeInTheDocument()
    expect(screen.getByText('tickets.manage')).toBeInTheDocument()
    expect(screen.getByText('refunds.manage')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('system')).toBeInTheDocument()
    expect(screen.queryByText('audit.read')).not.toBeInTheDocument()
    expect(screen.getByText(/two-person approval/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('support_manager'))
    const drawer = await screen.findByRole('dialog', { name: 'support_manager' })
    expect(within(drawer).getByText('audit.read')).toBeInTheDocument()
    expect(within(drawer).getByText('Manages support tickets')).toBeInTheDocument()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the empty state when no roles exist', async () => {
    seedRoles([])
    render(<StaffRolesPage />)
    expect(await screen.findByText('No staff roles')).toBeInTheDocument()
  })

  it('shows an error state and recovers on retry', async () => {
    let calls = 0
    server.use(
      http.get('/admin/staff-roles', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'SERVICE_DOWN', message: 'down' }, { status: 500 })
        }
        return HttpResponse.json([ROLE])
      }),
    )
    render(<StaffRolesPage />)

    expect(await screen.findByText('Failed to load staff roles')).toBeInTheDocument()
    expect(screen.getByText('down')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('support_manager')).toBeInTheDocument()
    expect(screen.queryByText('Failed to load staff roles')).not.toBeInTheDocument()
  })

  it('routes role creation through two-person approval', async () => {
    const roles = [{ ...ROLE }]
    let approvalBody: Record<string, unknown> | null = null
    server.use(
      http.get('/admin/staff-roles', () => HttpResponse.json(roles)),
      http.post('/admin/two-person-approvals', async ({ request }) => {
        approvalBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ id: 'apr_5' }, { status: 201 })
      }),
    )
    render(<StaffRolesPage />)
    await screen.findByText('support_manager')

    fireEvent.click(screen.getByRole('button', { name: 'New role' }))
    const modal = await screen.findByRole('dialog')
    expect(within(modal).getByText(/IAM policy changes require two-person approval/)).toBeInTheDocument()
    fireEvent.change(within(modal).getByLabelText('Name'), { target: { value: 'finance_auditor' } })
    fireEvent.change(within(modal).getByLabelText('Description'), { target: { value: 'Audits finance flows' } })
    fireEvent.change(within(modal).getByLabelText(/Permissions/), {
      target: { value: 'ledger.read, ledger.manage, audit.read' },
    })
    fireEvent.change(within(modal).getByLabelText(/Reason/), { target: { value: 'New auditor role required' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Create role' }))

    expect(
      await screen.findByText('Role creation approval requested — pending a second admin'),
    ).toBeInTheDocument()
    expect(approvalBody).toMatchObject({
      actionType: 'change_iam_policy',
      targetType: 'staff-role',
      targetId: 'finance_auditor',
      reason: 'New auditor role required',
      payload: {
        name: 'finance_auditor',
        description: 'Audits finance flows',
        permissions: ['ledger.read', 'ledger.manage', 'audit.read'],
      },
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows an inline error when role creation approval is forbidden', async () => {
    seedRoles([{ ...ROLE }])
    server.use(
      http.post('/admin/two-person-approvals', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<StaffRolesPage />)
    await screen.findByText('support_manager')

    fireEvent.click(screen.getByRole('button', { name: 'New role' }))
    const modal = await screen.findByRole('dialog')
    fireEvent.change(within(modal).getByLabelText('Name'), { target: { value: 'support_agent' } })
    fireEvent.change(within(modal).getByLabelText(/Permissions/), { target: { value: 'tickets.read' } })
    fireEvent.change(within(modal).getByLabelText(/Reason/), { target: { value: 'Support agents need ticket access' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Create role' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText('Role creation approval requested — pending a second admin')).not.toBeInTheDocument()
    expect(screen.getByText('support_manager')).toBeInTheDocument()
  })

  it('hides the New role button when iam.manage is not granted', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seedRoles([{ ...ROLE }])
    render(<StaffRolesPage />)

    expect(await screen.findByText('support_manager')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New role' })).not.toBeInTheDocument()
  })
})
