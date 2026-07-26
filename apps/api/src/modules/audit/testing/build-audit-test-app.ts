import type { Config } from '@orgistry/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../app';
import { passingProbe, testConfig } from '../../../testing/build-test-app';
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
import { createPlanService } from '../../entitlements/plan.service';
import { createProjectService } from '../../projects/project.service';
import { createInMemoryProjectRepository } from '../../projects/testing/in-memory-project-repo';
import {
  createAuditService,
  type AuditReadRateLimits,
} from '../audit.service';
import type { RateLimiter } from '../../../lib/rate-limit';
import { createInMemoryAuditRepository } from './in-memory-audit-repo';
import {
  createInMemoryAccountMailer,
  type InMemoryAccountMailer,
} from '../../mail/testing/in-memory-account-mailer';
import { createRegistrationTestKit } from '../../auth/testing/registration-test-kit';

/**
 * Build a fully wired app with the auth, organization, plan, project, AND audit
 * services over a SHARED in-memory store, for audit route-level tests.
 *
 * The shared store is the whole point: registering a user provisions a personal
 * workspace + Free plan; creating a team org seeds an Owner membership; changing
 * the demo plan flips `audit_log_access`; project/plan actions write events to
 * the same `securityEvents` array the audit endpoint reads — exactly as the
 * database-backed wiring does. Tests obtain real access tokens via the auth
 * endpoints, change plans to enable audit access, and read `…/audit-events`.
 *
 * The plan service is wired so a test can enable `audit_log_access` through the
 * real `…/plan/demo` endpoint; the project service is wired so a test can
 * generate real action events end-to-end.
 */
export interface AuditTestContext {
  app: FastifyInstance;
  authRepo: InMemoryAuthRepository;
  orgStore: InMemoryOrgStore;
  mailer: InMemoryAccountMailer;
  config: Config;
}

/**
 * Optional overrides. Audit-read throttling is OFF unless a test wires both a
 * limiter and explicit ceilings, so existing route tests keep their behavior.
 */
export interface BuildAuditTestAppOptions {
  rateLimiter?: RateLimiter;
  auditReadRateLimits?: AuditReadRateLimits;
}

export async function buildAuditTestApp(
  options: BuildAuditTestAppOptions = {},
): Promise<AuditTestContext> {
  const config = testConfig();
  const orgStore = createInMemoryOrgStore();
  const authRepo = createInMemoryAuthRepository({ orgStore });
  const orgRepo = createInMemoryOrganizationRepository(orgStore);
  const projectRepo = createInMemoryProjectRepository(orgStore);

  const authService = createAuthService({
    repo: authRepo,
    jwtSecret: config.auth.jwtSecret,
    accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
    sessionTtlSeconds: config.auth.sessionTtlSeconds,
    refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
  });
  const mailer = createInMemoryAccountMailer();
  const { registrationService } = createRegistrationTestKit({
    config,
    authRepo,
    mailer,
  });
  const organizationService = createOrganizationService({ repo: orgRepo });
  const entitlementService = createEntitlementService({
    repo: createInMemoryEntitlementRepository(orgStore),
  });
  const planService = createPlanService({
    accessControl: orgRepo,
    entitlements: entitlementService,
  });
  const projectService = createProjectService({
    accessControl: orgRepo,
    projects: projectRepo,
  });
  const auditService = createAuditService({
    accessControl: orgRepo,
    audit: createInMemoryAuditRepository(orgStore),
    entitlements: entitlementService,
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options.auditReadRateLimits
      ? { rateLimits: options.auditReadRateLimits }
      : {}),
  });

  const app = buildApp({
    config,
    readinessProbes: [passingProbe('postgres'), passingProbe('redis')],
    authService,
    registrationService,
    organizationService,
    planService,
    projectService,
    auditService,
    logger: false,
  });
  await app.ready();
  return { app, authRepo, orgStore, mailer, config };
}
