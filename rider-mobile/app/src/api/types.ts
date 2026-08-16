/* Shared API error/DTO types. ApiErrorBody mirrors the backend error envelope
 * (ErrorResponse in API-CONTRACT.yaml): { error: { code, message, requestId?, retriable?, details? } }.
 */
export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    retryAfterSeconds?: number;
    retriable?: boolean;
    details?: Record<string, unknown>;
  };
}