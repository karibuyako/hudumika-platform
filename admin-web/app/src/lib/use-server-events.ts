import { useCallback, useEffect, useRef, useState } from 'react'
import { getServerEvents, type GetServerEvents200EventsItem } from '@hudumika/contract'

const EMPTY_POLL_PAUSE_MS = 3000

/**
 * Delay before the next poll given consecutive failures. 0 means no delay
 * (the previous poll succeeded); otherwise exponential backoff
 * 5000 * 2^(n-1) ms capped at 60s, where n is the failure count.
 */
export function nextPollDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0
  return Math.min(5000 * 2 ** (consecutiveFailures - 1), 60000)
}

/** Highest event id in the batch; 0 when there are no events. */
export function latestEventId(events: GetServerEvents200EventsItem[]): number {
  return events.reduce((max, e) => (e.id > max ? e.id : max), 0)
}

export interface UseServerEventsOptions {
  enabled: boolean
  onEvent: (events: GetServerEvents200EventsItem[]) => void
}

/**
 * Long-poll the /events stream: poll immediately after a non-empty 200,
 * pause 3s after an empty 200, and back off exponentially on errors.
 * Stops polling when disabled or unmounted.
 */
export function useServerEvents({
  enabled,
  onEvent,
}: UseServerEventsOptions): {
  latestSeq: number | null
  error: string | null
  reconnect: () => void
} {
  const [latestSeq, setLatestSeq] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [startKey, setStartKey] = useState(0)

  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  const reconnect = useCallback(() => {
    setLatestSeq(null)
    setError(null)
    setStartKey((k) => k + 1)
  }, [])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let consecutiveFailures = 0
    let seq = 0

    const scheduleNext = (delayMs: number) => {
      if (cancelled) return
      timer = setTimeout(poll, delayMs)
    }

    const poll = async () => {
      if (cancelled) return
      try {
        const res = await getServerEvents({ after: seq })
        if (cancelled) return
        if (res.status === 200) {
          consecutiveFailures = 0
          setError(null)
          const events = res.data.events ?? []
          seq = latestEventId(events)
          setLatestSeq(seq)
          onEventRef.current(events)
          scheduleNext(events.length === 0 ? EMPTY_POLL_PAUSE_MS : 0)
        } else {
          throw new Error(`Events stream unavailable (HTTP ${res.status})`)
        }
      } catch (err) {
        if (cancelled) return
        consecutiveFailures += 1
        setError(err instanceof Error ? err.message : 'Events stream unavailable')
        scheduleNext(nextPollDelayMs(consecutiveFailures))
      }
    }

    void poll()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [enabled, startKey])

  return { latestSeq, error, reconnect }
}
