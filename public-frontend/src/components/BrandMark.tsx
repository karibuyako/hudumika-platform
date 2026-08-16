import { Link } from 'react-router-dom'
import { cn } from '@/utils/cn'

export function BrandMark({
  dark,
  to = '/',
  className,
  compact,
}: {
  dark?: boolean
  to?: string
  className?: string
  compact?: boolean
}) {
  const inner = (
    <>
      <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-ink-900">
        <span className="font-display text-[18px] leading-none font-black text-white tracking-tighter">
          H
        </span>
        <span
          className={cn(
            'absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-accent',
            dark ? 'ring-2 ring-ink-900' : 'ring-2 ring-surface',
          )}
        />
      </span>
      {!compact && (
        <span className="leading-none">
          <span
            className={cn(
              'block font-display text-[18px] font-extrabold tracking-tight leading-none',
              dark ? 'text-white' : 'text-ink-900',
            )}
          >
            HUDumika
          </span>
          <span
            className={cn(
              'mt-0.5 block text-[9px] font-semibold tracking-[0.18em] leading-none',
              dark ? 'text-white/50' : 'text-ink-500',
            )}
          >
            HUDUMA KARIBU · TZ
          </span>
        </span>
      )}
    </>
  )

  return (
    <Link
      to={to}
      className={cn('flex items-center gap-2.5', className)}
      aria-label="HUDumika — back to home"
    >
      {inner}
    </Link>
  )
}
