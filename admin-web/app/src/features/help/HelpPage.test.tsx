import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { HelpPage } from './HelpPage'
import { server } from '../../test/setup'

describe('HelpPage', () => {
  it('creates a help article with a toast and success summary', async () => {
    server.use(
      http.post('/admin/help/articles', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        expect(body).toMatchObject({
          title: 'How to reset my password',
          category: 'Account',
          body: 'Step-by-step guide.',
          published: false,
        })
        return HttpResponse.json(
          { id: 'art_1', title: 'How to reset my password', category: 'Account' },
          { status: 201 },
        )
      }),
    )
    render(<HelpPage />)

    fireEvent.change(await screen.findByLabelText(/title/i), {
      target: { value: 'How to reset my password' },
    })
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: 'Account' } })
    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: 'Step-by-step guide.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save article' }))

    expect(await screen.findByText('Article created')).toBeInTheDocument()
    expect(screen.getByText(/Article created — art_1/)).toBeInTheDocument()
    expect(screen.getByText('art_1')).toBeInTheDocument()
    expect(screen.getByText('How to reset my password')).toBeInTheDocument()
  })

  it('shows an inline error when the title is empty without calling the API', async () => {
    render(<HelpPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Save article' }))

    expect(await screen.findByText('Title is required')).toBeInTheDocument()
    expect(screen.queryByText(/Article created/)).not.toBeInTheDocument()
  })

  it('queues a broadcast and shows campaign id and recipient count', async () => {
    server.use(
      http.post('/admin/notifications/send', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        expect(body.title).toBe('Weekend sale')
        expect(body.body).toBe('Everything 20% off.')
        return HttpResponse.json(
          { campaignId: 'cmp_1', estimatedRecipients: 1200 },
          { status: 202 },
        )
      }),
    )
    render(<HelpPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Broadcast' }))
    fireEvent.change(await screen.findByLabelText(/title/i), { target: { value: 'Weekend sale' } })
    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: 'Everything 20% off.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send broadcast' }))

    expect(await screen.findByText('Broadcast queued')).toBeInTheDocument()
    expect(screen.getByText('cmp_1')).toBeInTheDocument()
    expect(screen.getByText('1,200')).toBeInTheDocument()
  })

  it('shows an inline error when a broadcast is forbidden', async () => {
    server.use(
      http.post('/admin/notifications/send', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<HelpPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Broadcast' }))
    fireEvent.change(await screen.findByLabelText(/title/i), { target: { value: 'Weekend sale' } })
    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: 'Everything 20% off.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send broadcast' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.queryByText('Broadcast queued')).not.toBeInTheDocument()
  })

  it('validates the broadcast form without calling the API', async () => {
    render(<HelpPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Broadcast' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Send broadcast' }))

    expect(await screen.findByText('Title is required')).toBeInTheDocument()
    expect(screen.queryByText('Broadcast queued')).not.toBeInTheDocument()
  })
})
