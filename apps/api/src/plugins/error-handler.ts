import { ERROR_CODES, makeError } from '@orgistry/contracts';
import type { FastifyError, FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors';

/**
 * Central error handling.
 *
 * Single path for every error leaving the API:
 *  - `AppError`            -> its declared code/status/message.
 *  - Fastify validation    -> 400 VALIDATION_ERROR with field details.
 *  - anything else         -> 500 INTERNAL_ERROR, generic message, full error
 *                             logged server-side only.
 *
 * Every response is an error envelope carrying the request id. Stack traces and
 * raw error messages from unexpected errors never reach the client.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = request.id;

    if (error instanceof AppError) {
      reply
        .code(error.statusCode)
        .send(
          makeError({
            code: error.code,
            message: error.message,
            requestId,
            details: error.details,
          }),
        );
      return;
    }

    // Fastify attaches `validation` for schema failures.
    if (error.validation) {
      reply.code(400).send(
        makeError({
          code: ERROR_CODES.VALIDATION_ERROR,
          message: 'Request validation failed.',
          requestId,
          details: error.validation,
        }),
      );
      return;
    }

    // Unexpected: log the real error, return a safe generic envelope.
    request.log.error({ err: error }, 'Unhandled error');
    reply.code(500).send(
      makeError({
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'An unexpected error occurred.',
        requestId,
      }),
    );
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(
      makeError({
        code: ERROR_CODES.NOT_FOUND,
        message: `Route ${request.method} ${request.url} not found.`,
        requestId: request.id,
      }),
    );
  });
}
