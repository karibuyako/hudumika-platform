import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { ContentPage } from './ContentPage'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'

const BANNER: Record<string, unknown> = {
  id: 'bnr_1',
  title: 'Summer Sale',
  imageUrl: 'https://cdn.example.com/summer.jpg',
  description: 'Up to 50% off everything',
  link: 'https://hudumika.co.tz/sale',
  placement: 'home_top',
  active: true,
  scheduledFrom: '2026-08-01T00:00:00.000Z',
  scheduledTo: '2026-08-31T23:59:59.000Z',
  clicks: 1200,
  impressions: 45000,
  createdAt: '2026-07-20T10:00:00.000Z',
}

const TEMPLATE: Record<string, unknown> = {
  key: 'order_confirmation',
  channel: 'email',
  subject: 'Your order is confirmed',
  body: 'Hello {{firstName}}, your order {{orderNo}} is confirmed.',
  variables: ['firstName', 'orderNo'],
  active: true,
  updatedAt: '2026-07-25T09:00:00.000Z',
}

function seedBanners(banners: Array<Record<string, unknown>>) {
  server.use(http.get('/admin/banners', () => HttpResponse.json(banners)))
}

describe('ContentPage', () => {
  it('loads and renders banners; placement chip filters the rows', async () => {
    seedBanners([
      { ...BANNER },
      { ...BANNER, id: 'bnr_2', title: 'Winter Sale', placement: 'category', active: false, clicks: 0 },
    ])
    render(<ContentPage />)

    expect(await screen.findByText('Summer Sale')).toBeInTheDocument()
    expect(screen.getByText('Winter Sale')).toBeInTheDocument()
    expect(screen.getAllByText('Active')).toHaveLength(2)
    expect(screen.getAllByText('Inactive')).toHaveLength(1)
    expect(screen.getByText('1200')).toBeInTheDocument()
    expect(screen.getAllByText('home_top')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: /category/ }))
    await waitFor(() => expect(screen.queryByText('Summer Sale')).not.toBeInTheDocument())
    expect(screen.getByText('Winter Sale')).toBeInTheDocument()
  })

  it('shows an empty state when there are no banners', async () => {
    seedBanners([])
    render(<ContentPage />)
    expect(await screen.findByText('No banners')).toBeInTheDocument()
  })

  it('shows an error state and recovers via retry', async () => {
    server.use(http.get('/admin/banners', () => HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 })))
    render(<ContentPage />)
    expect(await screen.findByText('Failed to load banners')).toBeInTheDocument()

    seedBanners([{ ...BANNER }])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Summer Sale')).toBeInTheDocument()
  })

  it('creates a banner, shows a toast and refetches the list', async () => {
    const banners = [{ ...BANNER }]
    server.use(
      http.get('/admin/banners', () => HttpResponse.json(banners)),
      http.post('/admin/banners', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        const created = {
          ...BANNER,
          id: 'bnr_2',
          title: String(body.title),
          placement: body.placement,
          active: Boolean(body.active),
        }
        banners.push(created)
        return HttpResponse.json(created, { status: 201 })
      }),
    )
    render(<ContentPage />)
    await screen.findByText('Summer Sale')

    fireEvent.click(screen.getByRole('button', { name: 'New banner' }))
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New Year Deal' } })
    fireEvent.change(screen.getByLabelText('Placement'), { target: { value: 'home_middle' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create banner' }))

    expect(await screen.findByText('Banner created')).toBeInTheDocument()
    expect(await screen.findByText('New Year Deal')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('deletes a banner with a reason, shows a toast and removes the row', async () => {
    const banners = [{ ...BANNER }]
    server.use(
      http.get('/admin/banners', () => HttpResponse.json(banners)),
      http.delete('/admin/banners/bnr_1', () => {
        banners.splice(0, 1)
        return HttpResponse.json(null, { status: 204 })
      }),
    )
    render(<ContentPage />)
    await screen.findByText('Summer Sale')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Promo ended' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('Banner deleted')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Summer Sale')).not.toBeInTheDocument())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('switches to the templates tab, renders templates, opens the drawer and upserts', async () => {
    const templates = [{ ...TEMPLATE }]
    server.use(
      http.get('/admin/templates', () => HttpResponse.json(templates)),
      http.put('/admin/templates', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        const saved = {
          ...TEMPLATE,
          key: String(body.key),
          channel: body.channel,
          subject: String(body.subject),
        }
        templates.push(saved)
        return HttpResponse.json(saved)
      }),
    )
    render(<ContentPage />)

    fireEvent.click(screen.getByRole('tab', { name: 'Templates' }))
    expect(await screen.findByText('order_confirmation')).toBeInTheDocument()

    fireEvent.click(screen.getByText('order_confirmation'))
    await screen.findByRole('dialog')
    expect(
      screen.getByText('Hello {{firstName}}, your order {{orderNo}} is confirmed.'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    fireEvent.click(screen.getByRole('button', { name: 'Upsert template' }))
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'order_update' } })
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Your order is on the way' } })
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Rider {{riderName}} is on the way.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }))

    expect(await screen.findByText('Template saved')).toBeInTheDocument()
    expect(await screen.findByText('order_update')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows an inline error when banner deletion is forbidden', async () => {
    seedBanners([{ ...BANNER }])
    server.use(
      http.delete('/admin/banners/bnr_1', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<ContentPage />)
    await screen.findByText('Summer Sale')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Cleaning up' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText('Banner deleted')).not.toBeInTheDocument()
    expect(screen.getByText('Summer Sale')).toBeInTheDocument()
  })

  it('hides all mutation controls without configuration.edit', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    seedBanners([{ ...BANNER }])
    server.use(http.get('/admin/templates', () => HttpResponse.json([{ ...TEMPLATE }])))
    render(<ContentPage />)

    await screen.findByText('Summer Sale')
    expect(screen.getByText('Content edits require configuration.edit')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New banner' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Templates' }))
    await screen.findByText('order_confirmation')
    expect(screen.queryByRole('button', { name: 'Upsert template' })).not.toBeInTheDocument()
  })
})
