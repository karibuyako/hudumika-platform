import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { ConversationsPage } from './ConversationsPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const CONV = {
  id: 'conv_1',
  merchantId: 'merchant_1',
  status: 'open',
  lastMessagePreview: 'Where is my order?',
  unreadCount: 2,
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-02T10:00:00Z',
  participants: [
    { role: 'customer', displayName: 'Asha Mwakalinga', maskedPhone: '+255 7xx xxx 123' },
    { role: 'merchant_staff', displayName: 'Duka Fresh Staff', maskedPhone: '+255 7xx xxx 456' },
  ],
}

function seedConversations(conversations: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/conversations', () => HttpResponse.json(conversations)))
}

describe('ConversationsPage', () => {
  it('shows a loading skeleton, then renders conversation rows', async () => {
    seedConversations([CONV])
    render(<ConversationsPage />)

    expect(screen.getByLabelText('Loading')).toBeInTheDocument()

    expect(await screen.findByText('conv_1')).toBeInTheDocument()
    expect(screen.getByText('open', { selector: '.pill' })).toBeInTheDocument()
    expect(screen.getByText('Asha Mwakalinga · +255 7xx xxx 123')).toBeInTheDocument()
    expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument()
  })

  it('filters by status server-side with counts', async () => {
    const all = [
      { ...CONV },
      { ...CONV, id: 'conv_2', status: 'open', participants: [{ role: 'customer', displayName: 'Baraka Mushi', maskedPhone: '+255 7xx xxx 222' }] },
      { ...CONV, id: 'conv_3', status: 'archived', participants: [{ role: 'customer', displayName: 'Neema Joseph', maskedPhone: null }] },
    ]
    server.use(
      http.get('/admin/conversations', ({ request }) => {
        const status = new URL(request.url).searchParams.get('status')
        if (status === 'open') {
          return HttpResponse.json([all[0], all[1]])
        }
        return HttpResponse.json(all)
      }),
    )
    render(<ConversationsPage />)
    await screen.findByText('conv_1')

    expect(screen.getByRole('button', { name: 'All3' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'open2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'archived1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'blocked0' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'open2' }))
    expect(await screen.findByText('conv_2')).toBeInTheDocument()
    expect(screen.getByText('conv_1')).toBeInTheDocument()
    expect(screen.queryByText('conv_3')).not.toBeInTheDocument()
  })

  it('shows the empty state when no conversations exist', async () => {
    seedConversations([])
    render(<ConversationsPage />)
    expect(await screen.findByText('No conversations found')).toBeInTheDocument()
  })

  it('exports the visible conversations as CSV', async () => {
    seedConversations([CONV])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<ConversationsPage />)
    await screen.findByText('conv_1')

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(anchorClick).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('ID,Status,Participant,Created,Updated')
    expect(csv).toContain('conv_1')
    expect(csv).toContain('Asha Mwakalinga · +255 7xx xxx 123')
    expect(revokeObjectURL).toHaveBeenCalled()
  })

  it('shows an error state and recovers on retry', async () => {
    let calls = 0
    server.use(
      http.get('/admin/conversations', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'SERVICE_DOWN', message: 'down', requestId: 'req_1' }, { status: 500 })
        }
        return HttpResponse.json([CONV])
      }),
    )
    render(<ConversationsPage />)

    expect(await screen.findByText('Failed to load conversations')).toBeInTheDocument()
    expect(screen.getByText('down')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('conv_1')).toBeInTheDocument()
    expect(screen.queryByText('Failed to load conversations')).not.toBeInTheDocument()
  })

  it('opens a detail drawer with conversation and participant details on row click', async () => {
    seedConversations([CONV])
    render(<ConversationsPage />)

    const id = await screen.findByText('conv_1')
    fireEvent.click(id)

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'conv_1' })).toBeInTheDocument()
    expect(within(dialog).getByText('open')).toBeInTheDocument()
    expect(within(dialog).getByText('customer')).toBeInTheDocument()
    expect(within(dialog).getByText('Asha Mwakalinga')).toBeInTheDocument()
    expect(within(dialog).getByText('+255 7xx xxx 123')).toBeInTheDocument()
    expect(within(dialog).getByText('Duka Fresh Staff')).toBeInTheDocument()
    expect(within(dialog).getByText(/read-only oversight/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the Block action for open conversations', async () => {
    seedConversations([CONV])
    render(<ConversationsPage />)
    fireEvent.click(await screen.findByText('conv_1'))
    expect(await screen.findByRole('button', { name: 'Block' })).toBeInTheDocument()
  })

  it('hides the Block action without conversation.block permission', async () => {
    seedStaffSession({ permissions: ['conversation.read'] })
    seedConversations([CONV])
    render(<ConversationsPage />)
    fireEvent.click(await screen.findByText('conv_1'))
    await screen.findByRole('dialog')
    expect(screen.queryByRole('button', { name: 'Block' })).not.toBeInTheDocument()
  })

  it('hides the Block action for already-blocked conversations', async () => {
    seedConversations([{ ...CONV, status: 'blocked' }])
    render(<ConversationsPage />)
    fireEvent.click(await screen.findByText('conv_1'))
    await screen.findByRole('dialog')
    expect(screen.queryByRole('button', { name: 'Block' })).not.toBeInTheDocument()
  })

  it('block sends the real blockConversation call and closes the drawer with a toast', async () => {
    seedConversations([CONV])
    let postedBody: unknown = null
    server.use(
      http.post('*/conversations/conv_1/block', async ({ request }) => {
        postedBody = await request.json()
        return HttpResponse.json({ ...CONV, status: 'blocked' }, { status: 200 })
      }),
    )
    render(<ConversationsPage />)
    fireEvent.click(await screen.findByText('conv_1'))
    fireEvent.click(await screen.findByRole('button', { name: 'Block' }))

    const dialog = screen.getByRole('dialog', { name: 'Block conversation' })
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'Abusive behaviour' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))

    await waitFor(() => {
      expect(postedBody).toEqual({ reason: 'Abusive behaviour' })
    })
    expect(await screen.findByText('conv_1 blocked')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
