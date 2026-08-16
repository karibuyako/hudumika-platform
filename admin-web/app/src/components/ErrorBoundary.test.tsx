import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { ErrorBoundary } from './ErrorBoundary'

function HealthyChild() {
  return <div>All good</div>
}

function ThrowingChild(): ReactNode {
  throw new Error('boom')
}

function ClickToThrow() {
  const [armed, setArmed] = useState(false)
  if (armed) throw new Error('kaboom')
  return (
    <button type="button" onClick={() => setArmed(true)}>
      Explode
    </button>
  )
}

describe('ErrorBoundary', () => {
  it('renders healthy children normally', () => {
    render(
      <ErrorBoundary>
        <HealthyChild />
      </ErrorBoundary>,
    )
    expect(screen.getByText('All good')).toBeInTheDocument()
  })

  it('shows error UI with Reload when a child throws during render', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Unexpected error')).toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    consoleError.mockRestore()
  })

  it('shows error UI when a child throws from a button click', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorBoundary>
        <ClickToThrow />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('button', { name: 'Explode' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Explode' }))
    expect(screen.getByText('Unexpected error')).toBeInTheDocument()
    expect(screen.getByText('kaboom')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    consoleError.mockRestore()
  })

  it('Reload button triggers a full page reload', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const reload = vi.fn()
    Object.defineProperty(window, 'location', { writable: true, value: { reload } })
    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })
})
