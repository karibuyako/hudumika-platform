import { useEffect, useRef } from 'react'
import type { ApiErrorInfo } from '../lib/api-error'
import { useFocusTrap } from '../lib/use-focus-trap'

interface ReasonPromptProps {
  title: string
  description?: string
  reasonLabel?: string
  maxLength?: number
  required?: boolean
  confirmLabel?: string
  tone?: 'default' | 'danger'
  busy?: boolean
  error?: string | ApiErrorInfo | null
  onSubmit: (reason: string) => void
  onClose: () => void
}

/** Modal requiring a reason for a mutation — every admin mutation needs one. */
export function ReasonPrompt({
  title,
  description,
  reasonLabel = 'Reason',
  maxLength = 500,
  required = true,
  confirmLabel = 'Confirm',
  tone = 'default',
  busy = false,
  error,
  onSubmit,
  onClose,
}: ReasonPromptProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      prev?.focus()
    }
  }, [onClose])

  useFocusTrap(formRef)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const reason = inputRef.current?.value.trim() ?? ''
    if (required && !reason) return
    onSubmit(reason)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        ref={formRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">{title}</h3>
        {description && <p className="muted small">{description}</p>}
        <label className="field-label" htmlFor="reason">
          {reasonLabel}
        </label>
        <textarea
          ref={inputRef}
          id="reason"
          className="field"
          rows={3}
          maxLength={maxLength}
          required={required}
          aria-required={required}
          placeholder="Explain why this action is taken (audited)"
        />
        {error && (
          <div className="inline-error" role="alert">
            {typeof error === 'string' ? (
              error
            ) : (
              <>
                <div>{error.message}</div>
                <div className="muted small">
                  {error.code}
                  {error.requestId ? ` · request ${error.requestId}` : ''}
                </div>
              </>
            )}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={`btn${tone === 'danger' ? ' btn-danger' : ''}`} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
