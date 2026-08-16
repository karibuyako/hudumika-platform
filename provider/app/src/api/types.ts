/* Shared API error/DTO types. ApiErrorBody mirrors the backend error envelope
 * (ErrorResponse in API-CONTRACT.yaml): { error: { code, message, retriable?,
 * retryAfterSeconds?, details? } }.
 */
export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    retriable?: boolean;
    retryAfterSeconds?: number;
    requestId?: string;
    details?: Record<string, unknown>;
  };
}
