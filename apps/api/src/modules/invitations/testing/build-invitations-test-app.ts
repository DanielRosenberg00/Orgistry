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
import {
  createInvitationService,
  type InvitationRateLimits,
} from '../invitation.service';
import type {
  RateLimiter,
  RateLimitFailureMode,
} from '../../../lib/rate-limit';
import { createInMemoryInvitationRepository } from './in-memory-invitation-repo';
import {
  createInMemoryAccountMailer,
  type InMemoryAccountMailer,
} from '../../mail/testing/in-memory-account-mailer';
import { createRegistrationTestKit } from '../../auth/testing/registration-test-kit';
import type { InMemoryRegistrationRepository } from '../../auth/testing/in-memory-registration-repo';

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
  registrationRepo: InMemoryRegistrationRepository;
  orgStore: InMemoryOrgStore;
  mailer: InMemoryAccountMailer;
  config: Config;
}

export interface BuildInvitationsAppOptions {
  /** Token TTL in seconds. Defaults to the config default (7 days). */
  ttlSeconds?: number;
  /** Limiter for the invitation abuse-control buckets (Sprint 19). */
  rateLimiter?: RateLimiter;
  /** Deterministic bucket thresholds for throttle tests. */
  rateLimits?: InvitationRateLimits;
  /** Store-outage behavior under test ('open' default, like unit tests). */
  rateLimitFailureMode?: RateLimitFailureMode;
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
  const mailer = createInMemoryAccountMailer();

  const invitationService = createInvitationService({
    accessControl: orgRepo,
    invitations: createInMemoryInvitationRepository(orgStore),
    entitlements: entitlementService,
    mailer,
    ttlSeconds: options.ttlSeconds ?? config.invitations.ttlSeconds,
    webBaseUrl: config.web.url,
    rateLimiter: options.rateLimiter,
    rateLimits: options.rateLimits,
    rateLimitFailureMode: options.rateLimitFailureMode,
  });

  const authService = createAuthService({
    repo: authRepo,
    jwtSecret: config.auth.jwtSecret,
    accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
    sessionTtlSeconds: config.auth.sessionTtlSeconds,
    refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
  });
  // The SAME invitation service instance backs the invitation routes AND the
  // registration flow's invitation collaborator, mirroring server.ts.
  const { registrationService, registrationRepo } = createRegistrationTestKit({
    config,
    authRepo,
    mailer,
    invitations: invitationService,
  });
  const organizationService = createOrganizationService({ repo: orgRepo });
  const memberService = createMemberService({ repo: orgRepo });

  const app = buildApp({
    config,
    readinessProbes: [passingProbe('postgres'), passingProbe('redis')],
    authService,
    registrationService,
    organizationService,
    memberService,
    invitationService,
    logger: false,
  });
  await app.ready();
  return { app, authRepo, registrationRepo, orgStore, mailer, config };
}
