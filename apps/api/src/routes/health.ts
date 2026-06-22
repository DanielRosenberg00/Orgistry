import type { FastifyInstance } from 'fastify';
import { sendSuccess } from '../lib/envelope';

/**
 * Liveness endpoint.
 *
 * Answers only "is this process up and serving?". It must NOT touch PostgreSQL,
 * Redis, or any other dependency — orchestrators use liveness to decide whether
 * to restart the process, and a dependency blip should not trigger restarts.
 */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/health', async (_request, reply) => {
    return sendSuccess(reply, { status: 'ok' });
  });
}
