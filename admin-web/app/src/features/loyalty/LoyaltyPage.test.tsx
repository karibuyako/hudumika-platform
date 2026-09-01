import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { LoyaltyPage } from './LoyaltyPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

function seedMerchants(merchants: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/merchants', () => HttpResponse.json(merchants)))
}

describe('LoyaltyPage', () => {
  it('renders the loyalty configuration spec after loading merchants', async () => {
    seedMerchants([{ id: 'm_1', name: 'Duka Fresh' }])
    render(<LoyaltyPage />)

    expect(await screen.findByText('Loyalty configuration')).toBeInTheDocument()
    expect(screen.getByText(/1 merchants on file/)).toBeInTheDocument()
    expect(screen.getByText(/Loyalty tiers and top-up rewards are reviewed for compliance \(workflow 12\)/)).toBeInTheDocument()
  })

  it('shows an error state when merchants fail to load and recovers on retry', async () => {
    let calls = 0
    server.use(
      http.get('/admin/merchants', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'SERVICE_DOWN', message: 'down', requestId: 'req_1' }, { status: 500 })
        }
        return HttpResponse.json([])
      }),
    )
    render(<LoyaltyPage />)

    expect(await screen.findByText('Failed to load merchants')).toBeInTheDocument()
    expect(screen.getByText('down')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Loyalty configuration')).toBeInTheDocument()
  })

  it('completing the loyalty config prompt via the live endpoint shows success', async () => {
    seedMerchants([])
    render(<LoyaltyPage />)
    await screen.findByText('Loyalty configuration')

    fireEvent.click(screen.getByRole('button', { name: 'Oversee loyalty config' }))
    const prompt = screen.getByRole('dialog', { name: 'Oversee loyalty config' })
    fireEvent.change(prompt.querySelector('textarea')!, { target: { value: 'Tiers reviewed for compliance' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Loyalty config updated')).toBeInTheDocument()
    expect(screen.queryByText('PENDING_ENDPOINT')).not.toBeInTheDocument()
  })

  it('shows an error when loyalty config fails', async () => {
    seedMerchants([])
    server.use(http.put('/admin/loyalty/config', async () => HttpResponse.json({ code: 'LOYALTY_CONFIG_INVALID', message: 'invalid tiers', requestId: 'req_loyal' }, { status: 422 })))
    render(<LoyaltyPage />)
    await screen.findByText('Loyalty configuration')

    fireEvent.click(screen.getByRole('button', { name: 'Oversee loyalty config' }))
    const prompt = screen.getByRole('dialog', { name: 'Oversee loyalty config' })
    fireEvent.change(prompt.querySelector('textarea')!, { target: { value: 'Bad tiers' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await within(prompt).findByText(/invalid tiers/i)).toBeInTheDocument()
    expect(within(prompt).getByText(/req_loyal/)).toBeInTheDocument()
  })

  it('hides the oversee action without configuration.edit permission', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seedMerchants([])
    render(<LoyaltyPage />)

    await screen.findByText('Loyalty configuration')
    expect(screen.queryByRole('button', { name: 'Oversee loyalty config' })).not.toBeInTheDocument()
  })
})
