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
import { createDbEntitlementRepository } from './modules/entitlements/plan.repo';
import { createEntitlementService } from './modules/entitlements/entitlement.service';
import { createPlanService } from './modules/entitlements/plan.service';
import { createDbApiKeyRepository } from './modules/api-keys/api-key.repo';
import { createApiKeyService } from './modules/api-keys/api-key.service';
import { createApiKeyAuthenticator } from './modules/api-keys/api-key.authenticator';
import { createExternalProjectsService } from './modules/api-keys/external-projects.service';
import { createDbInvitationRepository } from './modules/invitations/invitation.repo';
import { createInvitationService } from './modules/invitations/invitation.service';
import { createMailpitInvitationMailer } from './modules/invitations/invitation.mailpit-mailer';
import { createDbAuditRepository } from './modules/audit/audit.repo';
import { createAuditService } from './modules/audit/audit.service';
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
  // Organization-level entitlement/quota/plan capability service. One
  // entitlement repository backs both the plan routes and project-create quota
  // enforcement (it reads plan state and counts active resources).
  const entitlementRepo = createDbEntitlementRepository(dbClient.db);
  const entitlementService = createEntitlementService({ repo: entitlementRepo });
  const planService = createPlanService({
    accessControl: organizationRepo,
    entitlements: entitlementService,
  });

  // Invitations (Sprint 9). The service is constructed BEFORE the auth service
  // so it can be wired in as the registration-with-invitation collaborator AND
  // back the invitation routes. Email is delivered over SMTP to the local
  // Mailpit container; delivery is fail-closed (a send failure aborts creation).
  const invitationService = createInvitationService({
    accessControl: organizationRepo,
    invitations: createDbInvitationRepository(dbClient.db),
    entitlements: entitlementService,
    mailer: createMailpitInvitationMailer({
      host: config.mailpit.host,
      port: config.mailpit.smtpPort,
    }),
    ttlSeconds: config.invitations.ttlSeconds,
    webBaseUrl: config.web.url,
  });

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
    // Registration-with-invitation collaborator (same instance as the routes).
    invitations: invitationService,
  });

  // The organization repository satisfies the access-control surface
  // (requireMembership/requirePermission); a dedicated project repository owns
  // tenant-scoped project persistence; the entitlement service enforces the
  // max_projects quota after the permission check.
  // One project repository backs both the internal Projects slice and the
  // external read-only Projects API (the external service reuses tenant-scoped
  // project persistence; it never calls requireMembership).
  const projectRepo = createDbProjectRepository(dbClient.db);
  const projectService = createProjectService({
    accessControl: organizationRepo,
    projects: projectRepo,
    entitlements: entitlementService,
  });

  // API keys (Sprint 8). One repository backs management AND external auth.
  const apiKeyRepo = createDbApiKeyRepository(dbClient.db);
  const apiKeyService = createApiKeyService({
    accessControl: organizationRepo,
    apiKeys: apiKeyRepo,
    entitlements: entitlementService,
  });
  // The external authenticator derives the organization from the key row, checks
  // the entitlement on every request, and applies Redis-backed per-key/per-org
  // rate limits (fail-open, so Redis never affects auth correctness).
  const apiKeyAuthenticator = createApiKeyAuthenticator({
    apiKeys: apiKeyRepo,
    organizations: organizationRepo,
    entitlements: entitlementService,
    rateLimiter: createRedisRateLimiter(redis),
    rateLimits: config.rateLimit.external,
    lastUsedThrottleSeconds: config.apiKeys.lastUsedThrottleSeconds,
  });
  const externalProjectsService = createExternalProjectsService({
    projects: projectRepo,
  });

  // Audit log read (Sprint 10). The organization repository satisfies the
  // access-control surface (requireMembership/requirePermission); a dedicated
  // audit repository owns the tenant-scoped READ over the security_events seam;
  // the entitlement service gates audit_log_access and supplies the retention
  // metadata. The audit repository writes nothing — producers (Sprints 5–9)
  // remain the only writers to that seam.
  const auditService = createAuditService({
    accessControl: organizationRepo,
    audit: createDbAuditRepository(dbClient.db),
    entitlements: entitlementService,
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
    planService,
    apiKeyService,
    invitationService,
    auditService,
    externalProjectsService,
    apiKeyAuthenticator,
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
