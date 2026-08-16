import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { useFocusTrap } from '../lib/use-focus-trap'

interface DetailDrawerProps {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  wide?: boolean
}

/** Drawer shell — traps focus, closes on Escape and backdrop click. */
export function DetailDrawer({ title, onClose, children, wide }: DetailDrawerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const node = ref.current
    node?.querySelector<HTMLElement>('button, a, input, select, textarea, [tabindex]')?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      prev?.focus()
    }
  }, [onClose])

  useFocusTrap(ref)

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div
        ref={ref}
        className={`drawer${wide ? ' drawer-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <h2 id={titleId}>{title}</h2>
          <button className="btn" onClick={onClose} type="button">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
