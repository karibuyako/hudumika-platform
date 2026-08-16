import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { LoyaltyPage } from './LoyaltyPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

function seedMerchants(merchants: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/merchants', () => HttpResponse.json(merchants)))
}

describe('LoyaltyPage', () => {
  it('renders the empty state and pending loyalty surface spec after loading merchants', async () => {
    seedMerchants([{ id: 'm_1', name: 'Duka Fresh' }])
    render(<LoyaltyPage />)

    expect(await screen.findByText('No loyalty configuration in the contract yet')).toBeInTheDocument()
    expect(screen.getByText(/1 merchants on file/)).toBeInTheDocument()
    expect(screen.getByText(/PUT \/admin\/loyalty\/config/)).toBeInTheDocument()
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
    expect(await screen.findByText('No loyalty configuration in the contract yet')).toBeInTheDocument()
  })

  it('completing the loyalty config prompt shows the loyalty_config pending notice', async () => {
    seedMerchants([])
    render(<LoyaltyPage />)
    await screen.findByText('No loyalty configuration in the contract yet')

    fireEvent.click(screen.getByRole('button', { name: 'Oversee loyalty config' }))
    const prompt = screen.getByRole('dialog', { name: 'Oversee loyalty config' })
    fireEvent.change(prompt.querySelector('textarea')!, { target: { value: 'Tiers reviewed for compliance' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('PENDING_ENDPOINT')).toBeInTheDocument()
    expect(screen.getAllByText(/PUT \/admin\/loyalty\/config/)).toHaveLength(2)
    expect(
      screen.getByText('This action is documented for backend implementation — nothing was sent.'),
    ).toBeInTheDocument()
  })

  it('hides the oversee action without configuration.edit permission', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seedMerchants([])
    render(<LoyaltyPage />)

    await screen.findByText('No loyalty configuration in the contract yet')
    expect(screen.queryByRole('button', { name: 'Oversee loyalty config' })).not.toBeInTheDocument()
  })
})
