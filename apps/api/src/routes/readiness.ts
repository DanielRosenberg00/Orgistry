import { ERROR_CODES, makeError } from '@orgistry/contracts';
import type { FastifyInstance } from 'fastify';
import { sendSuccess } from '../lib/envelope';
import { evaluateReadiness, type ReadinessProbe } from '../lib/readiness';

/**
 * Readiness endpoint.
 *
 * Reflects real dependency state (PostgreSQL and Redis in Sprint 1). When every
 * probe passes it returns 200 with per-dependency status; when any fails it
 * returns 503 with a standard error envelope whose details list which checks
 * failed. This is wired to live clients in `server.ts`, so it is never
 * cosmetic.
 */
export function registerReadinessRoute(
  app: FastifyInstance,
  probes: ReadinessProbe[],
): void {
  app.get('/ready', async (request, reply) => {
    const { ready, checks } = await evaluateReadiness(probes);

    if (ready) {
      return sendSuccess(reply, { status: 'ready', checks });
    }

    return reply.code(503).send(
      makeError({
        code: ERROR_CODES.SERVICE_UNAVAILABLE,
        message: 'One or more dependencies are unavailable.',
        requestId: request.id,
        details: { checks },
      }),
    );
  });
}
