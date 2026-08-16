import { describe, expect, test } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import type { Voucher } from '@hudumika/contract'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'
import { VouchersPage } from './VouchersPage'

const voucher = (over: Partial<Voucher> = {}): Voucher => ({
  code: 'VCH-BRUNCH-001',
  groupBuyId: 'gb_1',
  title: 'Weekend brunch deal',
  priceTZS: 15000,
  status: 'unused',
  purchasedAt: '2026-08-05T10:00:00.000Z',
  redeemedAt: null,
  expiresAt: '2026-09-01T00:00:00.000Z',
  redeemedByMerchantId: null,
  ...over,
})

describe('VouchersPage', () => {
  test('renders the verification form and purpose card', () => {
    render(<VouchersPage />)
    expect(screen.getByText('Verify a voucher code during a dispute or support interaction.')).toBeInTheDocument()
    expect(screen.getByLabelText('Voucher code')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verify' })).toBeInTheDocument()
  })

  test('initial state has no result and no history', () => {
    render(<VouchersPage />)
    expect(screen.queryByText('Verification result')).not.toBeInTheDocument()
    expect(screen.getByText('No verifications this session.')).toBeInTheDocument()
    expect(screen.getByText('Verification history is append-only and audited (voucher.*).')).toBeInTheDocument()
  })

  test('verify success renders result card and appends history', async () => {
    const user = userEvent.setup()
    const verifyCalls: Array<{ voucherCode: string }> = []
    server.use(
      http.post('*/admin/vouchers/verify', async ({ request }) => {
        verifyCalls.push((await request.json()) as { voucherCode: string })
        await new Promise((r) => setTimeout(r, 30))
        return HttpResponse.json(voucher())
      }),
    )
    render(<VouchersPage />)
    await user.type(screen.getByLabelText('Voucher code'), 'VCH-BRUNCH-001')
    await user.click(screen.getByRole('button', { name: 'Verify' }))

    expect(await screen.findAllByText('VCH-BRUNCH-001')).toHaveLength(2)
    expect(verifyCalls).toEqual([{ voucherCode: 'VCH-BRUNCH-001' }])
    expect(screen.getByText('Verification result')).toBeInTheDocument()
    expect(screen.getByText('TZS 15,000')).toBeInTheDocument()
    expect(screen.getAllByText('unused')).toHaveLength(2)
    expect(screen.getAllByText('VCH-BRUNCH-001')).toHaveLength(2)
  })

  test('Verify button shows loading state while verifying', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('*/admin/vouchers/verify', async () => {
        await new Promise((r) => setTimeout(r, 60))
        return HttpResponse.json(voucher())
      }),
    )
    render(<VouchersPage />)
    await user.type(screen.getByLabelText('Voucher code'), 'VCH-BRUNCH-001')
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    expect(screen.getByRole('button', { name: /verifying/i })).toBeInTheDocument()
    expect(await screen.findByText('Verification result')).toBeInTheDocument()
  })

  test('clear button resets the result', async () => {
    const user = userEvent.setup()
    server.use(http.post('*/admin/vouchers/verify', () => HttpResponse.json(voucher())))
    render(<VouchersPage />)
    await user.type(screen.getByLabelText('Voucher code'), 'VCH-BRUNCH-001')
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByText('Verification result')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.queryByText('Verification result')).not.toBeInTheDocument()
    expect(screen.getAllByText('VCH-BRUNCH-001')).toHaveLength(1)
  })

  test.each([
    ['VOUCHER_INVALID_CODE', 'Code not found'],
    ['VOUCHER_ALREADY_USED', 'Already redeemed'],
    ['VOUCHER_EXPIRED', 'Expired'],
  ])('maps %s to inline error "%s"', async (code, expected) => {
    const user = userEvent.setup()
    server.use(
      http.post('*/admin/vouchers/verify', () =>
        HttpResponse.json({ code, message: `raw ${code}`, requestId: 'req-1' }, { status: 400 }),
      ),
    )
    render(<VouchersPage />)
    await user.type(screen.getByLabelText('Voucher code'), 'VCH-BRUNCH-001')
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByText(expected)).toBeInTheDocument()
    expect(screen.queryByText('Verification result')).not.toBeInTheDocument()
  })

  test('unmapped error codes fall back to parseApiError message', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('*/admin/vouchers/verify', () =>
        HttpResponse.json({ code: 'VOUCHER_BOUNCED', message: 'Voucher bounced', requestId: 'req-2' }, { status: 400 }),
      ),
    )
    render(<VouchersPage />)
    await user.type(screen.getByLabelText('Voucher code'), 'VCH-BRUNCH-001')
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByText('Voucher bounced')).toBeInTheDocument()
  })

  test('hides the verify form without voucher.verify', () => {
    seedStaffSession({ permissions: ['audit.read'] })
    render(<VouchersPage />)

    expect(screen.getByText('Voucher verification requires voucher.verify')).toBeInTheDocument()
    expect(screen.queryByLabelText('Voucher code')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
  })
})
