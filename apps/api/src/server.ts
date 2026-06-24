import { getConfig } from '@orgistry/config';
import { createDbClient, pingDatabase } from '@orgistry/db';
import { loadWorkspaceEnv } from '@orgistry/shared/node';
import Redis from 'ioredis';
import { buildApp } from './app';
import { createDbAuthRepository } from './modules/auth/auth.repo';
import { createAuthService } from './modules/auth/auth.service';
import { createDbOrganizationRepository } from './modules/organization/organization.repo';
import { createOrganizationService } from './modules/organization/organization.service';
import { createMemberService } from './modules/organization/member.service';
import { createOrganizationRbacService } from './modules/organization/org-rbac.service';
import { createDbRbacRepository } from './modules/rbac/rbac.repo';
import { createRbacService } from './modules/rbac/rbac.service';
import { createDbProjectRepository } from './modules/projects/project.repo';
import { createProjectService } from './modules/projects/project.service';
import { createRedisRateLimiter } from './lib/rate-limit';
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
    refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
    // Redis is the official v1 rate-limit store. It fails open, so a Redis
    // outage disables rate limiting but never affects auth correctness.
    rateLimiter: createRedisRateLimiter(redis),
    rateLimits: config.rateLimit.auth,
  });

  // One organization repository backs both the organization workflows and the
  // member-management/access-control workflows (they share the same persistence).
  const organizationRepo = createDbOrganizationRepository(dbClient.db);
  const organizationService = createOrganizationService({ repo: organizationRepo });
  const memberService = createMemberService({ repo: organizationRepo });
  const rbacService = createRbacService({
    repo: createDbRbacRepository(dbClient.db),
  });
  const organizationRbacService = createOrganizationRbacService({
    repo: organizationRepo,
    rbacService,
  });
  // The organization repository satisfies the access-control surface
  // (requireMembership/requirePermission); a dedicated project repository owns
  // tenant-scoped project persistence.
  const projectService = createProjectService({
    accessControl: organizationRepo,
    projects: createDbProjectRepository(dbClient.db),
  });

  const app = buildApp({
    config,
    readinessProbes,
    authService,
    organizationService,
    memberService,
    organizationRbacService,
    rbacService,
    projectService,
  });

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
