import { z } from 'zod';
import { ERROR_CODES, type ErrorCode } from './error-codes';

/**
 * Response envelopes.
 *
 * Every API response is wrapped in a discriminated envelope keyed on `ok`.
 * Clients branch on `ok` to narrow to data or error. This shape is a frozen
 * contract: fields may be added but existing fields must not change meaning
 * without a deliberate review.
 */

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    /** Stable, machine-readable code from the catalog. */
    code: ErrorCode;
    /** Human-readable, safe-to-display message. Never contains secrets. */
    message: string;
    /** Correlates the response with server logs. Always present. */
    requestId: string;
    /** Optional structured detail (e.g. field validation issues). */
    details?: unknown;
  };
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

/** Construct a success envelope. */
export function makeSuccess<T>(data: T): SuccessEnvelope<T> {
  return { ok: true, data };
}

/** Construct an error envelope. */
export function makeError(args: {
  code: ErrorCode;
  message: string;
  requestId: string;
  details?: unknown;
}): ErrorEnvelope {
  const error: ErrorEnvelope['error'] = {
    code: args.code,
    message: args.message,
    requestId: args.requestId,
  };
  if (args.details !== undefined) {
    error.details = args.details;
  }
  return { ok: false, error };
}

/** Zod schema for the error envelope (useful for client-side validation/tests). */
export const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.enum(
      Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]],
    ),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});

/** Build a Zod schema for a success envelope wrapping a given data schema. */
export function successEnvelopeSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({ ok: z.literal(true), data });
}
