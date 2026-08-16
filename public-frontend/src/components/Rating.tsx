import { Star } from 'lucide-react'
import { cn } from '@/utils/cn'

export function Rating({
  value,
  reviews,
  className,
  size = 'md',
}: {
  value: number
  reviews?: number
  className?: string
  size?: 'sm' | 'md' | 'lg'
}) {
  const sizes = { sm: 'h-3 w-3', md: 'h-4 w-4', lg: 'h-5 w-5' }
  return (
    <span
      className={cn('inline-flex items-center gap-1.5', className)}
      role="img"
      aria-label={`Rated ${value.toFixed(1)} out of 5${reviews ? `, ${reviews.toLocaleString()} reviews` : ''}`}
    >
      <Star className={cn('fill-brand-500 text-brand-500', sizes[size])} aria-hidden />
      <span className="text-sm font-bold text-ink-900">{value.toFixed(1)}</span>
      {reviews !== undefined && (
        <span className="text-xs text-ink-500">({reviews.toLocaleString()})</span>
      )}
    </span>
  )
}
