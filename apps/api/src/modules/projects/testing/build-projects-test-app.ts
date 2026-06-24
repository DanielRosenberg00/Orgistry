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
import { createProjectService } from '../project.service';
import { createInMemoryProjectRepository } from './in-memory-project-repo';

/**
 * Build a fully wired app with the auth, organization, and project services over
 * a SHARED in-memory store, for project route-level tests.
 *
 * The shared store is the whole point: registering a user through the auth flow
 * provisions a personal workspace, and creating a team org seeds an Owner
 * membership, into the same tables the project endpoints' access-control checks
 * read — exactly as the database-backed wiring does. Tests obtain real access
 * tokens via the auth endpoints and then exercise `…/projects`.
 *
 * The organization repository satisfies the access-control surface
 * (requireMembership/requirePermission); a dedicated in-memory project
 * repository owns tenant-scoped project persistence — the same dependency split
 * as production.
 */
export interface ProjectsTestContext {
  app: FastifyInstance;
  authRepo: InMemoryAuthRepository;
  orgStore: InMemoryOrgStore;
  config: Config;
}

export async function buildProjectsTestApp(): Promise<ProjectsTestContext> {
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
  const organizationService = createOrganizationService({ repo: orgRepo });
  const projectService = createProjectService({
    accessControl: orgRepo,
    projects: projectRepo,
  });

  const app = buildApp({
    config,
    readinessProbes: [passingProbe('postgres'), passingProbe('redis')],
    authService,
    organizationService,
    projectService,
    logger: false,
  });
  await app.ready();
  return { app, authRepo, orgStore, config };
}
