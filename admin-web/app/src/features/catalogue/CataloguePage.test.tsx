import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { CataloguePage } from './CataloguePage'
import { server } from '../../test/setup'

const FOOD: Record<string, unknown> = {
  id: 'cat_food',
  name: 'Food',
  sortOrder: 1,
  imageUrl: null,
  active: true,
}

const ELECTRONICS: Record<string, unknown> = {
  id: 'cat_tech',
  name: 'Electronics',
  sortOrder: 2,
  imageUrl: null,
  active: false,
}

const CLEANING: Record<string, unknown> = {
  id: 'svc_clean',
  name: 'Deep Cleaning',
  pricingModel: 'hourly',
  requiredSkills: ['vacuum', 'mop'],
  requiredCertifications: ['cleaning-cert'],
  defaultDurationMinutes: 90,
  requiredPhotos: 2,
  requiredEquipment: ['buckets'],
  cancellationRules: 'Free cancellation within 2 hours',
  warrantyDays: 0,
  commissionBps: 500,
  questionnaireTemplate: [{ key: 'rooms', label: 'How many rooms?', type: 'text', required: true }],
}

function seedCategories(categories: Array<Record<string, unknown>>) {
  server.use(http.get('/categories', () => HttpResponse.json(categories)))
}

function seedServiceCategories(categories: Array<Record<string, unknown>>) {
  server.use(http.get('/service-categories', () => HttpResponse.json(categories)))
}

describe('CataloguePage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads categories and renders rows with ids, descriptions and active state', async () => {
    seedCategories([FOOD, ELECTRONICS])
    render(<CataloguePage />)

    expect(await screen.findByText('Food')).toBeInTheDocument()
    expect(screen.getByText('Electronics')).toBeInTheDocument()
    expect(screen.getByText('cat_food')).toBeInTheDocument()
    expect(screen.getByText('cat_tech')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(2)
    expect(screen.getAllByText('Active')).toHaveLength(2)
    expect(screen.getByText('Inactive')).toBeInTheDocument()
  })

  it('shows an empty state when there are no categories', async () => {
    seedCategories([])
    render(<CataloguePage />)
    expect(await screen.findByText('No categories')).toBeInTheDocument()
  })

  it('shows an error state and recovers via retry', async () => {
    server.use(http.get('/categories', () => HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 })))
    render(<CataloguePage />)
    expect(await screen.findByText('Failed to load categories')).toBeInTheDocument()

    seedCategories([FOOD])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Food')).toBeInTheDocument()
  })

  it('creates a category, shows a toast and refetches the list', async () => {
    const categories: Array<Record<string, unknown>> = [{ ...FOOD }]
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/categories', () => HttpResponse.json(categories)),
      http.post('/categories', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>
        const created = {
          id: 'cat_drink',
          name: posted.name,
          sortOrder: posted.sortOrder,
          active: posted.active,
        }
        categories.push(created)
        return HttpResponse.json(created, { status: 201 })
      }),
    )
    render(<CataloguePage />)
    await screen.findByText('Food')

    fireEvent.click(screen.getByRole('button', { name: 'New category' }))
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beverages' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create category' }))

    expect(await screen.findByText('Category created')).toBeInTheDocument()
    await waitFor(() => expect(posted?.name).toBe('Beverages'))
    expect(await screen.findByText('Beverages')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('edits a category with a pre-filled modal and updates it', async () => {
    const categories: Array<Record<string, unknown>> = [{ ...FOOD }]
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/categories', () => HttpResponse.json(categories)),
      http.patch('/categories/cat_food', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>
        const saved = { ...FOOD, name: posted.name, active: posted.active }
        categories.splice(0, 1, saved)
        return HttpResponse.json(saved)
      }),
    )
    render(<CataloguePage />)
    await screen.findByText('Food')

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Food')
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Groceries' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Category updated')).toBeInTheDocument()
    await waitFor(() => expect(posted?.name).toBe('Groceries'))
    expect(await screen.findByText('Groceries')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('deletes a category with a reason, shows a toast and removes the row', async () => {
    const categories: Array<Record<string, unknown>> = [{ ...FOOD }]
    server.use(
      http.get('/categories', () => HttpResponse.json(categories)),
      http.delete('/categories/cat_food', () => {
        categories.splice(0, 1)
        return HttpResponse.json(null, { status: 204 })
      }),
    )
    render(<CataloguePage />)
    await screen.findByText('Food')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Retiring category' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('Category deleted')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Food')).not.toBeInTheDocument())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows an inline error when creating a category is forbidden', async () => {
    seedCategories([{ ...FOOD }])
    server.use(
      http.post('/categories', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<CataloguePage />)
    await screen.findByText('Food')

    fireEvent.click(screen.getByRole('button', { name: 'New category' }))
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Snacks' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create category' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText('Category created')).not.toBeInTheDocument()
  })

  it('shows an inline error when deleting a category is forbidden', async () => {
    seedCategories([{ ...FOOD }])
    server.use(
      http.delete('/categories/cat_food', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<CataloguePage />)
    await screen.findByText('Food')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Cleanup' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText('Category deleted')).not.toBeInTheDocument()
    expect(screen.getByText('Food')).toBeInTheDocument()
  })

  it('switches to service categories, renders the read-only table and opens the drawer', async () => {
    seedCategories([{ ...FOOD }])
    seedServiceCategories([{ ...CLEANING }])
    render(<CataloguePage />)
    await screen.findByText('Food')

    fireEvent.click(screen.getByRole('tab', { name: 'Service categories' }))
    expect(await screen.findByText('Deep Cleaning')).toBeInTheDocument()
    expect(screen.getByText('hourly')).toBeInTheDocument()
    expect(screen.getByText('vacuum')).toBeInTheDocument()
    expect(screen.getByText('cleaning-cert')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Deep Cleaning'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('svc_clean')).toBeInTheDocument()
    expect(within(dialog).getByText('500')).toBeInTheDocument()
    expect(within(dialog).getByText('Free cancellation within 2 hours')).toBeInTheDocument()
    expect(within(dialog).getByText('How many rooms?')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Categories' }))
    expect(await screen.findByText('Food')).toBeInTheDocument()
  })

  it('sorts categories by name via the column header', async () => {
    seedCategories([FOOD, ELECTRONICS])
    render(<CataloguePage />)
    await screen.findByText('Food')

    fireEvent.click(screen.getByRole('button', { name: /Name/ }))

    const table = screen.getByRole('table', { name: 'Product categories' })
    const names = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(names).toEqual(['Electronics', 'Food'])

    fireEvent.click(screen.getByRole('button', { name: /Name/ }))
    const desc = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(desc).toEqual(['Food', 'Electronics'])
  })

  it('sorts service categories by name via the column header', async () => {
    seedCategories([{ ...FOOD }])
    seedServiceCategories([{ ...CLEANING, id: 'svc_basic', name: 'Basic Clean' }, { ...CLEANING }])
    render(<CataloguePage />)
    await screen.findByText('Food')

    fireEvent.click(screen.getByRole('tab', { name: 'Service categories' }))
    await screen.findByText('Basic Clean')

    fireEvent.click(screen.getByRole('button', { name: /Name/ }))

    const table = screen.getByRole('table', { name: 'Service categories' })
    const names = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(names).toEqual(['Basic Clean', 'Deep Cleaning'])
  })

  it('exports the categories tab as CSV via the DataTable', async () => {
    seedCategories([FOOD, ELECTRONICS])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let downloadName = ''
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadName = this.download
      })
    render(<CataloguePage />)
    await screen.findByText('Food')

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(downloadName).toBe('catalogue-categories.csv')
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Name,ID,Description,Active,Actions')
    expect(csv).toContain('Food')
    expect(csv).toContain('cat_food')
    expect(revokeObjectURL).toHaveBeenCalled()
  })
})
