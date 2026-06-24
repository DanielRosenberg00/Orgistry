import type { Config } from '@orgistry/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../app';
import { passingProbe, testConfig } from '../../../testing/build-test-app';
import { createAuthService } from '../../auth/auth.service';
import {
  createInMemoryAuthRepository,
  type InMemoryAuthRepository,
} from '../../auth/testing/in-memory-auth-repo';
import { createMemberService } from '../member.service';
import { createOrganizationRbacService } from '../org-rbac.service';
import { createOrganizationService } from '../organization.service';
import { createRbacService } from '../../rbac/rbac.service';
import { createInMemoryRbacRepository } from '../../rbac/testing/in-memory-rbac-repo';
import { createInMemoryOrganizationRepository } from './in-memory-organization-repo';
import {
  createInMemoryOrgStore,
  type InMemoryOrgStore,
} from './in-memory-org-store';

/**
 * Build a fully wired app with BOTH the auth and organization services over a
 * SHARED in-memory organization store, for organization route-level tests.
 *
 * The shared store is the whole point: registering a user through the auth flow
 * provisions a personal workspace into the same tables the organization
 * endpoints read, exactly as the database-backed wiring does. Tests use the auth
 * endpoints to obtain real access tokens and then exercise `/v1/organizations`.
 */
export interface OrganizationTestContext {
  app: FastifyInstance;
  authRepo: InMemoryAuthRepository;
  orgStore: InMemoryOrgStore;
  config: Config;
}

export async function buildOrganizationTestApp(): Promise<OrganizationTestContext> {
  const config = testConfig();
  const orgStore = createInMemoryOrgStore();
  const authRepo = createInMemoryAuthRepository({ orgStore });
  const orgRepo = createInMemoryOrganizationRepository(orgStore);

  const authService = createAuthService({
    repo: authRepo,
    jwtSecret: config.auth.jwtSecret,
    accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
    sessionTtlSeconds: config.auth.sessionTtlSeconds,
    refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
  });
  const organizationService = createOrganizationService({ repo: orgRepo });
  const memberService = createMemberService({ repo: orgRepo });
  const rbacService = createRbacService({
    repo: createInMemoryRbacRepository(orgStore),
  });
  const organizationRbacService = createOrganizationRbacService({
    repo: orgRepo,
    rbacService,
  });

  const app = buildApp({
    config,
    readinessProbes: [passingProbe('postgres'), passingProbe('redis')],
    authService,
    organizationService,
    memberService,
    organizationRbacService,
    rbacService,
    logger: false,
  });
  await app.ready();
  return { app, authRepo, orgStore, config };
}
