import type { ReactNode } from 'react'

interface ErrorStateProps {
  title: string
  message?: string
  requestId?: string
  retriable?: boolean
  onRetry?: () => void
  children?: ReactNode
}

export function ErrorState({ title, message, requestId, retriable = true, onRetry, children }: ErrorStateProps) {
  return (
    <div className="state-card" role="alert">
      <div className="state-title">{title}</div>
      {message && <div className="state-message">{message}</div>}
      {requestId && (
        <div className="state-request-id">
          Request ID: <code>{requestId}</code>
        </div>
      )}
      {children}
      {onRetry && retriable && (
        <button className="btn" onClick={onRetry} type="button">
          Retry
        </button>
      )}
    </div>
  )
}
