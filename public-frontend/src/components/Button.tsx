import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '@/utils/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'dark' | 'light'
type Size = 'sm' | 'md' | 'lg'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-brand-500 text-white shadow-lg shadow-brand-500/20 hover:brightness-105 active:scale-[0.98]',
  secondary:
    'bg-ink-900 text-white hover:bg-black active:scale-[0.98]',
  ghost:
    'bg-surface text-ink-900 ring-1 ring-line hover:ring-ink-300 active:scale-[0.98]',
  dark:
    'bg-ink-900 text-white hover:bg-brand-600 active:scale-[0.98]',
  light:
    'bg-surface text-ink-900 hover:bg-brand-50 active:scale-[0.98]',
}

const SIZES: Record<Size, string> = {
  sm: 'px-4 py-2 text-xs',
  md: 'px-6 py-3 text-sm',
  lg: 'px-8 py-3.5 text-sm',
}

type BaseProps = {
  variant?: Variant
  size?: Size
  className?: string
  children: ReactNode
}

const base = 'inline-flex items-center justify-center gap-2 rounded-full font-bold transition-all duration-200'

export function Button({
  variant = 'dark',
  size = 'md',
  className,
  children,
  ...rest
}: BaseProps & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={cn(base, VARIANTS[variant], SIZES[size], className)} {...rest}>
      {children}
    </button>
  )
}

export function ButtonLink({
  to,
  variant = 'dark',
  size = 'md',
  className,
  children,
  ...rest
}: BaseProps & { to: string } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return (
    <Link to={to} className={cn(base, VARIANTS[variant], SIZES[size], className)} {...rest}>
      {children}
    </Link>
  )
}
