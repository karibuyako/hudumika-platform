import { cn } from '@/utils/cn'

export function AppBadge({
  store,
  dark,
  href,
  className,
}: {
  store: 'ios' | 'android'
  dark?: boolean
  href?: string
  className?: string
}) {
  const label = store === 'ios' ? 'App Store' : 'Google Play'
  const content = (
    <>
      {store === 'ios' ? (
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
        </svg>
      ) : (
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M3.18 23.04c.74.45 1.65.4 2.32-.1l13.2-7.62-2.8-2.78L3.18 23.04zm-1.36-1.4V2.36c0-.46.21-.89.58-1.18L13.14 12 2.4 22.54c-.37-.29-.58-.72-.58-1.9zM20.7 10.14l-2.92-1.68L15 11.2l2.8 2.78 2.9-1.68c.86-.5.86-1.76 0-2.16zM5.5 1.14l13.2 7.62-2.8 2.78L5.5 1.14z" />
        </svg>
      )}
      {href ? label : `${label} link coming soon`}
    </>
  )
  const classes = cn(
    'inline-flex items-center gap-2.5 rounded-full px-5 py-2.5 text-sm font-semibold transition',
    dark ? 'bg-surface text-ink-900 hover:bg-brand-50' : 'bg-ink-900 text-surface hover:bg-brand-600',
    !href && 'cursor-not-allowed opacity-70',
    className,
  )

  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={classes} aria-label={`Download on ${label}`}>
      {content}
    </a>
  ) : (
    <span className={classes} aria-label={`${label} link coming soon`}>
      {content}
    </span>
  )
}
