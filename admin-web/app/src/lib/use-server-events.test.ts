import { describe, expect, it } from 'vitest'
import { latestEventId, nextPollDelayMs } from './use-server-events'
import type { GetServerEvents200EventsItem } from '@hudumika/contract'

const event = (over: Partial<GetServerEvents200EventsItem> = {}): GetServerEvents200EventsItem => ({
  id: 1,
  type: 'order.updated',
  at: '2026-08-15T10:00:00.000Z',
  ...over,
})

describe('nextPollDelayMs', () => {
  it('returns 0 on success (no failures)', () => {
    expect(nextPollDelayMs(0)).toBe(0)
  })

  it('backs off 5s on the first failure', () => {
    expect(nextPollDelayMs(1)).toBe(5000)
  })

  it('doubles to 10s on the second failure', () => {
    expect(nextPollDelayMs(2)).toBe(10000)
  })

  it('keeps doubling on further failures', () => {
    expect(nextPollDelayMs(3)).toBe(20000)
    expect(nextPollDelayMs(4)).toBe(40000)
  })

  it('caps the backoff at 60s', () => {
    expect(nextPollDelayMs(5)).toBe(60000)
    expect(nextPollDelayMs(10)).toBe(60000)
  })

  it('treats negative counts as success', () => {
    expect(nextPollDelayMs(-1)).toBe(0)
  })
})

describe('latestEventId', () => {
  it('returns 0 for an empty batch', () => {
    expect(latestEventId([])).toBe(0)
  })

  it('returns the max event id', () => {
    expect(latestEventId([event({ id: 3 }), event({ id: 9 }), event({ id: 5 })])).toBe(9)
  })

  it('returns the single id for a one-event batch', () => {
    expect(latestEventId([event({ id: 7 })])).toBe(7)
  })
})
