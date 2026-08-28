import type { ErrorResponse } from '@hudumika/contract'

export interface ApiErrorInfo {
  code: string
  message: string
  requestId?: string
  retriable: boolean
  retryAfterSeconds?: number
  status?: number
}

export function parseApiError(
  res: { status: number; data?: unknown },
  fallbackMessage = 'Request failed',
): ApiErrorInfo {
  const data = res.data as Partial<ErrorResponse> | null | undefined
  return {
    code: data?.code ?? `HTTP_${res.status}`,
    message: data?.message ?? fallbackMessage,
    requestId: data?.requestId,
    retriable: res.status >= 500 || Boolean(data?.retryAfterSeconds),
    retryAfterSeconds: data?.retryAfterSeconds,
    status: res.status,
  }
}
