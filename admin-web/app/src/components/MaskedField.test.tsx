import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MaskedField } from './MaskedField'
import { seedStaffSession } from '../lib/session'

describe('MaskedField', () => {
  it('masks a phone by default with no reveal control', () => {
    render(<MaskedField value="+255712345678" label="Phone" />)
    expect(screen.getByText('+255 ••• 678')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reveal Phone' })).not.toBeInTheDocument()
  })

  it('renders an em dash for null values', () => {
    render(<MaskedField value={null} label="Phone" />)
    expect(screen.getByText('—')).toBeInTheDocument()
    render(<MaskedField value={undefined} label="Phone" />)
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1)
  })

  it('shows a reveal button only when the session holds the permission', () => {
    seedStaffSession({ permissions: ['audit.unmask'] })
    const { unmount } = render(<MaskedField value="+255712345678" permission="audit.unmask" label="Phone" />)
    expect(screen.getByRole('button', { name: 'Reveal Phone' })).toBeInTheDocument()
    unmount()

    seedStaffSession({ permissions: ['audit.read'] })
    render(<MaskedField value="+255712345678" permission="audit.unmask" label="Phone" />)
    expect(screen.queryByRole('button', { name: 'Reveal Phone' })).not.toBeInTheDocument()
    expect(screen.getByText('Masked')).toBeInTheDocument()
    expect(screen.getByText('+255 ••• 678')).toBeInTheDocument()
  })

  it('reveals the full value and hides it again', () => {
    seedStaffSession({ permissions: ['audit.unmask'] })
    render(<MaskedField value="+255712345678" permission="audit.unmask" label="Phone" />)

    fireEvent.click(screen.getByRole('button', { name: 'Reveal Phone' }))
    expect(screen.getByText('+255712345678')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Hide Phone' }))
    expect(screen.getByText('+255 ••• 678')).toBeInTheDocument()
    expect(screen.queryByText('+255712345678')).not.toBeInTheDocument()
  })

  it('dispatches the hudumika.unmask event when revealing', () => {
    seedStaffSession({ permissions: ['audit.unmask'] })
    const events: Array<{ label: string; at: string }> = []
    const handler = (e: Event) => {
      events.push((e as CustomEvent).detail)
    }
    window.addEventListener('hudumika.unmask', handler)
    try {
      render(<MaskedField value="+255712345678" permission="audit.unmask" label="Phone" />)
      fireEvent.click(screen.getByRole('button', { name: 'Reveal Phone' }))
      expect(events).toHaveLength(1)
      expect(events[0].label).toBe('Phone')
      expect(typeof events[0].at).toBe('string')
      expect(events[0].at).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Hide Phone' }))
      expect(events).toHaveLength(1)
    } finally {
      window.removeEventListener('hudumika.unmask', handler)
    }
  })
})
