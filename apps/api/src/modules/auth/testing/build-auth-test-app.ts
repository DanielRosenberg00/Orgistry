import type { Config } from '@orgistry/config';
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
  createInMemoryAuthRepository,
  type InMemoryAuthRepository,
} from './in-memory-auth-repo';
import {
  createInMemoryEmailVerificationRepository,
  type InMemoryEmailVerificationRepository,
} from './in-memory-email-verification-repo';

/**
 * Build a fully wired auth app over the in-memory repositories for route-level
 * tests. Centralizes the boilerplate (config, repos, services, probes) so each
 * suite only declares the behavior it needs (rate limiter, limits, clock).
 *
 * The email-verification service is always wired (mirroring server.ts): the
 * in-memory account mailer captures delivery so suites can assert on sent
 * messages and recover raw tokens from the emailed link — the API itself never
 * returns them. The verification repo shares the auth repo's user table, so
 * registration and verification observe the same accounts.
 */
export interface AuthTestContext {
  app: FastifyInstance;
  repo: InMemoryAuthRepository;
  verificationRepo: InMemoryEmailVerificationRepository;
  mailer: InMemoryAccountMailer;
  config: Config;
}

export interface BuildAuthTestAppOptions {
  rateLimiter?: RateLimiter;
  rateLimits?: AuthRateLimits;
  emailVerificationRateLimits?: EmailVerificationRateLimits;
  /** Verification token TTL in seconds. Defaults to the config default (24h). */
  emailVerificationTtlSeconds?: number;
  clock?: Clock;
}

export async function buildAuthTestApp(
  options: BuildAuthTestAppOptions = {},
): Promise<AuthTestContext> {
  const config = testConfig();
  const repo = createInMemoryAuthRepository();
  const mailer = createInMemoryAccountMailer();
  const verificationRepo = createInMemoryEmailVerificationRepository({
    users: repo.users,
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
    logger: false,
  });
  await app.ready();
  return { app, repo, verificationRepo, mailer, config };
}
