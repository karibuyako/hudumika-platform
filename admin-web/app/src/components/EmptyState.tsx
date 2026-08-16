interface EmptyStateProps {
  title: string
  hint?: string
  action?: { label: string; onClick: () => void }
}

export function EmptyState({ title, hint, action }: EmptyStateProps) {
  return (
    <div className="state-card">
      <div className="state-title">{title}</div>
      {hint && <div className="state-message">{hint}</div>}
      {action && (
        <button className="btn" onClick={action.onClick} type="button">
          {action.label}
        </button>
      )}
    </div>
  )
}
