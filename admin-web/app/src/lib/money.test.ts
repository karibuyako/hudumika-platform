import { describe, expect, it } from 'vitest'
import { formatTZS } from './money'

describe('formatTZS', () => {
  it('formats zero', () => {
    expect(formatTZS(0)).toBe('TZS 0')
  })

  it('formats thousands with separators', () => {
    expect(formatTZS(15000)).toBe('TZS 15,000')
    expect(formatTZS(1_000_000)).toBe('TZS 1,000,000')
  })

  it('formats small amounts without separators', () => {
    expect(formatTZS(150)).toBe('TZS 150')
  })

  it('renders negative (signed) values explicitly', () => {
    expect(formatTZS(-12000)).toBe('-TZS 12,000')
  })

  it('handles null and undefined', () => {
    expect(formatTZS(null)).toBe('TZS —')
    expect(formatTZS(undefined)).toBe('TZS —')
  })

  it('rejects floats', () => {
    expect(() => formatTZS(15000.5)).toThrow('integer')
  })
})
