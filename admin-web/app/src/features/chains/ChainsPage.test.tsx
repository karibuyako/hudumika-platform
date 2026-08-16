import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { ChainsPage } from './ChainsPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const CHAIN = {
  merchantGroupId: 'grp_1',
  name: 'Chapa Express',
  storesCount: 12,
  tier: 'enterprise',
  slaLevel: 'Silver',
  accountManager: 'Janeth Mwakyusa',
  monthlyVolumeTZS: 2500000,
  status: 'active',
}

function seedChains(chains: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/chain', () => HttpResponse.json(chains)))
}

describe('ChainsPage', () => {
  it('shows a loading skeleton, then renders chain rows', async () => {
    seedChains([CHAIN])
    render(<ChainsPage />)

    expect(screen.getByLabelText('Loading')).toBeInTheDocument()

    expect(await screen.findByText('Chapa Express')).toBeInTheDocument()
    expect(screen.getByText('grp_1')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('enterprise')).toBeInTheDocument()
    expect(screen.getByText('Silver')).toBeInTheDocument()
    expect(screen.getByText('Janeth Mwakyusa')).toBeInTheDocument()
    expect(screen.getByText('TZS 2,500,000')).toBeInTheDocument()
    expect(screen.getByText('active')).toBeInTheDocument()
    expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument()
  })

  it('filters rows by tier with counts', async () => {
    seedChains([
      { ...CHAIN },
      {
        merchantGroupId: 'grp_2',
        name: 'Kilimanjaro Foods',
        storesCount: 3,
        tier: 'standard',
        slaLevel: null,
        accountManager: null,
        monthlyVolumeTZS: undefined,
        status: undefined,
      },
      {
        merchantGroupId: 'grp_3',
        name: 'Zanzibar Spices',
        storesCount: 5,
        tier: 'standard',
        slaLevel: 'Bronze',
        accountManager: 'Deo Laurent',
        monthlyVolumeTZS: 400000,
        status: 'suspended',
      },
    ])
    render(<ChainsPage />)
    await screen.findByText('Chapa Express')

    expect(screen.getByRole('button', { name: 'All3' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Standard2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enterprise1' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Enterprise1' }))
    expect(screen.getByText('Chapa Express')).toBeInTheDocument()
    expect(screen.queryByText('Kilimanjaro Foods')).not.toBeInTheDocument()
    expect(screen.queryByText('Zanzibar Spices')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Standard2' }))
    expect(screen.getByText('Kilimanjaro Foods')).toBeInTheDocument()
    expect(screen.getByText('Zanzibar Spices')).toBeInTheDocument()
    expect(screen.queryByText('Chapa Express')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'All3' }))
    expect(screen.getByText('Chapa Express')).toBeInTheDocument()
  })

  it('shows the empty state when no chains exist', async () => {
    seedChains([])
    render(<ChainsPage />)
    expect(await screen.findByText('No chains found')).toBeInTheDocument()
  })

  it('exports the visible chains as CSV', async () => {
    seedChains([CHAIN])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<ChainsPage />)
    await screen.findByText('Chapa Express')

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(anchorClick).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Name,Group ID,Stores,Tier,SLA level,Account manager,Monthly volume,Status')
    expect(csv).toContain('Chapa Express')
    expect(csv).toContain('TZS 2,500,000')
    expect(revokeObjectURL).toHaveBeenCalled()
  })

  it('shows an error state and recovers on retry', async () => {
    let calls = 0
    server.use(
      http.get('/admin/chain', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'SERVICE_DOWN', message: 'down', requestId: 'req_1' }, { status: 500 })
        }
        return HttpResponse.json([CHAIN])
      }),
    )
    render(<ChainsPage />)

    expect(await screen.findByText('Failed to load chains')).toBeInTheDocument()
    expect(screen.getByText('down')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Chapa Express')).toBeInTheDocument()
    expect(screen.queryByText('Failed to load chains')).not.toBeInTheDocument()
  })

  it('opens a detail drawer with account and SLA details on row click', async () => {
    seedChains([CHAIN])
    render(<ChainsPage />)

    const name = await screen.findByText('Chapa Express')
    fireEvent.click(name)

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Chapa Express' })).toBeInTheDocument()
    expect(within(dialog).getByText('grp_1')).toBeInTheDocument()
    expect(within(dialog).getByText('enterprise')).toBeInTheDocument()
    expect(within(dialog).getByText('12')).toBeInTheDocument()
    expect(within(dialog).getByText('Silver')).toBeInTheDocument()
    expect(within(dialog).getByText('Janeth Mwakyusa')).toBeInTheDocument()
    expect(within(dialog).getByText('TZS 2,500,000')).toBeInTheDocument()
    expect(within(dialog).getByText('active')).toBeInTheDocument()
    expect(within(dialog).getByText(/two-person approval/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows Suspend for active chains and Onboard for inactive chains', async () => {
    seedChains([
      { ...CHAIN },
      { ...CHAIN, merchantGroupId: 'grp_2', name: 'Kilimanjaro Foods', status: 'suspended' },
    ])
    render(<ChainsPage />)
    await screen.findByText('Chapa Express')

    fireEvent.click(screen.getByText('Chapa Express'))
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Suspend' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Onboard' })).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))

    fireEvent.click(screen.getByText('Kilimanjaro Foods'))
    dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Onboard' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument()
  })

  it('hides chain lifecycle actions without chain.suspend permission', async () => {
    seedStaffSession({ permissions: ['chain.read'] })
    seedChains([{ ...CHAIN, status: 'suspended' }])
    render(<ChainsPage />)
    fireEvent.click(await screen.findByText('Chapa Express'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByRole('button', { name: 'Onboard' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument()
  })

  it('onboarding completes the reason prompt and shows the chain_onboard pending notice', async () => {
    seedChains([{ ...CHAIN, merchantGroupId: 'grp_2', name: 'Kilimanjaro Foods', status: 'suspended' }])
    render(<ChainsPage />)
    fireEvent.click(await screen.findByText('Kilimanjaro Foods'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Onboard' }))

    const prompt = screen.getByRole('dialog', { name: 'Onboard chain' })
    fireEvent.change(prompt.querySelector('textarea')!, { target: { value: 'Ready for enterprise tier' } })
    fireEvent.change(within(prompt).getByLabelText('Tier'), { target: { value: 'enterprise' } })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('PENDING_ENDPOINT')).toBeInTheDocument()
    expect(
      screen.getByText(/POST \/admin\/chains\/\{merchantGroupId\}\/onboard/),
    ).toBeInTheDocument()
    expect(
      screen.getByText('This action is documented for backend implementation — nothing was sent.'),
    ).toBeInTheDocument()
  })

  it('suspending an active chain shows the chain_suspend pending notice', async () => {
    seedChains([CHAIN])
    render(<ChainsPage />)
    fireEvent.click(await screen.findByText('Chapa Express'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }))

    const prompt = screen.getByRole('dialog', { name: 'Suspend chain' })
    fireEvent.change(prompt.querySelector('textarea')!, { target: { value: 'SLA violations' } })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('PENDING_ENDPOINT')).toBeInTheDocument()
    expect(
      screen.getByText(/POST \/admin\/chains\/\{merchantGroupId\}\/suspend/),
    ).toBeInTheDocument()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
