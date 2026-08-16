import { useEffect, useRef } from 'react'

const FOCUS_THROTTLE_MS = 5000

let lastFocusRefetchAt = 0

/**
 * Refetch when the window regains focus, throttled to once per 5s
 * (module-level so throttling is shared across pages).
 */
export function useRefetchOnFocus(refetch: () => void, opts?: { enabled?: boolean }): void {
  const refetchRef = useRef(refetch)
  refetchRef.current = refetch
  const enabled = opts?.enabled ?? true

  useEffect(() => {
    if (!enabled) return
    const onFocus = () => {
      const now = Date.now()
      if (now - lastFocusRefetchAt < FOCUS_THROTTLE_MS) return
      lastFocusRefetchAt = now
      refetchRef.current()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [enabled])
}
