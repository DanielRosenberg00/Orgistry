import type { Config } from '@orgistry/config';
import type { Clock } from '@orgistry/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../app';
import type { RateLimiter } from '../../../lib/rate-limit';
import { passingProbe, testConfig } from '../../../testing/build-test-app';
import { type AuthRateLimits, createAuthService } from '../auth.service';
import {
  createInMemoryAuthRepository,
  type InMemoryAuthRepository,
} from './in-memory-auth-repo';

/**
 * Build a fully wired auth app over the in-memory repository for route-level
 * tests. Centralizes the boilerplate (config, repo, service, probes) so each
 * session-lifecycle suite only declares the behavior it needs (rate limiter,
 * limits, clock).
 */
export interface AuthTestContext {
  app: FastifyInstance;
  repo: InMemoryAuthRepository;
  config: Config;
}

export interface BuildAuthTestAppOptions {
  rateLimiter?: RateLimiter;
  rateLimits?: AuthRateLimits;
  clock?: Clock;
}

export async function buildAuthTestApp(
  options: BuildAuthTestAppOptions = {},
): Promise<AuthTestContext> {
  const config = testConfig();
  const repo = createInMemoryAuthRepository();
  const service = createAuthService({
    repo,
    jwtSecret: config.auth.jwtSecret,
    accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
    sessionTtlSeconds: config.auth.sessionTtlSeconds,
    refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
    rateLimiter: options.rateLimiter,
    rateLimits: options.rateLimits,
    clock: options.clock,
  });
  const app = buildApp({
    config,
    readinessProbes: [passingProbe('postgres'), passingProbe('redis')],
    authService: service,
    logger: false,
  });
  await app.ready();
  return { app, repo, config };
}
