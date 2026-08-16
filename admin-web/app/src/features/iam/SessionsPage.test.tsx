import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { SessionsPage } from './SessionsPage'
import { server } from '../../test/setup'

type SeedSession = {
  id: string
  deviceInfo: string
  lastActiveAt: string
  current?: boolean
  ip?: string
  createdAt?: string
}

const SESSIONS: SeedSession[] = [
  { id: 'sess_1', deviceInfo: 'Chrome on macOS', lastActiveAt: '2026-08-16T08:00:00.000Z', current: true },
  { id: 'sess_2', deviceInfo: 'Firefox on Linux', lastActiveAt: '2026-08-15T20:15:00.000Z' },
  {
    id: 'sess_3',
    deviceInfo: 'Mobile Safari',
    ip: '10.0.0.7',
    createdAt: '2026-08-01T09:00:00.000Z',
    lastActiveAt: '2026-08-16T07:45:00.000Z',
  },
]

function seedSessions(sessions: SeedSession[]) {
  server.use(http.get('/sessions', () => HttpResponse.json(sessions)))
}

function rowFor(text: string): HTMLElement {
  return screen.getByText(text).closest('tr') as HTMLElement
}

describe('SessionsPage', () => {
  it('renders sessions, masks IPs and shows the MFA note', async () => {
    seedSessions(SESSIONS)
    render(<SessionsPage />)

    expect(await screen.findByText('Chrome on macOS')).toBeInTheDocument()
    expect(screen.getByText('Firefox on Linux')).toBeInTheDocument()
    expect(screen.getByText('Mobile Safari')).toBeInTheDocument()
    expect(screen.getByText('sess_2')).toBeInTheDocument()
    expect(screen.getByText('••••••••')).toBeInTheDocument()
    expect(screen.getByText('Current')).toBeInTheDocument()
    expect(screen.getByText(/MFA is enforced at sign-in/)).toBeInTheDocument()
    expect(screen.getByText(/Suspicious devices should be revoked immediately/)).toBeInTheDocument()
  })

  it('marks the current session with a Current pill and hides its revoke button', async () => {
    seedSessions(SESSIONS)
    render(<SessionsPage />)

    await screen.findByText('Chrome on macOS')

    const currentRow = rowFor('Chrome on macOS')
    expect(within(currentRow).getByText('Current')).toBeInTheDocument()
    expect(within(currentRow).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument()

    const otherRow = rowFor('Firefox on Linux')
    expect(within(otherRow).getByRole('button', { name: 'Revoke' })).toBeInTheDocument()
  })

  it('revokes a session via POST and refetches the list', async () => {
    let revokedToken = ''
    let method = ''
    let listCalls = 0
    server.use(
      http.get('/sessions', () => {
        listCalls += 1
        return HttpResponse.json(listCalls === 1 ? SESSIONS : [SESSIONS[0]])
      }),
      http.post('/sessions/:token/revoke', ({ request, params }) => {
        revokedToken = String(params.token)
        method = request.method
        return new HttpResponse(null, { status: 204 })
      }),
    )
    render(<SessionsPage />)

    await screen.findByText('Chrome on macOS')
    fireEvent.click(within(rowFor('Firefox on Linux')).getByRole('button', { name: 'Revoke' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Revoke session')).toBeInTheDocument()
    expect(within(dialog).getByText('The device will be signed out immediately.')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))

    await waitFor(() => expect(revokedToken).toBe('sess_2'))
    expect(method).toBe('POST')
    expect(screen.getByRole('status')).toHaveTextContent('Session revoked')
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2))
    await waitFor(() => expect(screen.queryByText('Firefox on Linux')).not.toBeInTheDocument())
  })

  it('shows an inline error when revocation is forbidden', async () => {
    server.use(
      http.get('/sessions', () => HttpResponse.json(SESSIONS)),
      http.post('/sessions/:token/revoke', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'Session revocation not permitted', requestId: 'req_403' },
          { status: 403 },
        ),
      ),
    )
    render(<SessionsPage />)

    await screen.findByText('Firefox on Linux')
    fireEvent.click(within(rowFor('Firefox on Linux')).getByRole('button', { name: 'Revoke' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Session revocation not permitted')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('Firefox on Linux')).toBeInTheDocument()
  })

  it('shows the empty state when there are no sessions', async () => {
    seedSessions([])
    render(<SessionsPage />)

    expect(await screen.findByText('No active sessions')).toBeInTheDocument()
    expect(screen.getByText(/MFA is enforced at sign-in/)).toBeInTheDocument()
  })

  it('shows an error and recovers via Retry', async () => {
    server.use(
      http.get('/sessions', () =>
        HttpResponse.json({ code: 'INTERNAL', message: 'sessions service down', requestId: 'req_err' }, { status: 500 }),
      ),
    )
    render(<SessionsPage />)

    expect(await screen.findByText('Failed to load sessions')).toBeInTheDocument()
    expect(screen.getByText('sessions service down')).toBeInTheDocument()
    expect(screen.getByText('req_err')).toBeInTheDocument()

    seedSessions(SESSIONS)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Chrome on macOS')).toBeInTheDocument()
  })
})
