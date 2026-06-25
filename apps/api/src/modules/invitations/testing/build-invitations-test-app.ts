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
import { createMemberService } from '../../organization/member.service';
import { createEntitlementService } from '../../entitlements/entitlement.service';
import { createInMemoryEntitlementRepository } from '../../entitlements/testing/in-memory-plan-repo';
import { createInvitationService } from '../invitation.service';
import { createInMemoryInvitationRepository } from './in-memory-invitation-repo';
import {
  createCapturingInvitationMailer,
  type CapturingInvitationMailer,
} from './in-memory-invitation-mailer';

/**
 * Build a fully wired app with the auth, organization, member, entitlement, AND
 * invitation services over a SHARED in-memory store, for invitation route tests.
 *
 * The shared store is the point: registering a user provisions a personal
 * workspace + plan state; creating a team org seeds an Owner membership + Free
 * plan; the invitation endpoints' access-control + quota checks read the same
 * tables — exactly as the database-backed wiring does. The SAME invitation
 * service instance backs the invitation routes AND is wired into the auth
 * service as the registration-with-invitation collaborator, mirroring server.ts.
 *
 * The capturing mailer is exposed so tests can assert the send path and recover
 * the raw token (the API never returns it).
 */
export interface InvitationsTestContext {
  app: FastifyInstance;
  authRepo: InMemoryAuthRepository;
  orgStore: InMemoryOrgStore;
  mailer: CapturingInvitationMailer;
  config: Config;
}

export interface BuildInvitationsAppOptions {
  /** Token TTL in seconds. Defaults to the config default (7 days). */
  ttlSeconds?: number;
}

export async function buildInvitationsTestApp(
  options: BuildInvitationsAppOptions = {},
): Promise<InvitationsTestContext> {
  const config = testConfig();
  const orgStore = createInMemoryOrgStore();
  const authRepo = createInMemoryAuthRepository({ orgStore });
  const orgRepo = createInMemoryOrganizationRepository(orgStore);
  const entitlementService = createEntitlementService({
    repo: createInMemoryEntitlementRepository(orgStore),
  });
  const mailer = createCapturingInvitationMailer();

  const invitationService = createInvitationService({
    accessControl: orgRepo,
    invitations: createInMemoryInvitationRepository(orgStore),
    entitlements: entitlementService,
    mailer,
    ttlSeconds: options.ttlSeconds ?? config.invitations.ttlSeconds,
    webBaseUrl: config.web.url,
  });

  const authService = createAuthService({
    repo: authRepo,
    jwtSecret: config.auth.jwtSecret,
    accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
    sessionTtlSeconds: config.auth.sessionTtlSeconds,
    refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
    invitations: invitationService,
  });
  const organizationService = createOrganizationService({ repo: orgRepo });
  const memberService = createMemberService({ repo: orgRepo });

  const app = buildApp({
    config,
    readinessProbes: [passingProbe('postgres'), passingProbe('redis')],
    authService,
    organizationService,
    memberService,
    invitationService,
    logger: false,
  });
  await app.ready();
  return { app, authRepo, orgStore, mailer, config };
}
