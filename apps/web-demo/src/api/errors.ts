import type { ErrorCode } from '@orgistry/contracts';

/**
 * A backend error envelope, surfaced as a typed exception.
 *
 * Every failed API call rejects with an `ApiError`. It carries the stable
 * machine-readable `code` (which the UI branches on), the safe human `message`
 * the backend produced, the `requestId` for support/log correlation, the HTTP
 * `status`, and any structured `details` (e.g. quota or entitlement specifics).
 *
 * The backend is the single source of truth for error semantics — the client
 * never invents an error code. `ApiError.unexpected` is the one exception: a
 * safe fallback for transport/parse failures that never reached a real envelope.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'UNEXPECTED_ERROR',
    message: string,
    readonly status: number,
    readonly requestId: string | null,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * Build the safe fallback for failures that never produced a real envelope.
   * `requestId` is optional: it is supplied when the response carried an
   * `x-request-id` header even though its body was not a usable envelope.
   */
  static unexpected(
    message: string,
    status = 0,
    requestId: string | null = null,
  ): ApiError {
    return new ApiError('UNEXPECTED_ERROR', message, status, requestId);
  }

  /** True when the failure is the named backend error code. */
  is(code: ErrorCode): boolean {
    return this.code === code;
  }
}

/** Narrow an unknown thrown value to an `ApiError`. */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * Coerce any thrown value into an `ApiError` for uniform rendering. A real
 * `ApiError` passes through; anything else becomes a safe unexpected error so a
 * page never has to special-case non-envelope failures.
 */
export function toApiError(value: unknown): ApiError {
  if (isApiError(value)) {
    return value;
  }
  const message =
    value instanceof Error ? value.message : 'An unexpected error occurred.';
  return ApiError.unexpected(message);
}
