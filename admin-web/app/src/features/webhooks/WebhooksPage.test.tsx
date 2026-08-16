import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { WebhooksPage } from './WebhooksPage'
import { server } from '../../test/setup'

const DELIVERY = {
  id: 'del_1',
  webhookId: 'wh_1',
  event: 'order.paid',
  status: 'success',
  attempts: 1,
  statusCode: 200,
  nextRetryAt: null,
  deliveredAt: '2026-08-02T10:00:00Z',
}

function seedDeliveries(deliveries: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/webhooks', () => HttpResponse.json(deliveries)))
}

describe('WebhooksPage', () => {
  it('shows a loading skeleton, then renders delivery rows', async () => {
    seedDeliveries([DELIVERY])
    render(<WebhooksPage />)

    expect(screen.getByLabelText('Loading')).toBeInTheDocument()

    expect(await screen.findByText('del_1')).toBeInTheDocument()
    expect(screen.getByText('wh_1')).toBeInTheDocument()
    expect(screen.getByText('order.paid')).toBeInTheDocument()
    expect(screen.getByText('success')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('200')).toBeInTheDocument()
    expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument()
  })

  it('refetches with failingOnly=true when the Failing only chip is active', async () => {
    const requests: string[] = []
    const failed = { ...DELIVERY, id: 'del_2', status: 'failed', attempts: 3, statusCode: null, nextRetryAt: '2026-08-03T10:00:00Z' }
    server.use(
      http.get('/admin/webhooks', ({ request }) => {
        requests.push(request.url)
        const failingOnly = new URL(request.url).searchParams.get('failingOnly')
        if (failingOnly === 'true') {
          return HttpResponse.json([failed])
        }
        return HttpResponse.json([DELIVERY])
      }),
    )
    render(<WebhooksPage />)
    await screen.findByText('del_1')
    expect(requests[0]).not.toContain('failingOnly')

    fireEvent.click(screen.getByRole('button', { name: 'Failing only' }))
    expect(await screen.findByText('del_2')).toBeInTheDocument()
    expect(screen.queryByText('del_1')).not.toBeInTheDocument()
    expect(requests[1]).toContain('failingOnly=true')

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(await screen.findByText('del_1')).toBeInTheDocument()
    expect(requests[2]).not.toContain('failingOnly')
  })

  it('shows the empty state when no deliveries exist', async () => {
    seedDeliveries([])
    render(<WebhooksPage />)
    expect(await screen.findByText('No webhook deliveries found')).toBeInTheDocument()
  })

  it('exports the visible deliveries as CSV', async () => {
    seedDeliveries([DELIVERY])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<WebhooksPage />)
    await screen.findByText('del_1')

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(anchorClick).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('ID,Webhook ID,Event,Status,Attempts,Status code,Next retry,Delivered')
    expect(csv).toContain('del_1')
    expect(csv).toContain('order.paid')
    expect(revokeObjectURL).toHaveBeenCalled()
  })

  it('shows an error state and recovers on retry', async () => {
    let calls = 0
    server.use(
      http.get('/admin/webhooks', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'SERVICE_DOWN', message: 'down', requestId: 'req_1' }, { status: 500 })
        }
        return HttpResponse.json([DELIVERY])
      }),
    )
    render(<WebhooksPage />)

    expect(await screen.findByText('Failed to load webhooks')).toBeInTheDocument()
    expect(screen.getByText('down')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('del_1')).toBeInTheDocument()
    expect(screen.queryByText('Failed to load webhooks')).not.toBeInTheDocument()
  })

  it('opens a detail drawer with delivery details on row click', async () => {
    seedDeliveries([DELIVERY, { ...DELIVERY, id: 'del_2', status: 'retrying', attempts: 3 }])
    render(<WebhooksPage />)

    const id = await screen.findByText('del_1')
    fireEvent.click(id)

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'del_1' })).toBeInTheDocument()
    expect(within(dialog).getByText('wh_1')).toBeInTheDocument()
    expect(within(dialog).getByText('order.paid')).toBeInTheDocument()
    expect(within(dialog).getByText('success')).toBeInTheDocument()
    expect(within(dialog).getByText('200')).toBeInTheDocument()
    expect(within(dialog).getByText(/control tower/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
