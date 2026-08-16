import { QrCode } from 'lucide-react'
import { cn } from '@/utils/cn'

export function QrBox({
  app,
  dark,
  className,
}: {
  app: string
  dark?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex h-32 w-32 flex-col items-center justify-center gap-2 rounded-2xl p-3',
        dark ? 'bg-surface' : 'bg-paper ring-1 ring-line',
        className,
      )}
    >
      <QrCode className={cn('h-14 w-14', dark ? 'text-ink-900' : 'text-ink-700')} />
      <span className={cn('text-[10px] font-semibold', dark ? 'text-ink-500' : 'text-ink-500')}>
        Scan to get the {app} app
      </span>
    </div>
  )
}
