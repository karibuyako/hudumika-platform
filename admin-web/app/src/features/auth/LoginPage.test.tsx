import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { LoginPage } from './LoginPage'
import { server } from '../../test/setup'
import { clearSession, SESSION_KEY } from '../../lib/session'

const OWNER_PHONE = '+255 700 000 001'

describe('LoginPage', () => {
  beforeEach(() => {
    clearSession()
  })

  it('step 1 sends requestOtp with channel, destination and purpose', async () => {
    let body: Record<string, unknown> | null = null
    server.use(
      http.post('/auth/request-otp', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ requestId: 'req_x', expiresInSeconds: 300 })
      }),
    )
    render(<LoginPage />)

    fireEvent.change(screen.getByLabelText('Staff phone'), { target: { value: OWNER_PHONE } })
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))

    await waitFor(() =>
      expect(body).toEqual({ channel: 'phone', destination: OWNER_PHONE, purpose: 'login' }),
    )
    expect(await screen.findByLabelText('One-time code')).toBeInTheDocument()
  })

  it('step 2 verify stores the staff session and shows a toast', async () => {
    server.use(
      http.post('/auth/request-otp', () => HttpResponse.json({ requestId: 'req_x', expiresInSeconds: 300 })),
      http.post('/auth/verify-otp', () =>
        HttpResponse.json({
          accessToken: 'at_1',
          refreshToken: 'rt_1',
          user: { id: 'user_1', phone: OWNER_PHONE, roles: [], createdAt: '2026-01-01T00:00:00.000Z' },
        }),
      ),
    )
    render(<LoginPage />)

    fireEvent.change(screen.getByLabelText('Staff phone'), { target: { value: OWNER_PHONE } })
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    fireEvent.change(await screen.findByLabelText('One-time code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Signed in as Platform Owner')
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Record<string, unknown>
    expect(stored.role).toBe('Platform Owner')
    expect(stored.permissions).toContain('*')
    expect(stored.mfaVerified).toBe(true)
    expect(stored.accessToken).toBe('at_1')
    expect(stored.refreshToken).toBe('rt_1')
  })

  it('shows an inline error when verify returns 401', async () => {
    server.use(
      http.post('/auth/request-otp', () => HttpResponse.json({ requestId: 'req_x', expiresInSeconds: 300 })),
      http.post('/auth/verify-otp', () =>
        HttpResponse.json({ code: 'INVALID_OTP', message: 'Invalid code', requestId: 'req_9' }, { status: 401 }),
      ),
    )
    render(<LoginPage />)

    fireEvent.change(screen.getByLabelText('Staff phone'), { target: { value: OWNER_PHONE } })
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    fireEvent.change(await screen.findByLabelText('One-time code'), { target: { value: '000000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))

    expect(await screen.findByText('Invalid or expired code')).toBeInTheDocument()
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('shows an inline error when requestOtp is rate-limited (429)', async () => {
    server.use(
      http.post('/auth/request-otp', () =>
        HttpResponse.json({ code: 'RATE_LIMITED', message: 'Too many requests', requestId: 'req_42' }, { status: 429 }),
      ),
    )
    render(<LoginPage />)

    fireEvent.change(screen.getByLabelText('Staff phone'), { target: { value: OWNER_PHONE } })
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))

    expect(await screen.findByText('Too many requests — retry shortly (request req_42)')).toBeInTheDocument()
  })

  it('validates an empty phone without calling the API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<LoginPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/phone number/i)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
