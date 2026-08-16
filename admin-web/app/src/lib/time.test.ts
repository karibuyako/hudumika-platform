import { describe, expect, it } from 'vitest'
import { snapshotLabel, toLocal } from './time'

describe('toLocal', () => {
  it('renders a UTC ISO timestamp in local time', () => {
    const local = toLocal('2026-08-13T10:00:00.000Z')
    expect(local).not.toBe('2026-08-13T10:00:00.000Z')
    expect(local).toMatch(/\d{4}/)
  })

  it('returns — for null/undefined/empty', () => {
    expect(toLocal(null)).toBe('—')
    expect(toLocal(undefined)).toBe('—')
    expect(toLocal('')).toBe('—')
  })

  it('returns — for invalid input', () => {
    expect(toLocal('not-a-date')).toBe('—')
  })
})

describe('snapshotLabel', () => {
  it('labels snapshot timestamps', () => {
    expect(snapshotLabel('2026-08-13T10:00:00.000Z')).toMatch(/^Snapshot /)
    expect(snapshotLabel(null)).toBe('Snapshot —')
  })
})
