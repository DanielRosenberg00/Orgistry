import type { Config } from '@orgistry/config';
import { generateRequestId } from '@orgistry/shared';
import cors from '@fastify/cors';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { registerErrorHandler } from './plugins/error-handler';
import { registerHealthRoute } from './routes/health';
import { registerReadinessRoute } from './routes/readiness';
import type { ReadinessProbe } from './lib/readiness';

export interface BuildAppOptions {
  config: Config;
  /** Dependency probes backing the readiness endpoint (e.g. PostgreSQL, Redis). */
  readinessProbes: ReadinessProbe[];
  /** Logger override. Defaults to a JSON logger at the configured level. */
  logger?: FastifyServerOptions['logger'];
}

/**
 * Construct a fully wired Fastify instance WITHOUT starting it.
 *
 * Keeping construction separate from `listen` (see `server.ts`) lets tests
 * exercise the app via `app.inject(...)` with no open ports or real network,
 * and lets startup own process concerns (signals, real clients, shutdown).
 *
 * Request-id handling: Fastify reuses an inbound `x-request-id` header when
 * present and otherwise generates one. The id is echoed on every response and
 * included in error envelopes and log lines (`reqId`).
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config, readinessProbes } = options;

  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    genReqId: () => generateRequestId(),
  });

  // Echo the resolved request id on every response for client-side correlation.
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.register(cors, {
    origin: config.cors.origins.length > 0 ? [...config.cors.origins] : false,
    credentials: true,
  });

  registerErrorHandler(app);
  registerHealthRoute(app);
  registerReadinessRoute(app, readinessProbes);

  return app;
}
