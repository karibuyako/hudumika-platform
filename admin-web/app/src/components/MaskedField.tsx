import { useState } from 'react'
import { useSession } from '../lib/session'
import { can } from '../lib/permissions'

export function maskValue(value: string): string {
  if (value.length <= 8) return '••••••••'
  const digits = value.replace(/\D/g, '')
  const head = value.startsWith('+') ? value.slice(0, 4) : value.slice(0, 3)
  return `${head} ••• ${digits.slice(-3)}`
}

export function MaskedField({
  value,
  permission,
  label,
  className,
}: {
  value: string | null | undefined
  permission?: string
  label: string
  className?: string
}) {
  const session = useSession()
  const [revealed, setRevealed] = useState(false)
  const allowed = permission ? can(session, permission) : false

  if (value == null || value === '') {
    return <span className={className}>—</span>
  }

  const showFull = allowed && revealed

  function toggle() {
    if (showFull) {
      setRevealed(false)
    } else {
      setRevealed(true)
      window.dispatchEvent(
        new CustomEvent('hudumika.unmask', {
          detail: { label, at: new Date().toISOString() },
        }),
      )
    }
  }

  return (
    <span className={className}>
      {showFull ? <span className="mono">{value}</span> : <span className="masked">{maskValue(value)}</span>}
      {allowed ? (
        <button className="btn" type="button" onClick={toggle} aria-label={`${showFull ? 'Hide' : 'Reveal'} ${label}`}>
          {showFull ? 'Hide' : 'Reveal'}
        </button>
      ) : (
        <span className="muted small">Masked</span>
      )}
    </span>
  )
}
