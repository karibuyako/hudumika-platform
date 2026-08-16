import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { CitiesPage } from './CitiesPage'
import { server } from '../../test/setup'

const DAR: Record<string, unknown> = {
  id: 'city_dar',
  name: 'Dar es Salaam',
  country: 'Tanzania',
  serviceAreas: [
    { id: 'kinondoni', name: 'Kinondoni', polygon: ['-6.75,39.2', '-6.80,39.3'] },
    { id: 'ilala', name: 'Ilala' },
  ],
}

const DODOMA: Record<string, unknown> = {
  id: 'city_dod',
  name: 'Dodoma',
  country: 'Tanzania',
}

function seedCities(cities: Array<Record<string, unknown>>) {
  server.use(http.get('/cities', () => HttpResponse.json(cities)))
}

describe('CitiesPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads cities and renders rows with service area tags and ids', async () => {
    seedCities([DAR, DODOMA])
    render(<CitiesPage />)

    expect(await screen.findByText('Dar es Salaam')).toBeInTheDocument()
    expect(screen.getByText('Dodoma')).toBeInTheDocument()
    expect(screen.getAllByText('Tanzania')).toHaveLength(2)
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('Kinondoni')).toBeInTheDocument()
    expect(screen.getByText('Ilala')).toBeInTheDocument()
    expect(screen.getByText('city_dar')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('shows an empty state when no cities are configured', async () => {
    seedCities([])
    render(<CitiesPage />)
    expect(await screen.findByText('No cities configured')).toBeInTheDocument()
  })

  it('shows an error state and recovers via retry', async () => {
    server.use(http.get('/cities', () => HttpResponse.json({ code: 'X', message: 'down' }, { status: 500 })))
    render(<CitiesPage />)
    expect(await screen.findByText('Failed to load cities')).toBeInTheDocument()

    seedCities([DAR])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Dar es Salaam')).toBeInTheDocument()
  })

  it('opens a drawer with city details and service area polygon presence', async () => {
    seedCities([DAR])
    render(<CitiesPage />)
    fireEvent.click(await screen.findByText('Dar es Salaam'))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Tanzania')).toBeInTheDocument()
    expect(within(dialog).getByText('city_dar')).toBeInTheDocument()
    expect(within(dialog).getByText('Kinondoni')).toBeInTheDocument()
    expect(within(dialog).getByText('2 polygon points')).toBeInTheDocument()
    expect(within(dialog).getByText('—')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Edit city' })).toBeInTheDocument()
  })

  it('creates a city, posts mapped service areas, shows a toast and refetches', async () => {
    const cities: Array<Record<string, unknown>> = [{ ...DODOMA }]
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/cities', () => HttpResponse.json(cities)),
      http.post('/admin/cities', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>
        const created = {
          id: 'city_ar',
          name: posted.name,
          country: posted.country,
          serviceAreas: posted.serviceAreas,
        }
        cities.push(created)
        return HttpResponse.json(created)
      }),
    )
    render(<CitiesPage />)
    await screen.findByText('Dodoma')

    fireEvent.click(screen.getByRole('button', { name: 'New city' }))
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Arusha' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'Tanzania' } })
    fireEvent.change(screen.getByLabelText('Service areas'), { target: { value: 'Ngorongoro' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create city' }))

    expect(await screen.findByText('City saved')).toBeInTheDocument()
    await waitFor(() => expect(posted?.name).toBe('Arusha'))
    await waitFor(() => expect(posted?.country).toBe('Tanzania'))
    await waitFor(() => expect(posted?.serviceAreas).toEqual([{ id: 'ngorongoro', name: 'Ngorongoro' }]))
    expect(await screen.findByText('Arusha')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('edits a city from the drawer via the pre-filled modal and re-upserts', async () => {
    const cities: Array<Record<string, unknown>> = [{ ...DAR }]
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/cities', () => HttpResponse.json(cities)),
      http.post('/admin/cities', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>
        const saved = {
          id: 'city_dar',
          name: posted.name,
          country: posted.country,
          serviceAreas: posted.serviceAreas,
        }
        cities.splice(0, 1, saved)
        return HttpResponse.json(saved)
      }),
    )
    render(<CitiesPage />)
    fireEvent.click(await screen.findByText('Dar es Salaam'))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: 'Edit city' }))
    const dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Dar es Salaam')
    expect((within(dialog).getByLabelText('Service areas') as HTMLInputElement).value).toBe('Kinondoni, Ilala')
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Dar' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('City saved')).toBeInTheDocument()
    await waitFor(() => expect(posted?.name).toBe('Dar'))
    await waitFor(() => expect(posted?.id).toBe('city_dar'))
    expect(await screen.findByText('Dar')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows an inline error when saving a city is forbidden', async () => {
    seedCities([{ ...DODOMA }])
    server.use(
      http.post('/admin/cities', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission' }, { status: 403 }),
      ),
    )
    render(<CitiesPage />)
    await screen.findByText('Dodoma')

    fireEvent.click(screen.getByRole('button', { name: 'New city' }))
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mwanza' } })
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'Tanzania' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create city' }))

    expect(await screen.findByText('no permission')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText('City saved')).not.toBeInTheDocument()
  })

  it('sorts rows by name via the column header', async () => {
    seedCities([DAR, DODOMA])
    render(<CitiesPage />)
    await screen.findByText('Dar es Salaam')

    fireEvent.click(screen.getByRole('button', { name: /Name/ }))

    const table = screen.getByRole('table', { name: 'Cities' })
    const names = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(names).toEqual(['Dar es Salaam', 'Dodoma'])

    fireEvent.click(screen.getByRole('button', { name: /Name/ }))
    const desc = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)
    expect(desc).toEqual(['Dodoma', 'Dar es Salaam'])
  })

  it('exports cities as CSV via the DataTable', async () => {
    seedCities([DAR])
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let downloadName = ''
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadName = this.download
      })
    render(<CitiesPage />)
    await screen.findByText('Dar es Salaam')

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(downloadName).toBe('cities.csv')
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const csv = await blob.text()
    expect(csv).toContain('Name,Country,Service areas,ID')
    expect(csv).toContain('Dar es Salaam')
    expect(csv).toContain('Tanzania')
    expect(csv).toContain('city_dar')
    expect(revokeObjectURL).toHaveBeenCalled()
  })
})
