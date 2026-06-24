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
import { createProjectService } from '../../projects/project.service';
import { createInMemoryProjectRepository } from '../../projects/testing/in-memory-project-repo';
import { createEntitlementService } from '../entitlement.service';
import { createPlanService } from '../plan.service';
import { createInMemoryEntitlementRepository } from './in-memory-plan-repo';

/**
 * Build a fully wired app with the auth, organization, project, and plan
 * services over a SHARED in-memory store, for entitlement/plan route tests.
 *
 * The project service is included so tests can fill the project quota through
 * the real `…/projects` endpoint and observe `max_projects` enforcement, and the
 * plan service backs `…/plan`, `…/entitlements`, and `…/plan/demo`. Registering a
 * user provisions a personal workspace with default (Free) plan state; creating a
 * team org seeds an Owner membership and default plan state — exactly as the
 * database-backed wiring does.
 */
export interface EntitlementsTestContext {
  app: FastifyInstance;
  authRepo: InMemoryAuthRepository;
  orgStore: InMemoryOrgStore;
  config: Config;
}

export async function buildEntitlementsTestApp(): Promise<EntitlementsTestContext> {
  const config = testConfig();
  const orgStore = createInMemoryOrgStore();
  const authRepo = createInMemoryAuthRepository({ orgStore });
  const orgRepo = createInMemoryOrganizationRepository(orgStore);
  const projectRepo = createInMemoryProjectRepository(orgStore);
  const entitlementRepo = createInMemoryEntitlementRepository(orgStore);

  const authService = createAuthService({
    repo: authRepo,
    jwtSecret: config.auth.jwtSecret,
    accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
    sessionTtlSeconds: config.auth.sessionTtlSeconds,
    refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
  });
  const organizationService = createOrganizationService({ repo: orgRepo });
  const entitlementService = createEntitlementService({ repo: entitlementRepo });
  const planService = createPlanService({
    accessControl: orgRepo,
    entitlements: entitlementService,
  });
  const projectService = createProjectService({
    accessControl: orgRepo,
    projects: projectRepo,
    entitlements: entitlementService,
  });

  const app = buildApp({
    config,
    readinessProbes: [passingProbe('postgres'), passingProbe('redis')],
    authService,
    organizationService,
    projectService,
    planService,
    logger: false,
  });
  await app.ready();
  return { app, authRepo, orgStore, config };
}
