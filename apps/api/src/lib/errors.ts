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
