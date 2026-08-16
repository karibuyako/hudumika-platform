import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { FeatureFlagsPage } from './FeatureFlagsPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const FEATURE: Record<string, unknown> = {
  key: 'dark_mode',
  enabled: true,
  rolloutPct: 0.1,
  betaOnly: true,
  targeting: { countries: ['TZ'], userPct: 0.5 },
  updatedBy: 'alice',
  updatedAt: '2026-08-01T10:00:00.000Z',
}

function seedFlags(flags: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/features', () => HttpResponse.json(flags)))
}

describe('FeatureFlagsPage', () => {
  it('shows a loading skeleton, then renders feature flag rows', async () => {
    seedFlags([FEATURE, { key: 'new_checkout', enabled: false }])
    render(<FeatureFlagsPage />)

    expect(screen.getByLabelText('Loading')).toBeInTheDocument()

    expect(await screen.findByText('dark_mode')).toBeInTheDocument()
    expect(screen.getByText('new_checkout')).toBeInTheDocument()
    expect(screen.getAllByText('Enabled')).toHaveLength(2)
    expect(screen.getAllByText('Disabled')).toHaveLength(1)
    expect(screen.getByText('0.1%')).toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument()
  })

  it('shows the empty state when no flags exist', async () => {
    seedFlags([])
    render(<FeatureFlagsPage />)
    expect(await screen.findByText('No feature flags')).toBeInTheDocument()
  })

  it('shows an error state and recovers on retry', async () => {
    let calls = 0
    server.use(
      http.get('/admin/features', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'SERVICE_DOWN', message: 'down' }, { status: 500 })
        }
        return HttpResponse.json([FEATURE])
      }),
    )
    render(<FeatureFlagsPage />)

    expect(await screen.findByText('Failed to load feature flags')).toBeInTheDocument()
    expect(screen.getByText('down')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('dark_mode')).toBeInTheDocument()
    expect(screen.queryByText('Failed to load feature flags')).not.toBeInTheDocument()
  })

  it('opens the drawer, edits a flag, sends a PATCH and refetches', async () => {
    const flags = [{ ...FEATURE }]
    let putBody: Record<string, unknown> | null = null
    server.use(
      http.get('/admin/features', () => HttpResponse.json(flags)),
      http.patch('/admin/features', async ({ request }) => {
        putBody = (await request.json()) as Record<string, unknown>
        flags[0] = { ...FEATURE, enabled: false, rolloutPct: 0.25, betaOnly: false }
        return HttpResponse.json(flags[0])
      }),
    )
    render(<FeatureFlagsPage />)
    await screen.findByText('dark_mode')

    fireEvent.click(screen.getByText('dark_mode'))
    const drawer = await screen.findByRole('dialog', { name: 'dark_mode' })
    expect(within(drawer).getByText('Targeting')).toBeInTheDocument()
    expect(within(drawer).getByText(/"countries"/)).toBeInTheDocument()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit feature' }))

    const modal = await screen.findByRole('dialog', { name: 'Edit dark_mode' })
    fireEvent.change(within(modal).getByLabelText('Enabled'), { target: { value: 'disabled' } })
    fireEvent.change(within(modal).getByLabelText(/Rollout/), { target: { value: '0.25' } })
    fireEvent.change(within(modal).getByLabelText('Beta only'), { target: { value: 'no' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Feature updated')).toBeInTheDocument()
    expect(putBody).toEqual({
      key: 'dark_mode',
      enabled: false,
      rolloutPct: 0.25,
      betaOnly: false,
      targeting: { countries: ['TZ'], userPct: 0.5 },
    })
    expect(await screen.findByText('Disabled')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows an inline error when the update is forbidden', async () => {
    seedFlags([{ ...FEATURE }])
    server.use(
      http.patch('/admin/features', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<FeatureFlagsPage />)
    await screen.findByText('dark_mode')

    fireEvent.click(screen.getByText('dark_mode'))
    const drawer = await screen.findByRole('dialog', { name: 'dark_mode' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit feature' }))

    const modal = await screen.findByRole('dialog', { name: 'Edit dark_mode' })
    fireEvent.click(within(modal).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Edit dark_mode' })).toBeInTheDocument()
    expect(screen.queryByText('Feature updated')).not.toBeInTheDocument()
    expect(screen.getAllByText('dark_mode').length).toBeGreaterThan(0)
  })

  it('hides the Edit feature button when configuration.edit is not granted', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seedFlags([{ ...FEATURE }])
    render(<FeatureFlagsPage />)
    await screen.findByText('dark_mode')

    fireEvent.click(screen.getByText('dark_mode'))
    const drawer = await screen.findByRole('dialog', { name: 'dark_mode' })
    expect(within(drawer).queryByRole('button', { name: 'Edit feature' })).not.toBeInTheDocument()
  })

  it('round-trips edited targeting inputs into the PATCH body', async () => {
    let putBody: Record<string, unknown> | null = null
    server.use(
      http.get('/admin/features', () => HttpResponse.json([{ ...FEATURE, targeting: undefined }])),
      http.patch('/admin/features', async ({ request }) => {
        putBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ...FEATURE, targeting: undefined })
      }),
    )
    render(<FeatureFlagsPage />)
    await screen.findByText('dark_mode')

    fireEvent.click(screen.getByText('dark_mode'))
    const drawer = await screen.findByRole('dialog', { name: 'dark_mode' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit feature' }))

    const modal = await screen.findByRole('dialog', { name: 'Edit dark_mode' })
    fireEvent.change(within(modal).getByLabelText(/Target countries/), { target: { value: 'TZ, KE' } })
    fireEvent.change(within(modal).getByLabelText(/Target regions/), { target: { value: 'arusha' } })
    fireEvent.change(within(modal).getByLabelText(/Target cities/), { target: { value: 'Dar es Salaam' } })
    fireEvent.change(within(modal).getByLabelText(/Target segments/), { target: { value: 'vip, staff' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Feature updated')).toBeInTheDocument()
    expect(putBody).toEqual({
      key: 'dark_mode',
      enabled: true,
      rolloutPct: 0.1,
      betaOnly: true,
      targeting: { countries: ['TZ', 'KE'], regions: ['arusha'], cities: ['Dar es Salaam'], segments: ['vip', 'staff'] },
    })
  })

  it('converts userPct between percentage input and fraction payload', async () => {
    let putBody: Record<string, unknown> | null = null
    server.use(
      http.get('/admin/features', () => HttpResponse.json([{ ...FEATURE }])),
      http.patch('/admin/features', async ({ request }) => {
        putBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ...FEATURE })
      }),
    )
    render(<FeatureFlagsPage />)
    await screen.findByText('dark_mode')

    fireEvent.click(screen.getByText('dark_mode'))
    const drawer = await screen.findByRole('dialog', { name: 'dark_mode' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit feature' }))

    const modal = await screen.findByRole('dialog', { name: 'Edit dark_mode' })
    const userPct = within(modal).getByLabelText(/Target user/) as HTMLInputElement
    expect(userPct.value).toBe('50')
    fireEvent.change(userPct, { target: { value: '30' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Feature updated')).toBeInTheDocument()
    expect(putBody).toEqual({
      key: 'dark_mode',
      enabled: true,
      rolloutPct: 0.1,
      betaOnly: true,
      targeting: { countries: ['TZ'], userPct: 0.3 },
    })
  })
})
