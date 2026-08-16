import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ConfirmDialog } from './ConfirmDialog'
import { ReasonPrompt } from './ReasonPrompt'

describe('dialog a11y — focus management', () => {
  it('ConfirmDialog (DetailDrawer) moves focus in on open, traps Tab, returns focus on close', () => {
    const opener = document.createElement('button')
    opener.textContent = 'Opener'
    document.body.appendChild(opener)
    opener.focus()

    const { unmount } = render(
      <ConfirmDialog title="Delete thing" description="Are you sure?" onClose={vi.fn()} onConfirm={vi.fn()} />,
    )

    const dialog = screen.getByRole('dialog', { name: 'Delete thing' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()

    const confirm = screen.getByRole('button', { name: 'Confirm' })
    confirm.focus()
    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()

    const close = screen.getByRole('button', { name: 'Close' })
    close.focus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()

    unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })

  it('ReasonPrompt focuses the reason field on open, traps Tab, returns focus on close', () => {
    const opener = document.createElement('button')
    opener.textContent = 'Opener'
    document.body.appendChild(opener)
    opener.focus()

    const { unmount } = render(<ReasonPrompt title="Approve refund" onClose={vi.fn()} onSubmit={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: 'Approve refund' })).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByLabelText('Reason')).toHaveFocus()

    const confirm = screen.getByRole('button', { name: 'Confirm' })
    confirm.focus()
    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(screen.getByLabelText('Reason')).toHaveFocus()

    const reason = screen.getByLabelText('Reason')
    reason.focus()
    fireEvent.keyDown(reason, { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()

    unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })
})
