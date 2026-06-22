import { makeSuccess } from '@orgistry/contracts';
import type { FastifyReply } from 'fastify';

/**
 * Send a success envelope. Centralizing this keeps every endpoint's success
 * shape identical and prevents handlers from sending raw, unwrapped bodies.
 */
export function sendSuccess<T>(
  reply: FastifyReply,
  data: T,
  statusCode = 200,
): FastifyReply {
  return reply.code(statusCode).send(makeSuccess(data));
}
