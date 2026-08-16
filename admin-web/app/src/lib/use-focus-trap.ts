import { useEffect } from 'react'
import type { RefObject } from 'react'

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Minimal focus trap: keeps Tab/Shift+Tab inside `containerRef` while mounted.
 * Call in a dialog/drawer/popover that renders while open.
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const root: HTMLElement = container

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return
      const focusables = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !root.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [containerRef])
}
