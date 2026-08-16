import { useId, cloneElement, isValidElement, type ReactElement, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/utils/cn'

type ChildEl = ReactElement<
  | (InputHTMLAttributes<HTMLElement> & { id?: string })
  | (SelectHTMLAttributes<HTMLElement> & { id?: string })
  | (TextareaHTMLAttributes<HTMLElement> & { id?: string })
>

export function Field({
  label,
  error,
  hint,
  children,
  className,
}: {
  label: string
  error?: string
  hint?: string
  children: ChildEl
  className?: string
}) {
  const autoId = useId()
  const id = (children.props.id as string | undefined) ?? autoId
  const describedBy =
    [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined

  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-xs font-bold text-ink-900">
        {label}
      </label>
      {isValidElement(children) &&
        cloneElement(children, {
          id,
          'aria-invalid': error ? true : undefined,
          'aria-describedby': describedBy,
        })}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-ink-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs font-medium text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export const inputCls = (error?: string) =>
  cn(
    'w-full rounded-[14px] bg-paper px-4 py-3 text-sm text-ink-900 outline-none ring-1 transition focus:ring-2',
    error ? 'ring-danger/50 focus:ring-danger' : 'ring-line focus:ring-brand-400',
  )
