import type { Config } from '@orgistry/config';
import type { FastifyInstance } from 'fastify';
import type { Clock } from '@orgistry/shared';
import { buildApp } from '../../../app';
import { passingProbe, testConfig } from '../../../testing/build-test-app';
import type { RateLimiter } from '../../../lib/rate-limit';
import { createAuthService } from '../../auth/auth.service';
import {
  createInMemoryAuthRepository,
  type InMemoryAuthRepository,
} from '../../auth/testing/in-memory-auth-repo';
import { createOrganizationService } from '../../organization/organization.service';
import { createInMemoryOrganizationRepository } from '../../organization/testing/in-memory-organization-repo';
import {
  createInMemoryOrgStore,
  type InMemoryOrgStore,
} from '../../organization/testing/in-memory-org-store';
import { createEntitlementService } from '../../entitlements/entitlement.service';
import { createInMemoryEntitlementRepository } from '../../entitlements/testing/in-memory-plan-repo';
import { createProjectService } from '../../projects/project.service';
import { createInMemoryProjectRepository } from '../../projects/testing/in-memory-project-repo';
import { createApiKeyService } from '../api-key.service';
import {
  createApiKeyAuthenticator,
  type ExternalRateLimits,
} from '../api-key.authenticator';
import { createExternalProjectsService } from '../external-projects.service';
import { createInMemoryApiKeyRepository } from './in-memory-api-key-repo';

/**
 * Build a fully wired app with the auth, organization, project, AND API key
 * services over a SHARED in-memory store, for API key + external-API route tests.
 *
 * The shared store is the whole point: registering a user provisions a personal
 * workspace and plan state; creating a team org seeds an Owner membership and
 * Free plan; the API key endpoints' access-control + entitlement checks read the
 * same tables — exactly as the database-backed wiring does. Tests obtain real
 * user access tokens via the auth endpoints (to manage keys) and real raw API
 * keys via the create endpoint (to call the external API).
 *
 * Options let a test inject a small rate limiter or a controllable clock to
 * exercise external rate limiting and last-used throttling deterministically.
 */
export interface BuildApiKeysAppOptions {
  /** External rate limits. Defaults to effectively unlimited. */
  externalRateLimits?: ExternalRateLimits;
  /** Rate limiter for the external authenticator. Defaults to a no-op limiter. */
  rateLimiter?: RateLimiter;
  /** Last-used write throttle window. Defaults to 60s. */
  lastUsedThrottleSeconds?: number;
  /** Clock shared by the API key service + authenticator. Defaults to systemClock. */
  clock?: Clock;
}

export interface ApiKeysTestContext {
  app: FastifyInstance;
  authRepo: InMemoryAuthRepository;
  orgStore: InMemoryOrgStore;
  config: Config;
}

export async function buildApiKeysTestApp(
  options: BuildApiKeysAppOptions = {},
): Promise<ApiKeysTestContext> {
  const config = testConfig();
  const orgStore = createInMemoryOrgStore();
  const authRepo = createInMemoryAuthRepository({ orgStore });
  const orgRepo = createInMemoryOrganizationRepository(orgStore);
  const projectRepo = createInMemoryProjectRepository(orgStore);
  const apiKeyRepo = createInMemoryApiKeyRepository(orgStore);

  const authService = createAuthService({
    repo: authRepo,
    jwtSecret: config.auth.jwtSecret,
    accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
    sessionTtlSeconds: config.auth.sessionTtlSeconds,
    refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
  });
  const organizationService = createOrganizationService({ repo: orgRepo });
  const entitlementService = createEntitlementService({
    repo: createInMemoryEntitlementRepository(orgStore),
  });
  const projectService = createProjectService({
    accessControl: orgRepo,
    projects: projectRepo,
    entitlements: entitlementService,
  });

  const apiKeyService = createApiKeyService({
    accessControl: orgRepo,
    apiKeys: apiKeyRepo,
    entitlements: entitlementService,
    clock: options.clock,
  });
  const apiKeyAuthenticator = createApiKeyAuthenticator({
    apiKeys: apiKeyRepo,
    organizations: orgRepo,
    entitlements: entitlementService,
    rateLimiter: options.rateLimiter,
    rateLimits: options.externalRateLimits,
    lastUsedThrottleSeconds: options.lastUsedThrottleSeconds ?? 60,
    clock: options.clock,
  });
  const externalProjectsService = createExternalProjectsService({
    projects: projectRepo,
  });

  const app = buildApp({
    config,
    readinessProbes: [passingProbe('postgres'), passingProbe('redis')],
    authService,
    organizationService,
    projectService,
    apiKeyService,
    externalProjectsService,
    apiKeyAuthenticator,
    logger: false,
  });
  await app.ready();
  return { app, authRepo, orgStore, config };
}
