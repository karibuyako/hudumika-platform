import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { DataTable, type DataTableColumn } from './DataTable'

interface Row {
  id: string
  name: string
  value: number
}

const rows: Row[] = [
  { id: 'a', name: 'Alpha', value: 30 },
  { id: 'b', name: 'Beta', value: 10 },
  { id: 'c', name: 'Gamma', value: 20 },
]

const columns: DataTableColumn<Row>[] = [
  { key: 'id', header: 'ID', render: (r) => r.id, sortValue: (r) => r.id },
  { key: 'name', header: 'Name', render: (r) => r.name },
  { key: 'value', header: 'Value', render: (r) => r.value, sortValue: (r) => r.value, align: 'right' },
]

function firstColumnTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent ?? '')
}

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe('DataTable', () => {
  it('renders rows', () => {
    render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
  })

  it('sorts ascending then descending on a numeric column', () => {
    const { container } = render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} />)
    const header = screen.getByRole('button', { name: /Value/ })

    fireEvent.click(header)
    expect(firstColumnTexts(container)).toEqual(['b', 'c', 'a'])
    expect(screen.getByText('Value ▲').textContent).toContain('▲')

    fireEvent.click(header)
    expect(firstColumnTexts(container)).toEqual(['a', 'c', 'b'])
    expect(screen.getByText('Value ▼').textContent).toContain('▼')
  })

  it('paginates and disables buttons at the ends', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `r${i + 1}`, name: `Row ${i + 1}`, value: i }))
    render(<DataTable rows={many} columns={columns} rowKey={(r) => r.id} pageSize={2} />)

    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Prev' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
    expect(screen.getByText('Row 1')).toBeInTheDocument()
    expect(screen.queryByText('Row 3')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument()
    expect(screen.getByText('Row 3')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Prev' }))
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Prev' })).toBeEnabled()
  })

  it('shows the empty state with the given title', () => {
    render(<DataTable rows={[]} columns={columns} rowKey={(r) => r.id} emptyTitle="Nothing here" emptyHint="Try again later" />)
    expect(screen.getByText('Nothing here')).toBeInTheDocument()
    expect(screen.getByText('Try again later')).toBeInTheDocument()
  })

  it('shows a loading skeleton when loading with no rows', () => {
    render(<DataTable rows={[]} columns={columns} rowKey={(r) => r.id} loading />)
    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
  })

  it('shows an inline error and fires retry', () => {
    const onRetry = vi.fn()
    render(<DataTable rows={[]} columns={columns} rowKey={(r) => r.id} error="Boom" onRetry={onRetry} />)
    expect(screen.getByText('Boom')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('calls onRowClick when a row is clicked', () => {
    const onRowClick = vi.fn()
    render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} onRowClick={onRowClick} />)
    fireEvent.click(screen.getByText('Alpha'))
    expect(onRowClick).toHaveBeenCalledWith(rows[0])
  })

  it('moves focus with J/K and opens the focused row with Enter', () => {
    const onRowClick = vi.fn()
    const { container } = render(
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} onRowClick={onRowClick} ariaLabel="Orders" />,
    )
    const table = container.querySelector('table')!

    fireEvent.keyDown(table, { key: 'J' })
    expect(table.querySelector('tbody')).toHaveAttribute('aria-activedescendant', 'Orders-row-a')

    fireEvent.keyDown(table, { key: 'Enter' })
    expect(onRowClick).toHaveBeenCalledWith(rows[0])

    fireEvent.keyDown(table, { key: 'J' })
    fireEvent.keyDown(table, { key: 'J' })
    fireEvent.keyDown(table, { key: 'K' })
    fireEvent.keyDown(table, { key: 'Enter' })
    expect(onRowClick).toHaveBeenLastCalledWith(rows[1])
  })

  it('exports CSV and dispatches the audit event', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} exportable exportFileName="orders" />)
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)

    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(await blob.text()).toBe('ID,Name,Value\r\na,Alpha,30\r\nb,Beta,10\r\nc,Gamma,20\r\n')

    const event = dispatchSpy.mock.calls.map((c) => c[0]).find((e) => e.type === 'hudumika.export')
    expect(event).toBeDefined()
    expect((event as CustomEvent).detail).toEqual({ filename: 'orders', rowCount: 3 })
  })

  it('highlights the selected row', () => {
    render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} selectedRowKey="b" />)
    const selected = screen.getByText('Beta').closest('tr')!
    expect(selected.classList).toContain('row-selected')
    expect(screen.getByText('Alpha').closest('tr')!.classList).not.toContain('row-selected')
  })

  it('does not render a Columns button without a tableId', () => {
    render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} exportable />)
    expect(screen.queryByRole('button', { name: 'Toggle columns' })).not.toBeInTheDocument()
  })

  it('toggles column visibility from the Columns menu and persists to sessionStorage', () => {
    const { container } = render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} tableId="customers" />)
    const thead = container.querySelector('thead')!

    fireEvent.click(screen.getByRole('button', { name: 'Toggle columns' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Value column' }))

    expect(within(thead).queryByText('Value')).not.toBeInTheDocument()
    expect(within(thead).getByText('ID')).toBeInTheDocument()
    expect(within(thead).getByText('Name')).toBeInTheDocument()
    expect(screen.queryByText('30')).not.toBeInTheDocument()
    expect(JSON.parse(sessionStorage.getItem('hudumika.columns.customers')!)).toEqual(['id', 'name'])

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Value column' }))
    expect(within(thead).getByText('Value')).toBeInTheDocument()
    expect(JSON.parse(sessionStorage.getItem('hudumika.columns.customers')!)).toEqual(['id', 'name', 'value'])
  })

  it('keeps at least one column visible when unchecking', () => {
    const { container } = render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} tableId="customers" />)
    const thead = container.querySelector('thead')!

    fireEvent.click(screen.getByRole('button', { name: 'Toggle columns' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Value column' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show ID column' }))

    const nameCheckbox = screen.getByRole('checkbox', { name: 'Show Name column' })
    expect(nameCheckbox).toBeChecked()
    fireEvent.click(nameCheckbox)

    expect(nameCheckbox).toBeChecked()
    expect(within(thead).getByText('Name')).toBeInTheDocument()
  })

  it('restores the visible column set from sessionStorage', () => {
    sessionStorage.setItem('hudumika.columns.customers', JSON.stringify(['id', 'value']))
    const { container } = render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} tableId="customers" />)
    const thead = container.querySelector('thead')!

    expect(within(thead).getByText('ID')).toBeInTheDocument()
    expect(within(thead).getByText('Value')).toBeInTheDocument()
    expect(within(thead).queryByText('Name')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle columns' }))
    expect(screen.getByRole('checkbox', { name: 'Show Name column' })).not.toBeChecked()
  })

  it('excludes hidden columns from the CSV export', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    render(
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} tableId="customers" exportable exportFileName="orders" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Toggle columns' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Value column' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(await blob.text()).toBe('ID,Name\r\na,Alpha\r\nb,Beta\r\nc,Gamma\r\n')
    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })
})
