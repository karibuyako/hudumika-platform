import { describe, expect, it } from 'vitest'
import { parseApiError } from './api-error'

describe('parseApiError', () => {
  it('parses the contract envelope', () => {
    const info = parseApiError({
      status: 403,
      data: { code: 'FORBIDDEN', message: 'No permission', requestId: 'req_1' },
    })
    expect(info).toEqual({
      code: 'FORBIDDEN',
      message: 'No permission',
      requestId: 'req_1',
      retriable: false,
      status: 403,
    })
  })

  it('falls back when no envelope present', () => {
    const info = parseApiError({ status: 500 }, 'Tower unavailable')
    expect(info).toMatchObject({ code: 'HTTP_500', message: 'Tower unavailable', retriable: true })
  })

  it('marks 5xx as retriable', () => {
    expect(parseApiError({ status: 503, data: { code: 'X', message: 'm' } }).retriable).toBe(true)
    expect(parseApiError({ status: 404, data: { code: 'HUB_NOT_FOUND', message: 'm' } }).retriable).toBe(false)
  })

  it('marks responses with retryAfterSeconds as retriable', () => {
    const info = parseApiError({
      status: 403,
      data: { code: 'RATE_LIMITED', message: 'slow down', requestId: 'req_2', retryAfterSeconds: 30 },
    })
    expect(info.retriable).toBe(true)
    expect(info.retryAfterSeconds).toBe(30)
  })
})
