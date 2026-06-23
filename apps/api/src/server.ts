import { getConfig } from '@orgistry/config';
import { createDbClient, pingDatabase } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import Redis from 'ioredis';
import { buildApp } from './app';
import { createDbAuthRepository } from './modules/auth/auth.repo';
import { createAuthService } from './modules/auth/auth.service';
import type { ReadinessProbe } from './lib/readiness';

/**
 * Process entry point.
 *
 * Owns everything `buildApp` deliberately does not: loading config, creating
 * real PostgreSQL/Redis clients, wiring them into readiness probes, binding the
 * port, and shutting everything down cleanly on SIGINT/SIGTERM.
 */
async function main(): Promise<void> {
  // Load the workspace-root `.env` before reading config, so a clean clone runs
  // with only `cp .env.example .env` — no manual exports required.
  loadWorkspaceEnv();
  const config = getConfig();

  const dbClient = createDbClient(config.database.url);

  // `lazyConnect` keeps boot resilient: the API starts even if Redis is down,
  // and readiness reports the outage instead of crash-looping.
  const redis = new Redis(config.redis.url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  const readinessProbes: ReadinessProbe[] = [
    { name: 'postgres', check: () => pingDatabase(dbClient.sql) },
    {
      name: 'redis',
      check: async () => {
        await redis.ping();
      },
    },
  ];

  const authService = createAuthService({
    repo: createDbAuthRepository(dbClient.db),
    jwtSecret: config.auth.jwtSecret,
    accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
    sessionTtlSeconds: config.auth.sessionTtlSeconds,
  });

  const app = buildApp({ config, readinessProbes, authService });

  // Prevent unhandled 'error' events when Redis is unreachable; readiness is
  // the source of truth for connectivity, so log at debug and move on.
  redis.on('error', (error) => {
    app.log.debug({ err: error }, 'Redis connection error');
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    await dbClient.close();
    redis.disconnect();
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal).finally(() => process.exit(0));
    });
  }

  await app.listen({ host: config.api.host, port: config.api.port });
}

main().catch((error) => {
  console.error('Failed to start API:', error);
  process.exit(1);
});
