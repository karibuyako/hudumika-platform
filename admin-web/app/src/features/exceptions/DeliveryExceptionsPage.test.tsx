import { afterEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import type { DeliveryException } from '@hudumika/contract'
import { server } from '../../test/setup'
import { DeliveryExceptionsPage } from './DeliveryExceptionsPage'

const exception = (over: Partial<DeliveryException> = {}): DeliveryException => ({
  id: 'exc_1',
  kind: 'missing_package',
  shipmentId: 'shp_1',
  orderId: 'ord_1',
  tripId: null,
  description: 'One package unaccounted for after hub sort',
  reportedBy: 'system',
  status: 'open',
  outcome: null,
  autoReplanned: true,
  createdAt: '2026-08-12T10:00:00.000Z',
  resolvedAt: null,
  ...over,
})

function listHandler(...exceptions: DeliveryException[]) {
  return http.get('*/delivery-exceptions', () => HttpResponse.json(exceptions))
}

describe('DeliveryExceptionsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('renders rows after loading', async () => {
    server.use(
      listHandler(
        exception(),
        exception({ id: 'exc_2', kind: 'vehicle_breakdown', shipmentId: null, orderId: 'ord_2', status: 'resolved', autoReplanned: false }),
      ),
    )
    render(<DeliveryExceptionsPage />)
    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
    expect(await screen.findByText('exc_1')).toBeInTheDocument()
    expect(screen.getByText('exc_2')).toBeInTheDocument()
    expect(
      screen.getAllByText((_, el) => el?.classList.contains('tag') === true && el?.textContent === 'missing package'),
    ).toHaveLength(1)
    expect(
      screen.getAllByText((_, el) => el?.classList.contains('tag') === true && el?.textContent === 'vehicle breakdown'),
    ).toHaveLength(1)
    expect(
      screen.getAllByText((_, el) => el?.classList.contains('pill') === true && el?.textContent === 'open'),
    ).toHaveLength(1)
    expect(
      screen.getAllByText((_, el) => el?.classList.contains('pill') === true && el?.textContent === 'resolved'),
    ).toHaveLength(1)
    expect(screen.getAllByText('replanned')).toHaveLength(1)
  })

  test('kind chips show counts from loaded data and filter client-side', async () => {
    const user = userEvent.setup()
    const missing = exception({ id: 'exc_1', kind: 'missing_package' })
    const breakdown = exception({ id: 'exc_2', kind: 'vehicle_breakdown' })
    server.use(listHandler(missing, breakdown))
    render(<DeliveryExceptionsPage />)
    expect(await screen.findByText('exc_1')).toBeInTheDocument()
    expect(screen.getByText('exc_2')).toBeInTheDocument()

    const kindFilters = within(screen.getByRole('group', { name: 'Exception kind filters' }))
    expect(kindFilters.getByRole('button', { name: /^All/ }).querySelector('.chip-count')).toHaveTextContent('2')
    expect(kindFilters.getByRole('button', { name: /^missing package/ }).querySelector('.chip-count')).toHaveTextContent('1')
    expect(kindFilters.getByRole('button', { name: /^vehicle breakdown/ }).querySelector('.chip-count')).toHaveTextContent('1')

    await user.click(kindFilters.getByRole('button', { name: /^vehicle breakdown/ }))
    await waitFor(() => expect(screen.queryByText('exc_1')).not.toBeInTheDocument())
    expect(screen.getByText('exc_2')).toBeInTheDocument()
  })

  test('shows empty state when there are no delivery exceptions', async () => {
    server.use(listHandler())
    render(<DeliveryExceptionsPage />)
    expect(await screen.findByText('No delivery exceptions')).toBeInTheDocument()
  })

  test('shows error state and recovers via retry', async () => {
    const user = userEvent.setup()
    server.use(http.get('*/delivery-exceptions', () => new HttpResponse(null, { status: 500 })))
    render(<DeliveryExceptionsPage />)
    expect(await screen.findByText('Failed to load delivery exceptions')).toBeInTheDocument()

    server.resetHandlers()
    server.use(listHandler(exception()))
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('exc_1')).toBeInTheDocument()
  })

  test('resolve mutation succeeds with toast, refetch and PATCH body', async () => {
    const user = userEvent.setup()
    const initial = exception({ id: 'exc_1', status: 'open' })
    let rows: DeliveryException[] = [initial]
    const patchCalls: Array<{ status: string; outcome: string | null }> = []
    server.use(
      http.get('*/delivery-exceptions', () => HttpResponse.json(rows)),
      http.patch('*/delivery-exceptions/exc_1', async ({ request }) => {
        const body = (await request.json()) as { status: string; outcome: string | null }
        patchCalls.push(body)
        const updated = { ...initial, status: body.status as 'resolving' | 'resolved', outcome: body.outcome }
        rows = [updated]
        return HttpResponse.json(updated)
      }),
    )
    render(<DeliveryExceptionsPage />)
    await user.click(await screen.findByText('exc_1'))
    await user.click(screen.getByRole('button', { name: 'Mark resolving' }))

    const dialog = screen.getByRole('dialog', { name: 'Mark exception resolving' })
    await user.type(dialog.querySelector('textarea')!, 'Package located at hub 3')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Exception exc_1 marked resolving')).toBeInTheDocument()
    expect(patchCalls).toEqual([{ status: 'resolving', outcome: null }])
    await waitFor(() => {
      expect(
        screen.getByText((content, el) => el?.classList.contains('pill') === true && content === 'resolving'),
      ).toBeInTheDocument()
    })
  })

  test('409 already-resolved surfaces parseApiError inline in the prompt', async () => {
    const user = userEvent.setup()
    server.use(
      listHandler(exception({ id: 'exc_1', status: 'resolving' })),
      http.patch('*/delivery-exceptions/exc_1', () =>
        HttpResponse.json(
          { code: 'EXCEPTION_ALREADY_RESOLVED', message: 'Exception already resolved', requestId: 'req-2' },
          { status: 409 },
        ),
      ),
    )
    render(<DeliveryExceptionsPage />)
    await user.click(await screen.findByText('exc_1'))
    await user.click(screen.getByRole('button', { name: 'Resolve' }))

    const dialog = screen.getByRole('dialog', { name: 'Resolve exception' })
    await user.type(dialog.querySelector('textarea')!, 'Duplicate resolution attempt')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Exception already resolved')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Resolve exception' })).toBeInTheDocument()
  })

  test('sorts rows by status via the column header', async () => {
    const user = userEvent.setup()
    server.use(listHandler(exception(), exception({ id: 'exc_2', status: 'resolved' })))
    render(<DeliveryExceptionsPage />)
    await screen.findByText('exc_1')

    await user.click(screen.getByRole('button', { name: /Status/ }))

    const table = screen.getByRole('table', { name: 'Delivery exceptions' })
    const ids = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(ids).toEqual(['exc_1', 'exc_2'])

    await user.click(screen.getByRole('button', { name: /Status/ }))
    const desc = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(desc).toEqual(['exc_2', 'exc_1'])
  })

  test('exports delivery exceptions as CSV via the DataTable', async () => {
    const user = userEvent.setup()
    server.use(listHandler(exception()))
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let downloadName = ''
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadName = this.download
      })
    render(<DeliveryExceptionsPage />)
    await screen.findByText('exc_1')

    await user.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(downloadName).toBe('delivery-exceptions.csv')
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('ID,Kind,Status,Reference,Replanned,Created')
    expect(csv).toContain('exc_1')
    expect(csv).toContain('shp_1')
    expect(revokeObjectURL).toHaveBeenCalled()
  })
})
