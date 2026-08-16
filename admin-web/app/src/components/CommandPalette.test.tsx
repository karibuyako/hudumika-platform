import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CommandPalette, type PaletteItem } from './CommandPalette'

const items: PaletteItem[] = [
  { id: 'a', label: 'Orders', group: 'Commerce', to: '/commerce/orders' },
  { id: 'b', label: 'Bookings', group: 'Commerce', to: '/bookings' },
  { id: 'c', label: 'Riders', group: 'Logistics', to: '/logistics/riders' },
  { id: 'd', label: 'Audit Logs', group: 'Audit', to: '/audit/logs' },
]

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    render(<CommandPalette open={false} onClose={vi.fn()} items={items} onNavigate={vi.fn()} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Palette query')).not.toBeInTheDocument()
  })

  it('opens and shows items', () => {
    render(<CommandPalette open onClose={vi.fn()} items={items} onNavigate={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
    expect(screen.getByLabelText('Palette query')).toBeInTheDocument()
    expect(screen.getByText('Orders')).toBeInTheDocument()
    expect(screen.getByText('Riders')).toBeInTheDocument()
    expect(screen.getByText('Audit Logs')).toBeInTheDocument()
  })

  it('filters by query', () => {
    render(<CommandPalette open onClose={vi.fn()} items={items} onNavigate={vi.fn()} />)
    const input = screen.getByLabelText('Palette query')

    fireEvent.change(input, { target: { value: 'rid' } })
    expect(screen.getByText('Riders')).toBeInTheDocument()
    expect(screen.queryByText('Orders')).not.toBeInTheDocument()
    expect(screen.queryByText('Audit Logs')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'commerce' } })
    expect(screen.getByText('Orders')).toBeInTheDocument()
    expect(screen.getByText('Bookings')).toBeInTheDocument()
    expect(screen.queryByText('Riders')).not.toBeInTheDocument()
  })

  it('arrow Down + Enter selects and calls onNavigate with the right item', () => {
    const onNavigate = vi.fn()
    render(<CommandPalette open onClose={vi.fn()} items={items} onNavigate={onNavigate} />)
    const input = screen.getByLabelText('Palette query')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledWith(items[1])
  })

  it('Escape calls onClose', () => {
    const onClose = vi.fn()
    render(<CommandPalette open onClose={onClose} items={items} onNavigate={vi.fn()} />)
    fireEvent.keyDown(screen.getByLabelText('Palette query'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders items grouped by group', () => {
    render(<CommandPalette open onClose={vi.fn()} items={items} onNavigate={vi.fn()} />)
    expect(screen.getByText('Commerce')).toBeInTheDocument()
    expect(screen.getByText('Logistics')).toBeInTheDocument()
    expect(screen.getByText('Audit')).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(4)
  })
})
