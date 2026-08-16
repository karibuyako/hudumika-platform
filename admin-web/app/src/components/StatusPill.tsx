interface StatusPillProps {
  status: string
  tone?: 'ok' | 'bad' | 'warn' | 'info' | 'brand' | 'muted'
  label?: string
}

/** Soft status pill — status is communicated by text, never color alone. */
export function StatusPill({ status, tone = 'brand', label }: StatusPillProps) {
  return <span className={`pill pill-${tone}`}>{label ?? status.replace(/_/g, ' ')}</span>
}
