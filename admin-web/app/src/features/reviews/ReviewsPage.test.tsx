import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { ReviewsPage } from './ReviewsPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'
import { toLocal } from '../../lib/time'

const REVIEW = {
  id: 'rev_1',
  targetType: 'order',
  targetId: 'ord_9',
  authorName: 'Neema',
  rating: 4,
  body: 'Fast and fresh',
  state: 'published',
  createdAt: '2026-08-01T10:00:00.000Z',
}

function lookup(id: string) {
  fireEvent.change(screen.getByLabelText('Review ID'), { target: { value: id } })
  fireEvent.click(screen.getByRole('button', { name: 'Look up review' }))
}

function confirm(reason: string) {
  const modal = screen.getByRole('dialog', { name: 'Moderate review' })
  fireEvent.change(within(modal).getByLabelText('Reason'), { target: { value: reason } })
  fireEvent.click(within(modal).getByRole('button', { name: 'Confirm' }))
}

describe('ReviewsPage', () => {
  it('shows the lookup form and explanation on initial load', () => {
    render(<ReviewsPage />)

    expect(screen.getByText('Review moderation is keyed by review ID')).toBeInTheDocument()
    expect(screen.getByText('Open the review from a dispute, order, or report.')).toBeInTheDocument()
    expect(screen.getByLabelText('Review ID')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Look up review' })).toBeInTheDocument()
  })

  it('opens the moderation panel with the entered review ID', () => {
    render(<ReviewsPage />)
    lookup('rev_123')

    expect(screen.getByText('Moderate review')).toBeInTheDocument()
    expect(screen.getByText('rev_123')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('publishes a review after entering a reason and shows the result', async () => {
    let posted: Record<string, unknown> | null = null
    server.use(
      http.post('/admin/reviews/moderate', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ...REVIEW, state: 'published' })
      }),
    )
    render(<ReviewsPage />)
    lookup('rev_1')

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    confirm('Review content is accurate')

    expect(await screen.findByRole('status')).toHaveTextContent('Review rev_1 published')
    await waitFor(() => expect(posted?.action).toBe('publish'))
    await waitFor(() => expect(posted?.reviewId).toBe('rev_1'))
    await waitFor(() => expect(posted?.reason).toBe('Review content is accurate'))
    expect(screen.queryByRole('dialog', { name: 'Moderate review' })).not.toBeInTheDocument()

    expect(screen.getByText('published')).toBeInTheDocument()
    expect(screen.getByText('rating 4 / 5')).toBeInTheDocument()
    expect(screen.getByText('Neema')).toBeInTheDocument()
    expect(screen.getByText('ord_9')).toBeInTheDocument()
    expect(screen.getByText(toLocal(REVIEW.createdAt))).toBeInTheDocument()
    expect(screen.getByText('Fast and fresh')).toBeInTheDocument()
    expect(screen.getByText('Session history')).toBeInTheDocument()
  })

  it('deletes a review with a reason and logs it to session history', async () => {
    server.use(
      http.post('/admin/reviews/moderate', () => HttpResponse.json({ ...REVIEW, state: 'deleted' })),
    )
    render(<ReviewsPage />)
    lookup('rev_1')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    confirm('Repeat spam content')

    expect(await screen.findByRole('status')).toHaveTextContent('Review rev_1 deleted')
    expect(screen.getByText('deleted')).toBeInTheDocument()
    expect(screen.getByText('Session history')).toBeInTheDocument()
    expect(screen.getByText('Repeat spam content')).toBeInTheDocument()
    expect(screen.getByText('delete')).toBeInTheDocument()
  })

  it('keeps the panel and shows an inline error on 403 denial', async () => {
    server.use(
      http.post('/admin/reviews/moderate', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission', requestId: 'req_1' }, { status: 403 }),
      ),
    )
    render(<ReviewsPage />)
    lookup('rev_1')

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    confirm('Attempting to publish')

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Moderate review' })).not.toBeInTheDocument()
    expect(screen.queryByText('Session history')).not.toBeInTheDocument()
  })

  it('does not open the panel for an empty review ID', () => {
    render(<ReviewsPage />)

    const button = screen.getByRole('button', { name: 'Look up review' })
    expect(button).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Review ID'), { target: { value: '   ' } })
    expect(button).toBeDisabled()
    fireEvent.click(button)

    expect(screen.queryByText('Moderate review')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Review ID'), { target: { value: 'rev_1' } })
    expect(button).toBeEnabled()
  })

  it('hides the lookup and moderation flow without review.moderate', () => {
    seedStaffSession({ permissions: ['audit.read'] })
    render(<ReviewsPage />)

    expect(screen.getByText('Review moderation requires review.moderate')).toBeInTheDocument()
    expect(screen.queryByLabelText('Review ID')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Look up review' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hide' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })
})
