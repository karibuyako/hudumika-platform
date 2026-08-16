import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { InboxPage } from './InboxPage'
import { server } from '../../test/setup'

type Ticket = {
  id: string
  subject: string
  status: 'open' | 'assigned' | 'in_progress' | 'resolved' | 'closed'
  priority: 'low' | 'normal' | 'high' | 'critical'
  assignedAgentId?: string | null
  createdAt: string
  updatedAt?: string
}

const T1: Ticket = {
  id: 'tkt_1',
  subject: 'Refund request stuck',
  status: 'open',
  priority: 'high',
  createdAt: '2026-08-13T10:00:00.000Z',
}
const T2: Ticket = {
  id: 'tkt_2',
  subject: 'Order never delivered',
  status: 'in_progress',
  priority: 'low',
  assignedAgentId: 'ag_9',
  createdAt: '2026-08-13T11:00:00.000Z',
}
const T3: Ticket = {
  id: 'tkt_3',
  subject: 'Merchant payout dispute',
  status: 'resolved',
  priority: 'critical',
  createdAt: '2026-08-13T12:00:00.000Z',
  updatedAt: '2026-08-14T08:00:00.000Z',
}
const T4: Ticket = {
  id: 'tkt_4',
  subject: 'Account locked',
  status: 'closed',
  priority: 'normal',
  createdAt: '2026-08-13T13:00:00.000Z',
}

function seedTickets(tickets: Ticket[]) {
  server.use(http.get('/admin/support/tickets', () => HttpResponse.json(tickets)))
}

describe('InboxPage', () => {
  it('loads and renders ticket rows', async () => {
    seedTickets([T1, T2])
    render(<InboxPage />)

    expect(await screen.findByText('Refund request stuck')).toBeInTheDocument()
    expect(screen.getByText('Order never delivered')).toBeInTheDocument()
    expect(screen.getByText('ag_9')).toBeInTheDocument()
    expect(screen.getByText('in progress', { exact: false })).toBeInTheDocument()
  })

  it('filters by bucket chips and priority chips', async () => {
    seedTickets([T1, T2, T3, T4])
    render(<InboxPage />)
    await screen.findByText('Refund request stuck')

    const buckets = within(screen.getByRole('group', { name: /bucket/i }))
    const priorities = within(screen.getByRole('group', { name: /priority/i }))
    expect(buckets.getByText('4')).toBeInTheDocument()
    buckets.getByText('Open').click()
    expect(await screen.findByText('Refund request stuck')).toBeInTheDocument()
    expect(screen.queryByText('Order never delivered')).not.toBeInTheDocument()

    priorities.getByText('low').click()
    expect(await screen.findByText('No tickets in this bucket')).toBeInTheDocument()

    buckets.getByText('All').click()
    expect(await screen.findByText('Order never delivered')).toBeInTheDocument()
    expect(screen.queryByText('Refund request stuck')).not.toBeInTheDocument()

    priorities.getByText('critical').click()
    expect(await screen.findByText('Merchant payout dispute')).toBeInTheDocument()
    expect(screen.queryByText('Order never delivered')).not.toBeInTheDocument()
  })

  it('shows the empty state when there are no tickets', async () => {
    seedTickets([])
    render(<InboxPage />)

    expect(await screen.findByText('No tickets in this bucket')).toBeInTheDocument()
  })

  it('shows the error state and recovers on retry', async () => {
    server.use(
      http.get('/admin/support/tickets', () =>
        HttpResponse.json({ code: 'INTERNAL', message: 'down' }, { status: 500 }),
      ),
    )
    render(<InboxPage />)

    expect(await screen.findByText('Failed to load support tickets')).toBeInTheDocument()

    seedTickets([T1])
    screen.getByRole('button', { name: 'Retry' }).click()

    expect(await screen.findByText('Refund request stuck')).toBeInTheDocument()
  })

  it('assigns a ticket to an agent with a toast and refetch', async () => {
    const tickets: Ticket[] = [T1, T2]
    server.use(
      http.get('/admin/support/tickets', () => HttpResponse.json(tickets)),
      http.post('/admin/support/tickets/tkt_1/assign', async ({ request }) => {
        const body = (await request.json()) as { agentUserId: string }
        tickets[0] = { ...T1, status: 'assigned', assignedAgentId: body.agentUserId }
        return HttpResponse.json(tickets[0])
      }),
    )
    render(<InboxPage />)
    await screen.findByText('Refund request stuck')

    fireEvent.click(screen.getByText('Refund request stuck'))
    fireEvent.click(await screen.findByText('Assign to agent'))
    fireEvent.change(await screen.findByLabelText(/agent user id/i), { target: { value: 'agent_1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }))

    expect(await screen.findByText('Ticket assigned to agent_1')).toBeInTheDocument()
    expect(await screen.findByText('agent_1')).toBeInTheDocument()
  })

  it('shows an inline error in the modal when assignment is forbidden', async () => {
    seedTickets([T1])
    server.use(
      http.post('/admin/support/tickets/tkt_1/assign', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<InboxPage />)
    await screen.findByText('Refund request stuck')

    fireEvent.click(screen.getByText('Refund request stuck'))
    fireEvent.click(await screen.findByText('Assign to agent'))
    fireEvent.change(await screen.findByLabelText(/agent user id/i), { target: { value: 'agent_1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: /assign ticket/i })).toBeInTheDocument()
  })
})
