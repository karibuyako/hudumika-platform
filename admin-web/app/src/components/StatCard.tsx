import type { ReactNode } from 'react'

interface StatCardProps {
  label: string
  value: ReactNode
  tone?: 'default' | 'danger' | 'warn' | 'success'
  to?: string
  sub?: ReactNode
}

/** Stat card; `to` renders the card as a deep link (control tower → module queue). */
export function StatCard({ label, value, tone = 'default', to, sub }: StatCardProps) {
  const cls = `stat-card${tone !== 'default' ? ` ${tone}` : ''}`
  const body = (
    <>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </>
  )
  if (to) {
    return (
      <a className={cls} href={to} aria-label={`${label}: ${value}`}>
        {body}
      </a>
    )
  }
  return <div className={cls}>{body}</div>
}
