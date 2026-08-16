import type { ReactNode } from 'react'
import { DetailDrawer } from './DetailDrawer'

interface ConfirmDialogProps {
  title: string
  description?: ReactNode
  confirmLabel?: string
  tone?: 'default' | 'danger'
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}

/** Confirm dialog for low-risk confirmations; dangerous mutations use ReasonPrompt. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel = 'Confirm',
  tone = 'default',
  busy = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <DetailDrawer title={title} onClose={onClose}>
      <p className="muted">{description}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={`btn${tone === 'danger' ? ' btn-danger' : ''}`} onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </DetailDrawer>
  )
}
