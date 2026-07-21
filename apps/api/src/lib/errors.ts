import { ERROR_CODES, type ErrorCode } from '@orgistry/contracts';

/**
 * Application error.
 *
 * Throw this anywhere in a request lifecycle to produce a controlled error
 * envelope with a specific code, HTTP status, and safe message. Anything thrown
 * that is NOT an `AppError` is treated as unexpected and mapped to a generic
 * 500 by the central error handler (no internals leak to the client).
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static serviceUnavailable(message: string, details?: unknown): AppError {
    return new AppError(
      ERROR_CODES.SERVICE_UNAVAILABLE,
      503,
      message,
      details,
    );
  }
}

/**
 * A rate-limit bucket was exceeded (Sprint 19 shared factory). One message and
 * shape for every limiter so no bucket can leak which dimension tripped.
 */
export function rateLimitedError(): AppError {
  return new AppError(
    ERROR_CODES.RATE_LIMITED,
    429,
    'Too many requests. Please slow down and try again later.',
  );
}

/**
 * A SENSITIVE limiter could not reach its store and the configured failure
 * mode is `closed` (Sprint 19, ORG-PR-009). Deliberately generic: no store
 * name, host, command, or exception detail reaches the client.
 */
export function rateLimitStoreUnavailableError(): AppError {
  return AppError.serviceUnavailable(
    'The service is temporarily unavailable. Please try again shortly.',
  );
}
