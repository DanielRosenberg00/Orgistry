import type { Config } from '@orgistry/config';
import type { EmailVerificationTokenRow } from '@orgistry/db';
import type { Clock } from '@orgistry/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../app';
import type { RateLimiter } from '../../../lib/rate-limit';
import { passingProbe, testConfig } from '../../../testing/build-test-app';
import {
  createInMemoryAccountMailer,
  type InMemoryAccountMailer,
} from '../../mail/testing/in-memory-account-mailer';
import { type AuthRateLimits, createAuthService } from '../auth.service';
import {
  createEmailVerificationService,
  type EmailVerificationRateLimits,
} from '../email-verification.service';
import {
  createPasswordRecoveryService,
  type PasswordRecoveryRateLimits,
} from '../password-recovery.service';
import {
  createRegistrationService,
  type RegistrationRateLimits,
} from '../registration.service';
import type { RegistrationInvitations } from '../registration.types';
import {
  createInMemoryAuthRepository,
  type InMemoryAuthRepository,
} from './in-memory-auth-repo';
import {
  createInMemoryRegistrationRepository,
  type InMemoryRegistrationRepository,
} from './in-memory-registration-repo';
import {
  createInMemoryEmailVerificationRepository,
  type InMemoryEmailVerificationRepository,
} from './in-memory-email-verification-repo';
import {
  createInMemoryPasswordRecoveryRepository,
  type InMemoryPasswordRecoveryRepository,
} from './in-memory-password-recovery-repo';

/**
 * Build a fully wired auth app over the in-memory repositories for route-level
 * tests. Centralizes the boilerplate (config, repos, services, probes) so each
 * suite only declares the behavior it needs (rate limiter, limits, clock).
 *
 * The email-verification and password-recovery services are always wired
 * (mirroring server.ts): the in-memory account mailer captures delivery so
 * suites can assert on sent messages and recover raw tokens from the emailed
 * links — the API itself never returns them. All repositories share the auth
 * repo's user/session/refresh-token tables (and one verification-token table),
 * so every flow observes the same accounts, exactly like the database.
 */
export interface AuthTestContext {
  app: FastifyInstance;
  repo: InMemoryAuthRepository;
  registrationRepo: InMemoryRegistrationRepository;
  verificationRepo: InMemoryEmailVerificationRepository;
  passwordRecoveryRepo: InMemoryPasswordRecoveryRepository;
  mailer: InMemoryAccountMailer;
  config: Config;
}

export interface BuildAuthTestAppOptions {
  rateLimiter?: RateLimiter;
  rateLimits?: AuthRateLimits;
  registrationRateLimits?: RegistrationRateLimits;
  emailVerificationRateLimits?: EmailVerificationRateLimits;
  passwordRecoveryRateLimits?: PasswordRecoveryRateLimits;
  /** Verification token TTL in seconds. Defaults to the config default (24h). */
  emailVerificationTtlSeconds?: number;
  /** Reset token TTL in seconds. Defaults to the config default (1h). */
  passwordResetTtlSeconds?: number;
  /** Completion token TTL in seconds. Defaults to the config default (24h). */
  registrationCompletionTtlSeconds?: number;
  /** Invitation collaborator for registration-with-invitation suites. */
  registrationInvitations?: RegistrationInvitations;
  clock?: Clock;
}

export async function buildAuthTestApp(
  options: BuildAuthTestAppOptions = {},
): Promise<AuthTestContext> {
  const config = testConfig();
  // One shared verification-token table: the auth repo's changeEmail
  // invalidation and the verification repo's lifecycle act on the same rows.
  const emailVerificationTokens: EmailVerificationTokenRow[] = [];
  const repo = createInMemoryAuthRepository({ emailVerificationTokens });
  const mailer = createInMemoryAccountMailer();
  const verificationRepo = createInMemoryEmailVerificationRepository({
    users: repo.users,
    securityEvents: repo.securityEvents,
    tokens: emailVerificationTokens,
  });
  const passwordRecoveryRepo = createInMemoryPasswordRecoveryRepository({
    users: repo.users,
    sessions: repo.sessions,
    refreshTokens: repo.refreshTokens,
    securityEvents: repo.securityEvents,
  });
  const emailVerificationService = createEmailVerificationService({
    repo: verificationRepo,
    mailer,
    webBaseUrl: config.web.url,
    ttlSeconds:
      options.emailVerificationTtlSeconds ?? config.emailVerification.ttlSeconds,
    rateLimiter: options.rateLimiter,
    rateLimits: options.emailVerificationRateLimits,
    clock: options.clock,
  });
  const passwordRecoveryService = createPasswordRecoveryService({
    repo: passwordRecoveryRepo,
    mailer,
    webBaseUrl: config.web.url,
    ttlSeconds:
      options.passwordResetTtlSeconds ?? config.passwordRecovery.ttlSeconds,
    rateLimiter: options.rateLimiter,
    rateLimits: options.passwordRecoveryRateLimits,
    clock: options.clock,
  });
  const registrationRepo = createInMemoryRegistrationRepository({
    orgStore: repo.orgStore,
    sessions: repo.sessions,
    refreshTokens: repo.refreshTokens,
    securityEvents: repo.securityEvents,
  });
  const registrationService = createRegistrationService({
    repo: registrationRepo,
    mailer,
    webBaseUrl: config.web.url,
    completionTtlSeconds:
      options.registrationCompletionTtlSeconds ??
      config.registration.completionTtlSeconds,
    jwtSecret: config.auth.jwtSecret,
    accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
    sessionTtlSeconds: config.auth.sessionTtlSeconds,
    refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
    rateLimiter: options.rateLimiter,
    rateLimits: options.registrationRateLimits,
    invitations: options.registrationInvitations,
    clock: options.clock,
  });
  const service = createAuthService({
    repo,
    jwtSecret: config.auth.jwtSecret,
    accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
    sessionTtlSeconds: config.auth.sessionTtlSeconds,
    refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
    rateLimiter: options.rateLimiter,
    rateLimits: options.rateLimits,
    emailVerification: emailVerificationService,
    clock: options.clock,
  });
  const app = buildApp({
    config,
    readinessProbes: [passingProbe('postgres'), passingProbe('redis')],
    authService: service,
    emailVerificationService,
    passwordRecoveryService,
    registrationService,
    logger: false,
  });
  await app.ready();
  return {
    app,
    repo,
    registrationRepo,
    verificationRepo,
    passwordRecoveryRepo,
    mailer,
    config,
  };
}
