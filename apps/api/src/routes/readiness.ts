import { ERROR_CODES, makeError } from '@orgistry/contracts';
import type { FastifyInstance } from 'fastify';
import { sendSuccess } from '../lib/envelope';
import { evaluateReadiness, type ReadinessProbe } from '../lib/readiness';

/**
 * Readiness endpoint.
 *
 * Reflects real dependency state (PostgreSQL and Redis — Redis is a REQUIRED
 * dependency because the production abuse controls fail closed without it,
 * see ORG-PR-009). When every probe passes it returns 200; when any fails it
 * returns 503. This is wired to live clients in `server.ts`, so it is never
 * cosmetic.
 *
 * Disclosure policy (Sprint 19, ORG-PR-052):
 *  - `detailed` (development/test): per-dependency name/ok/latency in the
 *    response — useful while operating locally.
 *  - `coarse` (production): the public body says only ready / not ready.
 *    Probe results never include connection strings, hosts, exception text,
 *    or driver details in ANY mode (probes swallow errors into a boolean),
 *    but production additionally withholds the dependency inventory. The
 *    per-dependency outcome is still logged server-side on failure, so an
 *    operator with log access keeps full visibility.
 */
export type ReadinessDisclosure = 'detailed' | 'coarse';

export interface ReadinessRouteOptions {
  disclosure: ReadinessDisclosure;
}

export function registerReadinessRoute(
  app: FastifyInstance,
  probes: ReadinessProbe[],
  options: ReadinessRouteOptions = { disclosure: 'detailed' },
): void {
  app.get('/ready', async (request, reply) => {
    const { ready, checks } = await evaluateReadiness(probes);

    if (!ready) {
      // Sanitized operator visibility: dependency names and outcomes only.
      request.log.warn(
        { checks: checks.map(({ name, ok }) => ({ name, ok })) },
        'Readiness check failed',
      );
    }

    if (options.disclosure === 'coarse') {
      if (ready) {
        return sendSuccess(reply, { status: 'ready' });
      }
      return reply.code(503).send(
        makeError({
          code: ERROR_CODES.SERVICE_UNAVAILABLE,
          message: 'The service is not ready.',
          requestId: request.id,
        }),
      );
    }

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
