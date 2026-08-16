import { describe, expect, it } from 'vitest'
import { toCsv } from './csv'

describe('toCsv', () => {
  it('joins rows with CRLF line endings', () => {
    expect(toCsv(['a', 'b'], [['1', '2'], ['3', '4']])).toBe('a,b\r\n1,2\r\n3,4\r\n')
  })

  it('quotes fields containing commas', () => {
    expect(toCsv(['name'], [['Doe, Jane']])).toBe('name\r\n"Doe, Jane"\r\n')
  })

  it('escapes quotes by doubling them', () => {
    expect(toCsv(['note'], [['say "hi"']])).toBe('note\r\n"say ""hi"""\r\n')
  })

  it('quotes fields containing newlines', () => {
    expect(toCsv(['note'], [['line1\nline2']])).toBe('note\r\n"line1\nline2"\r\n')
  })

  it('writes null and number cells as plain values', () => {
    expect(toCsv(['id', 'total'], [[1, null], [2, 500]])).toBe('id,total\r\n1,\r\n2,500\r\n')
  })

  it('handles empty rows and empty rows list', () => {
    expect(toCsv(['h'], [])).toBe('h\r\n')
    expect(toCsv(['h'], [[]])).toBe('h\r\n\r\n')
  })
})
