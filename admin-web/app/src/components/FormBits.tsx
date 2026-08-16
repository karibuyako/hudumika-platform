import type { ReactNode } from 'react'

interface ToastProps {
  message: string
}

/** Inline success notice — dismisses on next action. */
export function Toast({ message }: ToastProps) {
  return (
    <div className="notice" role="status">
      {message}
    </div>
  )
}

export function InlineError({ message }: { message: string }) {
  return (
    <div className="inline-error" role="alert">
      {message}
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field-block">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}
